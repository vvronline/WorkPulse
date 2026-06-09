import { useState } from "react";
import {
    getTaskComments,
    addTaskComment,
    updateTaskComment,
    deleteTaskComment,
} from "../../../api";
import { stripHtml } from "../utils";
import type { Comment, Task } from "../../../types";

type ShowConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
    opts?: { confirmText?: string; isDanger?: boolean },
) => void;

interface UseCommentsParams {
    showConfirm: ShowConfirm;
    closeConfirm: () => void;
    setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
    setError: (msg: string) => void;
}

export function useComments({
    showConfirm,
    closeConfirm,
    setTasks,
    setError,
}: UseCommentsParams) {
    const [commentTaskId, setCommentTaskId] = useState<number | string | null>(
        null,
    );
    const [comments, setComments] = useState<Comment[]>([]);
    const [commentText, setCommentText] = useState("");
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [editingCommentId, setEditingCommentId] = useState<
        number | string | null
    >(null);
    const [editCommentText, setEditCommentText] = useState("");

    const openComments = async (taskId: number | string) => {
        setCommentTaskId(taskId);
        setCommentsLoading(true);
        try {
            const res = await getTaskComments(taskId);
            setComments(res.data as Comment[]);
        } catch {
            setComments([]);
        } finally {
            setCommentsLoading(false);
        }
    };

    const closeComments = () => {
        setCommentTaskId(null);
        setComments([]);
        setCommentText("");
        setEditingCommentId(null);
    };

    const handleAddComment = async (file: File | null = null) => {
        if (!commentTaskId) return;
        // Require either text or a file attachment.
        if (!stripHtml(commentText).trim() && !file) return;
        try {
            const res = await addTaskComment(
                commentTaskId,
                commentText,
                file || undefined,
            );
            setComments((prev) => [...prev, res.data as Comment]);
            setCommentText("");
            setTasks((prev) =>
                prev.map((t) =>
                    t.id === commentTaskId
                        ? {
                              ...t,
                              comment_count:
                                  ((t.comment_count as number) || 0) + 1,
                          }
                        : t,
                ),
            );
        } catch {
            setError("Failed to add comment");
        }
    };

    const handleEditComment = async (commentId: number | string) => {
        if (!stripHtml(editCommentText).trim()) return;
        try {
            const res = await updateTaskComment(
                commentTaskId as number | string,
                commentId,
                editCommentText,
            );
            setComments((prev) =>
                prev.map((c) => (c.id === commentId ? (res.data as Comment) : c)),
            );
            setEditingCommentId(null);
            setEditCommentText("");
        } catch {
            setError("Failed to update comment");
        }
    };

    const handleDeleteComment = (commentId: number | string) => {
        showConfirm(
            "Delete Comment",
            "Are you sure you want to delete this comment? This cannot be undone.",
            async () => {
                closeConfirm();
                try {
                    await deleteTaskComment(
                        commentTaskId as number | string,
                        commentId,
                    );
                    setComments((prev) =>
                        prev.filter((c) => c.id !== commentId),
                    );
                    setTasks((prev) =>
                        prev.map((t) =>
                            t.id === commentTaskId
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
                } catch {
                    setError("Failed to delete comment");
                }
            },
            { confirmText: "Delete", isDanger: true },
        );
    };

    return {
        commentTaskId,
        setCommentTaskId,
        comments,
        setComments,
        commentText,
        setCommentText,
        commentsLoading,
        editingCommentId,
        setEditingCommentId,
        editCommentText,
        setEditCommentText,
        openComments,
        closeComments,
        handleAddComment,
        handleEditComment,
        handleDeleteComment,
    };
}