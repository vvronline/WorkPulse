import { useState } from 'react';
import { getTaskComments, addTaskComment, updateTaskComment, deleteTaskComment } from '../../../api';
import { stripHtml } from '../utils.jsx';

export function useComments({ showConfirm, closeConfirm, setTasks, setError }) {
  const [commentTaskId, setCommentTaskId] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editCommentText, setEditCommentText] = useState('');

  const openComments = async (taskId) => {
    setCommentTaskId(taskId);
    setCommentsLoading(true);
    try {
      const res = await getTaskComments(taskId);
      setComments(res.data);
    } catch {
      setComments([]);
    } finally {
      setCommentsLoading(false);
    }
  };

  const closeComments = () => {
    setCommentTaskId(null);
    setComments([]);
    setCommentText('');
    setEditingCommentId(null);
  };

  const handleAddComment = async () => {
    if (!stripHtml(commentText).trim() || !commentTaskId) return;
    try {
      const res = await addTaskComment(commentTaskId, commentText);
      setComments((prev) => [...prev, res.data]);
      setCommentText('');
      setTasks((prev) =>
        prev.map((t) =>
          t.id === commentTaskId ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t
        )
      );
    } catch {
      setError('Failed to add comment');
    }
  };

  const handleEditComment = async (commentId) => {
    if (!stripHtml(editCommentText).trim()) return;
    try {
      const res = await updateTaskComment(commentTaskId, commentId, editCommentText);
      setComments((prev) => prev.map((c) => (c.id === commentId ? res.data : c)));
      setEditingCommentId(null);
      setEditCommentText('');
    } catch {
      setError('Failed to update comment');
    }
  };

  const handleDeleteComment = (commentId) => {
    showConfirm(
      'Delete Comment',
      'Are you sure you want to delete this comment? This cannot be undone.',
      async () => {
        closeConfirm();
        try {
          await deleteTaskComment(commentTaskId, commentId);
          setComments((prev) => prev.filter((c) => c.id !== commentId));
          setTasks((prev) =>
            prev.map((t) =>
              t.id === commentTaskId
                ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) }
                : t
            )
          );
        } catch {
          setError('Failed to delete comment');
        }
      },
      { confirmText: 'Delete', isDanger: true }
    );
  };

  return {
    commentTaskId, setCommentTaskId,
    comments, setComments,
    commentText, setCommentText,
    commentsLoading,
    editingCommentId, setEditingCommentId,
    editCommentText, setEditCommentText,
    openComments, closeComments,
    handleAddComment, handleEditComment, handleDeleteComment,
  };
}
