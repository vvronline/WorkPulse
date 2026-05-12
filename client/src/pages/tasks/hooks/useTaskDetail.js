import { useState, useCallback } from 'react';
import {
  getTaskDetail, getTaskHistory, getTaskComments,
  deleteTaskComment, updateTask, updateTaskStatus,
  addTaskComment, updateTaskComment,
} from '../../../api';

/**
 * Manages task detail panel state.
 * Edit state (title, desc, priority, etc.) has been moved into TaskDetailModal itself
 * so it is co-located with the form that owns it.
 * `saveDetailEdit` now receives the current edit values as an argument.
 */
export function useTaskDetail({ activeTab, showConfirm, closeConfirm, setTasks, setBacklogTasks, fetchTasks, fetchBacklog, setError }) {
  const [detailTask, setDetailTask] = useState(null);
  const [detailComments, setDetailComments] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailTab, setDetailTab] = useState('comments');
  const [detailHistory, setDetailHistory] = useState([]);

  const refreshDetailHistory = async (taskId) => {
    try {
      const hRes = await getTaskHistory(taskId);
      setDetailHistory(hRes.data || []);
    } catch { /* ignore */ }
  };

  const openTaskDetail = async (task) => {
    setDetailTask(task);
    setDetailLoading(true);
    setDetailComments([]);
    setDetailTab('comments');
    setDetailHistory([]);
    try {
      const res = await getTaskDetail(task.id);
      setDetailTask(res.data);
      setDetailComments(res.data.comments || []);
    } catch {
      try {
        const cRes = await getTaskComments(task.id);
        setDetailComments(cRes.data);
      } catch { /* ignore */ }
    } finally {
      setDetailLoading(false);
    }
    try {
      const hRes = await getTaskHistory(task.id);
      setDetailHistory(hRes.data || []);
    } catch { /* ignore */ }
  };

  const closeTaskDetail = () => {
    setDetailTask(null);
    setDetailComments([]);
    setDetailEditing(false);
    setDetailHistory([]);
    setDetailTab('comments');
  };

  // Edit state now lives in TaskDetailModal; this just flips the mode flag.
  const startDetailEdit = () => setDetailEditing(true);

  // Receives current edit values from TaskDetailModal to avoid state duplication.
  const saveDetailEdit = (editData) => {
    if (!detailTask) return;
    showConfirm(
      'Save Changes',
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
          });
          setDetailEditing(false);
          const res = await getTaskDetail(detailTask.id);
          setDetailTask(res.data);
          setDetailComments(res.data.comments || []);
          refreshDetailHistory(detailTask.id);
          fetchTasks();
          if (activeTab === 'backlog') fetchBacklog();
        } catch {
          setError('Failed to update item');
        }
      },
      { confirmText: 'Save' }
    );
  };

  const handleAddDetailComment = useCallback(async (content) => {
    if (!detailTask) return;
    try {
      const res = await addTaskComment(detailTask.id, content);
      setDetailComments(prev => [...prev, res.data]);
      setTasks(prev => prev.map(t => t.id === detailTask.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
      setBacklogTasks(prev => prev.map(t => t.id === detailTask.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
    } catch { setError('Failed to add comment'); }
  }, [detailTask, setTasks, setBacklogTasks, setError]);

  const handleEditDetailComment = useCallback(async (commentId, content) => {
    if (!detailTask) return;
    try {
      const res = await updateTaskComment(detailTask.id, commentId, content);
      setDetailComments(prev => prev.map(c => c.id === commentId ? res.data : c));
    } catch { setError('Failed to update comment'); }
  }, [detailTask, setError]);

  const handleDetailDeleteComment = (commentId) => {
    showConfirm(
      'Delete Comment',
      'Are you sure you want to delete this comment? This cannot be undone.',
      async () => {
        closeConfirm();
        try {
          await deleteTaskComment(detailTask.id, commentId);
          setDetailComments(prev => prev.filter(c => c.id !== commentId));
          setTasks(prev => prev.map(t =>
            t.id === detailTask.id ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) } : t
          ));
          setBacklogTasks(prev => prev.map(t =>
            t.id === detailTask.id ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) } : t
          ));
        } catch { setError('Failed to delete comment'); }
      },
      { confirmText: 'Delete', isDanger: true }
    );
  };

  const handleDetailStatusChange = (task, col) => {
    showConfirm(
      'Change Status',
      `Change status of "${task.title}" to ${col.label}?`,
      async () => {
        closeConfirm();
        try {
          await updateTaskStatus(task.id, col.id);
          setDetailTask(prev => ({ ...prev, status: col.id }));
          refreshDetailHistory(task.id);
          fetchTasks();
          if (activeTab === 'backlog') fetchBacklog();
        } catch { setError('Failed to update status'); }
      },
      { confirmText: 'Move' }
    );
  };

  return {
    detailTask, setDetailTask,
    detailComments, setDetailComments,
    detailLoading,
    detailEditing, setDetailEditing,
    detailTab, setDetailTab,
    detailHistory,
    openTaskDetail, closeTaskDetail,
    startDetailEdit, saveDetailEdit,
    handleAddDetailComment, handleEditDetailComment,
    handleDetailDeleteComment, handleDetailStatusChange,
  };
}
