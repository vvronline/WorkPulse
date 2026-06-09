import { useState, useCallback } from "react";
import {
    getTaskDetail,
    getTaskHistory,
    getTaskComments,
    deleteTaskComment,
    updateTask,
    updateTaskStatus,
    addTaskComment,
    updateTaskComment,
} from "../../../api";
import type { Comment, Task } from "../../../types";

type ShowConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
    opts?: { confirmText?: string; isDanger?: boolean },
) => void;

interface DetailEditData {
    title?: string;
    description?: string;
    priority?: string;
    assignedTo?: number | string | null;
    dueDate?: string | null;
    sprintId?: number | string | null;
    labels?: (number | string)[];
    storyPoints?: number | null;
    workItemType?: number | string | null;
    projectId?: number | string | null;
}

interface StatusColumn {
    id: number | string;
    label: string;
    [key: string]: unknown;
}

interface UseTaskDetailParams {
    activeTab: string;
    showConfirm: ShowConfirm;
    closeConfirm: () => void;
    setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
    setBacklogTasks: React.Dispatch<React.SetStateAction<Task[]>>;
    fetchTasks: () => void;
    fetchBacklog: () => void;
    setError: (msg: string) => void;
}

/**
 * Manages task detail panel state.
 * Edit state (title, desc, priority, etc.) has been moved into TaskDetailModal itself
 * so it is co-located with the form that owns it.
 * `saveDetailEdit` now receives the current edit values as an argument.
 */
