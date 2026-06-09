import { useState, useCallback, useMemo, useEffect } from "react";
import {
    getBacklog,
    addBacklogTask,
    scheduleTask,
    unscheduleTask,
    assignTaskToSprint,
    updateTask,
    getLocalToday,
} from "../../../api";
import type { Task } from "../../../types";

interface BacklogSummary {
    total: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
}

type ShowConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
    opts?: { confirmText?: string; isDanger?: boolean },
) => void;

interface UseBacklogParams {
    activeTab: string;
    backlogOpen: boolean;
    date: string;
    backlogFilters: Record<string, unknown> | null;
    selectedSprintId: number | string | null;
    showConfirm: ShowConfirm;
    closeConfirm: () => void;
    fetchTasks: () => void;
    setError: (msg: string) => void;
}

export function useBacklog({
    activeTab,
    backlogOpen,
    date,
    backlogFilters,
    selectedSprintId,
    showConfirm,
    closeConfirm,
    fetchTasks,
    setError,
}: UseBacklogParams) {
    const [backlogTasks, setBacklogTasks] = useState<Task[]>([]);
    const [backlogLoading, setBacklogLoading] = useState(false);
    const [backlogFormOpen, setBacklogFormOpen] = useState(false);
    const [backlogTitle, setBacklogTitle] = useState("");
    const [backlogDesc, setBacklogDesc] = useState("");
    const [backlogPriority, setBacklogPriority] = useState("medium");
    const [backlogAssignedTo, setBacklogAssignedTo] = useState("");
    const [backlogDueDate, setBacklogDueDate] = useState("");
    const [backlogLabels, setBacklogLabels] = useState<(number | string)[]>([]);
    const [backlogLabelDropdownOpen, setBacklogLabelDropdownOpen] =
        useState(false);
    const [backlogSprintId, setBacklogSprintId] = useState("");
    const [backlogStoryPoints, setBacklogStoryPoints] = useState<number | null>(
        null,
    );
    const [backlogWorkItemType, setBacklogWorkItemType] = useState("");
    const [backlogProjectId, setBacklogProjectId] = useState("");
    const [scheduleTaskId, setScheduleTaskId] = useState<number | string | null>(
        null,
    );
    const [scheduleDate, setScheduleDate] = useState<string>(() => getLocalToday());
    const [backlogSummary, setBacklogSummary] = useState<BacklogSummary>({
        total: 0,
        byStatus: {},
        byPriority: {},
    });
    const [backlogSort, setBacklogSort] = useState("priority");
    const [importConfigTask, setImportConfigTask] = useState<Task | null>(null);
    const [importAssignedTo, setImportAssignedTo] = useState("");
    const [importDueDate, setImportDueDate] = useState("");
    // Pagination state. Server caps page size and returns
    // { tasks, summary, pagination: { limit, offset, total, hasMore } } so we
    // can drive page controls without a second round-trip for the total.
    const [backlogLimit, setBacklogLimit] = useState(25);
    const [backlogOffset, setBacklogOffset] = useState(0);
    const [backlogTotal, setBacklogTotal] = useState(0);

    // Resetting offset on filter/page-size change avoids landing on an empty
    // page when the filtered result set shrinks below the current offset.
    useEffect(() => {
        setBacklogOffset(0);
    }, [backlogFilters, backlogLimit]);

    const fetchBacklog = useCallback(async () => {
        setBacklogLoading(true);
        try {
            const res = await getBacklog({
                ...(backlogFilters || {}),
                limit: backlogLimit,
                offset: backlogOffset,
            });
            const data = res.data as {
                tasks: Task[];
                summary?: BacklogSummary;
                pagination?: { total?: number };
            };
            setBacklogTasks(data.tasks);
            if (data.summary) setBacklogSummary(data.summary);
            // `pagination.total` is the authoritative count for the current
            // filter set; fall back to summary.total / list length for older
            // server builds that don't return pagination.
            if (data.pagination?.total != null) {
                setBacklogTotal(data.pagination.total);
            } else if (data.summary?.total != null) {
                setBacklogTotal(data.summary.total);
            } else {
                setBacklogTotal(data.tasks?.length || 0);
            }
        } catch {
            setError("Failed to load backlog");
        } finally {
            setBacklogLoading(false);
        }
    }, [backlogFilters, backlogLimit, backlogOffset]);

    const sortedBacklogTasks = useMemo(() => {
        const sorted = [...backlogTasks];
        switch (backlogSort) {
            case "priority":
                sorted.sort((a, b) => {
                    const order: Record<string, number> = {
                        high: 0,
                        medium: 1,
                        low: 2,
                    };
                    return (
                        (order[a.priority as string] ?? 1) -
                        (order[b.priority as string] ?? 1)
                    );
                });
                break;
            case "newest":
                sorted.sort(
                    (a, b) =>
                        new Date(b.created_at as string).getTime() -
                        new Date(a.created_at as string).getTime(),
                );
                break;
            case "oldest":
                sorted.sort(
                    (a, b) =>
                        new Date(a.created_at as string).getTime() -
                        new Date(b.created_at as string).getTime(),
                );
                break;
            case "due_date":
                sorted.sort((a, b) => {
                    if (!a.due_date && !b.due_date) return 0;
                    if (!a.due_date) return 1;
                    if (!b.due_date) return -1;
                    return (a.due_date as string).localeCompare(
                        b.due_date as string,
                    );
                });
                break;
            case "title":
                sorted.sort((a, b) =>
                    (a.title || "").localeCompare(b.title || ""),
                );
                break;
            default:
                break;
        }
        return sorted;
    }, [backlogTasks, backlogSort]);

    const handleAddBacklog = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!backlogTitle.trim()) return;
        try {
            await addBacklogTask({
                title: backlogTitle,
                description: backlogDesc,
                priority: backlogPriority,
                assigned_to: backlogAssignedTo || null,
                due_date: backlogDueDate || null,
                label_ids: backlogLabels.length > 0 ? backlogLabels : undefined,
                sprint_id: backlogSprintId || null,
                story_points: backlogStoryPoints,
                work_item_type_id: backlogWorkItemType || null,
                project_id: backlogProjectId || null,
            });
            setBacklogTitle("");
            setBacklogDesc("");
            setBacklogPriority("medium");
            setBacklogAssignedTo("");
            setBacklogDueDate("");
            setBacklogLabels([]);
            setBacklogSprintId("");
            setBacklogStoryPoints(null);
            setBacklogWorkItemType("");
            setBacklogProjectId("");
            setBacklogFormOpen(false);
            fetchBacklog();
            if (backlogSprintId && activeTab === "sprint") fetchTasks();
        } catch (err) {
            const error = err as {
                response?: { data?: { error?: string } };
            };
            setError(
                error.response?.data?.error || "Failed to create backlog item",
            );
        }
    };

    const handleScheduleTask = (
        taskId: number | string,
        taskTitle: string | undefined,
        closeAfter?: () => void,
        overrideDate?: string,
    ) => {
        const dateToUse = overrideDate || scheduleDate;
        if (!dateToUse) return;
        showConfirm(
            "Schedule Task",
            `Schedule "${taskTitle || "this task"}" to ${dateToUse}?`,
            async () => {
                closeConfirm();
                try {
                    await scheduleTask(taskId, dateToUse);
                    setScheduleTaskId(null);
                    fetchBacklog();
                    if (dateToUse === date) fetchTasks();
                    if (closeAfter) closeAfter();
                } catch {
                    setError("Failed to schedule task");
                }
            },
            { confirmText: "Schedule" },
        );
    };

    const handleUnscheduleTask = (
        taskId: number | string,
        taskTitle: string | undefined,
        closeAfter?: () => void,
    ) => {
        showConfirm(
            "Move to Backlog",
            `Move "${taskTitle || "this task"}" to backlog? It will be removed from the planner.`,
            async () => {
                closeConfirm();
                try {
                    await unscheduleTask(taskId);
                    fetchTasks();
                    if (backlogOpen || activeTab === "backlog") fetchBacklog();
                    if (closeAfter) closeAfter();
                } catch {
                    setError("Failed to move task to backlog");
                }
            },
            { confirmText: "Move to Backlog" },
        );
    };

    const handleImportToSprint = async () => {
        if (!importConfigTask || !selectedSprintId) return;
        const importedId = importConfigTask.id;
        try {
            await assignTaskToSprint(importedId, selectedSprintId);
            if (importAssignedTo || importDueDate) {
                await updateTask(importedId, {
                    assigned_to: importAssignedTo || null,
                    due_date: importDueDate || null,
                });
            }
            setBacklogTasks((prev) => prev.filter((t) => t.id !== importedId));
            setImportConfigTask(null);
            setImportAssignedTo("");
            setImportDueDate("");
            fetchTasks();
            fetchBacklog();
        } catch {
            setError("Failed to import task to sprint");
        }
    };

    return {
        backlogTasks,
        setBacklogTasks,
        backlogLoading,
        backlogFormOpen,
        setBacklogFormOpen,
        backlogTitle,
        setBacklogTitle,
        backlogDesc,
        setBacklogDesc,
        backlogPriority,
        setBacklogPriority,
        backlogAssignedTo,
        setBacklogAssignedTo,
        backlogDueDate,
        setBacklogDueDate,
        backlogLabels,
        setBacklogLabels,
        backlogLabelDropdownOpen,
        setBacklogLabelDropdownOpen,
        backlogSprintId,
        setBacklogSprintId,
        backlogStoryPoints,
        setBacklogStoryPoints,
        backlogWorkItemType,
        setBacklogWorkItemType,
        backlogProjectId,
        setBacklogProjectId,
        backlogLimit,
        setBacklogLimit,
        backlogOffset,
        setBacklogOffset,
        backlogTotal,
        scheduleTaskId,
        setScheduleTaskId,
        scheduleDate,
        setScheduleDate,
        backlogSummary,
        backlogSort,
        setBacklogSort,
        importConfigTask,
        setImportConfigTask,
        importAssignedTo,
        setImportAssignedTo,
        importDueDate,
        setImportDueDate,
        fetchBacklog,
        sortedBacklogTasks,
        handleAddBacklog,
        handleScheduleTask,
        handleUnscheduleTask,
        handleImportToSprint,
    };
}