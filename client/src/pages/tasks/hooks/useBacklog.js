import { useState, useCallback, useMemo } from 'react';
import { getBacklog, addBacklogTask, scheduleTask, unscheduleTask, assignTaskToSprint, updateTask, getLocalToday } from '../../../api';

export function useBacklog({ activeTab, backlogOpen, date, backlogFilters, selectedSprintId, showConfirm, closeConfirm, fetchTasks, setError }) {
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [backlogFormOpen, setBacklogFormOpen] = useState(false);
  const [backlogTitle, setBacklogTitle] = useState('');
  const [backlogDesc, setBacklogDesc] = useState('');
  const [backlogPriority, setBacklogPriority] = useState('medium');
  const [backlogAssignedTo, setBacklogAssignedTo] = useState('');
  const [backlogDueDate, setBacklogDueDate] = useState('');
  const [backlogLabels, setBacklogLabels] = useState([]);
  const [backlogLabelDropdownOpen, setBacklogLabelDropdownOpen] = useState(false);
  const [backlogSprintId, setBacklogSprintId] = useState('');
  const [scheduleTaskId, setScheduleTaskId] = useState(null);
  const [scheduleDate, setScheduleDate] = useState(() => getLocalToday());
  const [backlogSummary, setBacklogSummary] = useState({ total: 0, byStatus: {}, byPriority: {} });
  const [backlogSort, setBacklogSort] = useState('priority');
  const [importConfigTask, setImportConfigTask] = useState(null);
  const [importAssignedTo, setImportAssignedTo] = useState('');
  const [importDueDate, setImportDueDate] = useState('');

  const fetchBacklog = useCallback(async () => {
    setBacklogLoading(true);
    try {
      const res = await getBacklog(backlogFilters);
      setBacklogTasks(res.data.tasks);
      if (res.data.summary) setBacklogSummary(res.data.summary);
    } catch {
      setError('Failed to load backlog');
    } finally {
      setBacklogLoading(false);
    }
  }, [backlogFilters]);

  const sortedBacklogTasks = useMemo(() => {
    const sorted = [...backlogTasks];
    switch (backlogSort) {
      case 'priority':
        sorted.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 };
          return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
        });
        break;
      case 'newest': sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); break;
      case 'oldest': sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); break;
      case 'due_date':
        sorted.sort((a, b) => {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date.localeCompare(b.due_date);
        });
        break;
      case 'title': sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
      default: break;
    }
    return sorted;
  }, [backlogTasks, backlogSort]);

  const handleAddBacklog = async (e) => {
    e.preventDefault();
    if (!backlogTitle.trim()) return;
    try {
      await addBacklogTask({
        title: backlogTitle, description: backlogDesc, priority: backlogPriority,
        assigned_to: backlogAssignedTo || null, due_date: backlogDueDate || null,
        label_ids: backlogLabels.length > 0 ? backlogLabels : undefined,
        sprint_id: backlogSprintId || null,
      });
      setBacklogTitle(''); setBacklogDesc(''); setBacklogPriority('medium');
      setBacklogAssignedTo(''); setBacklogDueDate(''); setBacklogLabels([]);
      setBacklogSprintId(''); setBacklogFormOpen(false);
      fetchBacklog();
      if (backlogSprintId && activeTab === 'sprint') fetchTasks();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create backlog item');
    }
  };

  const handleScheduleTask = (taskId, taskTitle, closeAfter) => {
    if (!scheduleDate) return;
    showConfirm(
      'Schedule Task', `Schedule "${taskTitle || 'this task'}" to ${scheduleDate}?`,
      async () => {
        closeConfirm();
        try {
          await scheduleTask(taskId, scheduleDate);
          setScheduleTaskId(null);
          fetchBacklog();
          if (scheduleDate === date) fetchTasks();
          if (closeAfter) closeAfter();
        } catch { setError('Failed to schedule task'); }
      },
      { confirmText: 'Schedule' }
    );
  };

  const handleUnscheduleTask = (taskId, taskTitle, closeAfter) => {
    showConfirm(
      'Move to Backlog', `Move "${taskTitle || 'this task'}" to backlog? It will be removed from the planner.`,
      async () => {
        closeConfirm();
        try {
          await unscheduleTask(taskId);
          fetchTasks();
          if (backlogOpen || activeTab === 'backlog') fetchBacklog();
          if (closeAfter) closeAfter();
        } catch { setError('Failed to move task to backlog'); }
      },
      { confirmText: 'Move to Backlog' }
    );
  };

  const handleImportToSprint = async () => {
    if (!importConfigTask || !selectedSprintId) return;
    const importedId = importConfigTask.id;
    try {
      await assignTaskToSprint(importedId, selectedSprintId);
      if (importAssignedTo || importDueDate) {
        await updateTask(importedId, { assigned_to: importAssignedTo || null, due_date: importDueDate || null });
      }
      setBacklogTasks((prev) => prev.filter((t) => t.id !== importedId));
      setImportConfigTask(null); setImportAssignedTo(''); setImportDueDate('');
      fetchTasks(); fetchBacklog();
    } catch { setError('Failed to import task to sprint'); }
  };

  return {
    backlogTasks, setBacklogTasks,
    backlogLoading,
    backlogFormOpen, setBacklogFormOpen,
    backlogTitle, setBacklogTitle,
    backlogDesc, setBacklogDesc,
    backlogPriority, setBacklogPriority,
    backlogAssignedTo, setBacklogAssignedTo,
    backlogDueDate, setBacklogDueDate,
    backlogLabels, setBacklogLabels,
    backlogLabelDropdownOpen, setBacklogLabelDropdownOpen,
    backlogSprintId, setBacklogSprintId,
    scheduleTaskId, setScheduleTaskId,
    scheduleDate, setScheduleDate,
    backlogSummary,
    backlogSort, setBacklogSort,
    importConfigTask, setImportConfigTask,
    importAssignedTo, setImportAssignedTo,
    importDueDate, setImportDueDate,
    fetchBacklog, sortedBacklogTasks,
    handleAddBacklog, handleScheduleTask, handleUnscheduleTask, handleImportToSprint,
  };
}