export function useTaskDetail({
    activeTab,
    showConfirm,
    closeConfirm,
    setTasks,
    setBacklogTasks,
    fetchTasks,
    fetchBacklog,
    setError,
}: UseTaskDetailParams) {
    const [detailTask, setDetailTask] = useState<Task | null>(null);
    const [detailComments, setDetailComments] = useState<Comment[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailEditing, setDetailEditing] = useState(false);
    const [detailTab, setDetailTab] = useState("comments");
    const [detailHistory, setDetailHistory] = useState<unknown[]>([]);

    const refreshDetailHistory = async (taskId: number | string) => {
        try {
            const hRes = await getTaskHistory(taskId);
            setDetailHistory((hRes.data as unknown[]) || []);
        } catch {
            /* ignore */
        }
    };

    const openTaskDetail = async (task: Task) => {
        setDetailTask(task);
        setDetailLoading(true);
        setDetailComments([]);
        setDetailTab("comments");
        setDetailHistory([]);
        try {
            const res = await getTaskDetail(task.id);
            const data = res.data as Task & { comments?: Comment[] };
            setDetailTask(data);
            setDetailComments(data.comments || []);
        } catch {
            try {
                const cRes = await getTaskComments(task.id);
                setDetailComments(cRes.data as Comment[]);
            } catch {
                /* ignore */
            }
        } finally {
            setDetailLoading(false);
        }
        try {
            const hRes = await getTaskHistory(task.id);
            setDetailHistory((hRes.data as unknown[]) || []);
        } catch {
            /* ignore */
        }
    };

    const closeTaskDetail = () => {
        setDetailTask(null);
        setDetailComments([]);
        setDetailEditing(false);
        setDetailHistory([]);
        setDetailTab("comments");
    };

    // Edit state now lives in TaskDetailModal; this just flips the mode flag.
    const startDetailEdit = () => setDetailEditing(true);

    // Receives current edit values from TaskDetailModal to avoid state duplication.
    const saveDetailEdit = (editData: DetailEditData) => {
        if (!detailTask) return;
        showConfirm(
            "Save Changes",
            `Save changes to "${editData.title || detailTask.title}"?`,
            async () => {
                closeConfirm();
                try {
                    await updateTask(detailTask.id, {
                        title: editData.title,
                        description: editData.description,
                        priority: editData.priority,
                        assigned_to: editData.assignedTo || null,
                        due_date: editData.dueDate || null,
                        sprint_id: editData.sprintId || null,
                        label_ids: editData.labels,
                        story_points: editData.storyPoints,
                        work_item_type_id: editData.workItemType || null,
                        // project_id is only honoured by the server when the task has
                        // no project yet — once assigned, the issue key is immutable.
                        // Send it unconditionally and let the server enforce that rule.
                        project_id: editData.projectId || null,
                    });
                    setDetailEditing(false);
                    const res = await getTaskDetail(detailTask.id);
                    const data = res.data as Task & { comments?: Comment[] };
                    setDetailTask(data);
                    setDetailComments(data.comments || []);
                    refreshDetailHistory(detailTask.id);
                    fetchTasks();
                    if (activeTab === "backlog") fetchBacklog();
                } catch {
                    setError("Failed to update item");
                }
            },
            { confirmText: "Save" },
        );
    };

    const handleAddDetailComment = useCallback(
        async (content: string, file: File | null = null) => {
            if (!detailTask) return;
            try {
                const res = await addTaskComment(
                    detailTask.id,
                    content,
                    file || undefined,
                );
                setDetailComments((prev) => [...prev, res.data as Comment]);
                setTasks((prev) =>
                    prev.map((t) =>
                        t.id === detailTask.id
                            ? {
                                  ...t,
                                  comment_count:
                                      ((t.comment_count as number) || 0) + 1,
                              }
                            : t,
                    ),
                );
                setBacklogTasks((prev) =>
                    prev.map((t) =>
                        t.id === detailTask.id
                            ? {
                                  ...t,
                                  comment_count:
                                      ((t.comment_count as number) || 0) + 1,
                              }
                            : t,
                    ),
                );
                refreshDetailHistory(detailTask.id);
            } catch {
                setError("Failed to add comment");
            }
        },
        [detailTask, setTasks, setBacklogTasks, setError],
    );

    const handleEditDetailComment = useCallback(
        async (commentId: number | string, content: string) => {
            if (!detailTask) return;
            try {
                const res = await updateTaskComment(
                    detailTask.id,
                    commentId,
                    content,
                );
                setDetailComments((prev) =>
                    prev.map((c) =>
                        c.id === commentId ? (res.data as Comment) : c,
                    ),
                );
                refreshDetailHistory(detailTask.id);
            } catch {
                setError("Failed to update comment");
            }
        },
        [detailTask, setError],
    );

    const handleDetailDeleteComment = (commentId: number | string) => {
        showConfirm(
            "Delete Comment",
            "Are you sure you want to delete this comment? This cannot be undone.",
            async () => {
                closeConfirm();
                try {
                    await deleteTaskComment(
                        (detailTask as Task).id,
                        commentId,
                    );
                    setDetailComments((prev) =>
                        prev.filter((c) => c.id !== commentId),
                    );
                    setTasks((prev) =>
                        prev.map((t) =>
                            t.id === (detailTask as Task).id
                                ? {
                                      ...t,
                                      comment_count: Math.max(
                                          0,
                                          ((t.comment_count as number) || 1) - 1,
                                      ),
                                  }
                                : t,
                        ),
                    );
                    setBacklogTasks((prev) =>
                        prev.map((t) =>
                            t.id === (detailTask as Task).id
                                ? {
                                      ...t,
                                      comment_count: Math.max(
                                          0,
                                          ((t.comment_count as number) || 1) - 1,
                                      ),
                                  }
                                : t,
                        ),
                    );
                    refreshDetailHistory((detailTask as Task).id);
                } catch {
                    setError("Failed to delete comment");
                }
            },
            { confirmText: "Delete", isDanger: true },
        );
    };

    const handleDetailStatusChange = (task: Task, col: StatusColumn) => {
        showConfirm(
            "Change Status",
            `Change status of "${task.title}" to ${col.label}?`,
            async () => {
                closeConfirm();
                try {
                    await updateTaskStatus(task.id, String(col.id));
                    setDetailTask((prev) =>
                        prev ? { ...prev, status: String(col.id) } : prev,
                    );
                    refreshDetailHistory(task.id);
                    fetchTasks();
                    if (activeTab === "backlog") fetchBacklog();
                } catch {
                    setError("Failed to update status");
                }
            },
            { confirmText: "Move" },
        );
    };

    return {
        detailTask,
        setDetailTask,
        detailComments,
        setDetailComments,
        detailLoading,
        detailEditing,
        setDetailEditing,
        detailTab,
        setDetailTab,
        detailHistory,
        openTaskDetail,
        closeTaskDetail,
        startDetailEdit,
        saveDetailEdit,
        handleAddDetailComment,
        handleEditDetailComment,
        handleDetailDeleteComment,
        handleDetailStatusChange,
    };
}