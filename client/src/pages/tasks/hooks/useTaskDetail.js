import { useState } from 'react';
import {
  getTaskDetail, getTaskHistory, getTaskComments,
  deleteTaskComment, updateTask, updateTaskStatus,
} from '../../../api';

export function useTaskDetail({ activeTab, backlogOpen, showConfirm, closeConfirm, setTasks, setBacklogTasks, fetchTasks, fetchBacklog, setError }) {
  const [detailTask, setDetailTask] = useState(null);
  const [detailComments, setDetailComments] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailEditTitle, setDetailEditTitle] = useState('');
  const [detailEditDesc, setDetailEditDesc] = useState('');
  const [detailEditPriority, setDetailEditPriority] = useState('medium');
  const [detailEditAssignedTo, setDetailEditAssignedTo] = useState('');
  const [detailEditDueDate, setDetailEditDueDate] = useState('');
  const [detailEditSprintId, setDetailEditSprintId] = useState('');
  const [detailEditLabels, setDetailEditLabels] = useState([]);
  const [detailEditLabelDropdownOpen, setDetailEditLabelDropdownOpen] = useState(false);
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

  const startDetailEdit = (task) => {
    setDetailEditing(true);
    setDetailEditTitle(task.title);
    setDetailEditDesc(task.description || '');
    setDetailEditPriority(task.priority || 'medium');
    setDetailEditAssignedTo(task.assigned_to || '');
    setDetailEditDueDate(task.due_date || '');
    setDetailEditSprintId(task.sprint_id || '');
    setDetailEditLabels(task.labels?.map((l) => l.id) || []);
  };

  const saveDetailEdit = () => {
    if (!detailTask) return;
    showConfirm(
      'Save Changes',
      `Save changes to "${detailEditTitle || detailTask.title}"?`,
      async () => {
        closeConfirm();
        try {
          await updateTask(detailTask.id, {
            title: detailEditTitle,
            description: detailEditDesc,
            priority: detailEditPriority,
            assigned_to: detailEditAssignedTo || null,
            due_date: detailEditDueDate || null,
            sprint_id: detailEditSprintId || null,
            label_ids: detailEditLabels,
          });
          setDetailEditing(false);
          const res = await getTaskDetail(detailTask.id);
          setDetailTask(res.data);
          setDetailComments(res.data.comments || []);
          refreshDetailHistory(detailTask.id);
          fetchTasks();
          if (backlogOpen || activeTab === 'backlog') fetchBacklog();
        } catch {
          setError('Failed to update item');
        }
      },
      { confirmText: 'Save' }
    );
  };

  const handleDetailDeleteComment = (commentId) => {
    showConfirm(
      'Delete Comment',
      'Are you sure you want to delete this comment? This cannot be undone.',
      async () => {
        closeConfirm();
        try {
          await deleteTaskComment(detailTask.id, commentId);
          setDetailComments((prev) => prev.filter((c) => c.id !== commentId));
          setTasks((prev) =>
            prev.map((t) =>
              t.id === detailTask.id
                ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) }
                : t
            )
          );
          setBacklogTasks((prev) =>
            prev.map((t) =>
              t.id === detailTask.id
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

  const handleDetailStatusChange = (task, col) => {
    showConfirm(
      'Change Status',
      `Change status of "${task.title}" to ${col.label}?`,
      async () => {
        closeConfirm();
        try {
          await updateTaskStatus(task.id, col.id);
          setDetailTask((prev) => ({ ...prev, status: col.id }));
          refreshDetailHistory(task.id);
          fetchTasks();
          if (backlogOpen || activeTab === 'backlog') fetchBacklog();
        } catch {
          setError('Failed to update status');
        }
      },
      { confirmText: 'Move' }
    );
  };

  return {
    detailTask, setDetailTask,
    detailComments, setDetailComments,
    detailLoading,
    detailEditing, setDetailEditing,
    detailEditTitle, setDetailEditTitle,
    detailEditDesc, setDetailEditDesc,
    detailEditPriority, setDetailEditPriority,
    detailEditAssignedTo, setDetailEditAssignedTo,
    detailEditDueDate, setDetailEditDueDate,
    detailEditSprintId, setDetailEditSprintId,
    detailEditLabels, setDetailEditLabels,
    detailEditLabelDropdownOpen, setDetailEditLabelDropdownOpen,
    detailTab, setDetailTab,
    detailHistory,
    openTaskDetail, closeTaskDetail,
    startDetailEdit, saveDetailEdit,
    handleDetailDeleteComment, handleDetailStatusChange,
  };
}
