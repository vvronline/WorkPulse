import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getTasks, updateTaskStatus, updateTask, addTask, deleteTask, carryForwardTasks,
  getAssignableUsers, getTaskLabels, getTaskComments, addTaskComment, updateTaskComment, deleteTaskComment,
  getLocalToday, getBacklog, addBacklogTask, scheduleTask, unscheduleTask, getTaskDetail, getTaskHistory,
  searchTasks, getTeamSprintConfig, updateTeamSprintConfig, getAvailableSprints, assignTaskToSprint
} from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import CommentSection from '../components/CommentSection';
import SprintSelector from '../components/SprintSelector';
import DailyNotes from '../components/DailyNotes';
import { useAuth } from '../AuthContext';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import DOMPurify from 'dompurify';
import hljs from '../hljs-setup';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import 'highlight.js/styles/github-dark.css';
import s from './Tasks.module.css';

const PRIORITIES = [
  { value: 'high', label: 'High', icon: '🔴', color: 'var(--danger)' },
  { value: 'medium', label: 'Medium', icon: '🟡', color: 'var(--warning)' },
  { value: 'low', label: 'Low', icon: '🟢', color: 'var(--success)' },
];

const COLUMNS = [
  { id: 'pending', label: 'To Do', icon: '○', color: 'var(--text-muted)' },
  { id: 'in_progress', label: 'In Progress', icon: '◐', color: 'var(--warning)' },
  { id: 'in_review', label: 'In Review', icon: '◑', color: 'var(--primary-light)' },
  { id: 'done', label: 'Done', icon: '●', color: 'var(--success)' },
];

const COMMENT_QUILL_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    ['code-block'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link'],
    ['clean'],
  ],
  syntax: { highlight: (text) => hljs.highlightAuto(text).value },
};

/** Pre-process HTML string: highlight code inside <pre> blocks before React renders */
function highlightHtml(raw) {
  if (!raw) return '';
  const clean = DOMPurify.sanitize(raw);
  // Replace <pre ...>code</pre> with highlighted version
  return clean.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, code) => {
    // Decode HTML entities so hljs sees real text
    const txt = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    try {
      const result = hljs.highlightAuto(txt);
      return `<pre class="hljs">${result.value}</pre>`;
    } catch {
      return match;
    }
  });
}

function HighlightedHtml({ html, className, ...rest }) {
  const highlighted = useMemo(() => highlightHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: highlighted }} {...rest} />;
}

export default function Tasks() {
  const { user: currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState({ total: 0, done: 0, inProgress: 0, percent: 0 });
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => getLocalToday());
  
  // Sprint config state
  const [sprintConfig, setSprintConfig] = useState(null); // Current sprint config from team
  const [sprintConfigLoading, setSprintConfigLoading] = useState(false);

  const [error, setError] = useAutoDismiss('');
  const [taskToDelete, setTaskToDelete] = useState(null);
  const [carriedCount, setCarriedCount] = useState(0);

  // Generic confirmation dialog
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', confirmText: 'Confirm', isDanger: false, onConfirm: null });
  const showConfirm = (title, message, onConfirm, { confirmText = 'Confirm', isDanger = false } = {}) => {
    setConfirmDialog({ open: true, title, message, confirmText, isDanger, onConfirm });
  };
  const closeConfirm = () => setConfirmDialog(prev => ({ ...prev, open: false, onConfirm: null }));

  // Drag
  const [dragOverCol, setDragOverCol] = useState(null);
  const dragTaskId = useRef(null);
  const autoCarriedRef = useRef(false);

  // Filters
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterLabel, setFilterLabel] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Global search
  const [globalSearch, setGlobalSearch] = useState('');
  const [globalResults, setGlobalResults] = useState([]);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const globalSearchRef = useRef(null);
  const globalSearchTimer = useRef(null);

  // Shared data
  const [assignableUsers, setAssignableUsers] = useState([]);
  const [orgLabels, setOrgLabels] = useState([]);

  // Comments
  const [commentTaskId, setCommentTaskId] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editCommentText, setEditCommentText] = useState('');

  // Task Detail Modal
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
  const [detailTab, setDetailTab] = useState('comments'); // 'comments' | 'history'
  const [detailHistory, setDetailHistory] = useState([]);

  // Backlog
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
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
  const [sprintAssignTaskId, setSprintAssignTaskId] = useState(null);
  const [backlogSummary, setBacklogSummary] = useState({ total: 0, byStatus: {}, byPriority: {} });
  const [backlogSort, setBacklogSort] = useState('priority');


  // Active tab (myday, sprint, or backlog)
  const [activeTab, setActiveTab] = useState('myday');
  const sprintMode = activeTab === 'sprint';

  // Available sprints for sprint selector
  const [availableSprints, setAvailableSprints] = useState([]);
  const [selectedSprintId, setSelectedSprintId] = useState(null); // sprint_id for sprint tab

  // Sprint import from backlog
  const [sprintImportOpen, setSprintImportOpen] = useState(false);
  const [importConfigTask, setImportConfigTask] = useState(null);
  const [importAssignedTo, setImportAssignedTo] = useState('');
  const [importDueDate, setImportDueDate] = useState('');

  // ─── Data fetching ────────────────────────────────────────────────────
  useEffect(() => {
    getAssignableUsers().then(r => setAssignableUsers(r.data)).catch(() => {});
    getTaskLabels().then(r => setOrgLabels(r.data)).catch(() => {});
    if (currentUser?.team_id) {
      getAvailableSprints().then(r => {
        setAvailableSprints(r.data);
        // Auto-select active sprint
        const active = r.data.find(sp => sp.status === 'active');
        if (active) setSelectedSprintId(active.id);
      }).catch(() => {});
    }
  }, [currentUser?.team_id]);

  // Auto-open task detail when navigated here with ?task=ID (e.g. from notification bell)
  useEffect(() => {
    const taskId = searchParams.get('task');
    if (!taskId) return;
    // Clear param immediately so browser back works cleanly
    setSearchParams({}, { replace: true });
    getTaskDetail(taskId).then(res => {
      openTaskDetail(res.data);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const plannerFilters = useMemo(() => {
    const f = {};
    if (filterAssignee) f.assignee = filterAssignee;
    if (filterLabel) f.label = filterLabel;
    if (filterPriority) f.priority = filterPriority;
    if (filterStatus) f.status = filterStatus;
    if (filterSearch.trim()) f.search = filterSearch.trim();
    return Object.keys(f).length ? f : undefined;
  }, [filterAssignee, filterLabel, filterPriority, filterStatus, filterSearch]);

  const backlogFilters = useMemo(() => {
    const f = {};
    if (filterAssignee) f.assignee = filterAssignee;
    if (filterLabel) f.label = filterLabel;
    if (filterPriority) f.priority = filterPriority;
    if (filterSearch.trim()) f.search = filterSearch.trim();
    return Object.keys(f).length ? f : undefined;
  }, [filterAssignee, filterLabel, filterPriority, filterSearch]);

  const filterCount = useMemo(() => {
    const base = [filterAssignee, filterLabel, filterPriority, filterSearch.trim()];
    if (activeTab === 'myday' || activeTab === 'sprint') base.push(filterStatus);
    return base.filter(Boolean).length;
  }, [filterAssignee, filterLabel, filterPriority, filterStatus, filterSearch, activeTab]);

  const summaryAllActive = !filterPriority;
  const handleSummaryTotal = () => {
    setFiltersOpen(true);
    setFilterPriority('');
    setFilterStatus('');
  };
  const handleSummaryPriority = (value) => {
    setFiltersOpen(true);
    setFilterPriority(prev => (prev === value ? '' : value));
  };

  const fetchTasks = useCallback(async () => {
    try {
      const params = { ...plannerFilters };
      if (activeTab === 'sprint' && selectedSprintId) {
        // Sprint mode: fetch by sprint_id — only sprint-assigned tasks
        params.sprint_id = selectedSprintId;
        const res = await getTasks(undefined, params);
        setTasks(res.data.tasks);
        setStats(res.data.stats);
      } else if (activeTab === 'sprint' && !selectedSprintId) {
        // Sprint tab with no sprint selected: clear stale tasks
        setTasks([]);
        setStats({ total: 0, done: 0, inProgress: 0, percent: 0 });
      } else if (activeTab === 'myday') {
        // My Day: personal scope + include no-sprint tasks due today
        params.scope = 'personal';
        params.include_due = '1';
        const res = await getTasks(date, params);
        setTasks(res.data.tasks);
        setStats(res.data.stats);
      }
      setError('');
    } catch {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [date, activeTab, selectedSprintId, plannerFilters]);

  useEffect(() => {
    if (activeTab === 'backlog') return; // Don't fetch planner tasks when on backlog tab
    const controller = new AbortController();
    setLoading(true);
    fetchTasks().finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [fetchTasks, activeTab]);

  // Fetch sprint config if user has a team
  useEffect(() => {
    if (!currentUser?.team_id) {
      setSprintConfig(null);
      if (activeTab === 'sprint') setActiveTab('myday');
      return;
    }

    const fetchSprintConfig = async () => {
      try {
        setSprintConfigLoading(true);
        const res = await getTeamSprintConfig(currentUser.team_id);
        setSprintConfig(res.data);
      } catch (err) {
        console.error('Failed to load sprint config:', err);
        if (activeTab === 'sprint') setActiveTab('myday');
      } finally {
        setSprintConfigLoading(false);
      }
    };

    fetchSprintConfig();
  }, [currentUser?.team_id]);

  // Auto carry-forward: runs once when viewing today's date
  useEffect(() => {
    const today = getLocalToday();
    if (date !== today || autoCarriedRef.current) return;
    autoCarriedRef.current = true;
    carryForwardTasks()
      .then((res) => {
        if (res.data.carried > 0) {
          setCarriedCount(res.data.carried);
          fetchTasks();
          setTimeout(() => setCarriedCount(0), 4000);
        }
      })
      .catch(e => console.error(e));
  }, [date, fetchTasks]);

  // ─── Comments ─────────────────────────────────────────────────────────
  const stripHtml = (html) => {
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = DOMPurify.sanitize(html);
    return tmp.textContent || tmp.innerText || '';
  };

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
      setComments(prev => [...prev, res.data]);
      setCommentText('');
      // Update comment count on the task
      setTasks(prev => prev.map(t => t.id === commentTaskId ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
    } catch {
      setError('Failed to add comment');
    }
  };

  const handleEditComment = async (commentId) => {
    if (!stripHtml(editCommentText).trim()) return;
    try {
      const res = await updateTaskComment(commentTaskId, commentId, editCommentText);
      setComments(prev => prev.map(c => c.id === commentId ? res.data : c));
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
          setComments(prev => prev.filter(c => c.id !== commentId));
          setTasks(prev => prev.map(t => t.id === commentTaskId ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) } : t));
        } catch {
          setError('Failed to delete comment');
        }
      },
      { confirmText: 'Delete', isDanger: true }
    );
  };

  // ─── Task Detail Modal ────────────────────────────────────────────────
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
      // fallback to basic task data + fetch comments separately
      try {
        const cRes = await getTaskComments(task.id);
        setDetailComments(cRes.data);
      } catch { /* ignore */ }
    } finally {
      setDetailLoading(false);
    }
    // Fetch history in background
    try {
      const hRes = await getTaskHistory(task.id);
      setDetailHistory(hRes.data || []);
    } catch { /* ignore */ }
  };

  const refreshDetailHistory = async (taskId) => {
    try {
      const hRes = await getTaskHistory(taskId);
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
    setDetailEditLabels(task.labels?.map(l => l.id) || []);
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
          // Re-fetch detail
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
          setDetailComments(prev => prev.filter(c => c.id !== commentId));
          setTasks(prev => prev.map(t => t.id === detailTask.id ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) } : t));
          setBacklogTasks(prev => prev.map(t => t.id === detailTask.id ? { ...t, comment_count: Math.max(0, (t.comment_count || 1) - 1) } : t));
        } catch {
          setError('Failed to delete comment');
        }
      },
      { confirmText: 'Delete', isDanger: true }
    );
  };

  // ─── Backlog ──────────────────────────────────────────────────────────
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

  useEffect(() => {
    if (activeTab === 'backlog' || backlogOpen) {
      fetchBacklog();
    }
  }, [activeTab, backlogOpen, fetchBacklog]);

  const handleAddBacklog = async (e) => {
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
      });
      setBacklogTitle('');
      setBacklogDesc('');
      setBacklogPriority('medium');
      setBacklogAssignedTo('');
      setBacklogDueDate('');
      setBacklogLabels([]);
      setBacklogSprintId('');
      setBacklogFormOpen(false);
      fetchBacklog();
      // If sprint was selected, also refresh sprint tasks
      if (backlogSprintId && activeTab === 'sprint') fetchTasks();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create backlog item');
    }
  };

  const handleToggleDone = (task) => {
    const newStatus = task.status === 'done' ? 'pending' : 'done';
    const label = newStatus === 'done' ? 'Mark as done' : 'Mark as incomplete';
    showConfirm(
      label,
      `${label}: "${task.title}"?`,
      async () => {
        closeConfirm();
        try {
          await updateTaskStatus(task.id, newStatus);
          fetchTasks();
        } catch {
          setError('Failed to update task');
        }
      },
      { confirmText: label }
    );
  };

  const handleScheduleTask = (taskId, taskTitle, closeAfter) => {
    if (!scheduleDate) return;
    showConfirm(
      'Schedule Task',
      `Schedule "${taskTitle || 'this task'}" to ${scheduleDate}?`,
      async () => {
        closeConfirm();
        try {
          await scheduleTask(taskId, scheduleDate);
          setScheduleTaskId(null);
          fetchBacklog();
          if (scheduleDate === date) fetchTasks();
          if (closeAfter) closeAfter();
        } catch {
          setError('Failed to schedule task');
        }
      },
      { confirmText: 'Schedule' }
    );
  };

  const handleBacklogAssignSprint = async (taskId, sprintId) => {
    try {
      await assignTaskToSprint(taskId, sprintId);
      setSprintAssignTaskId(null);
      fetchBacklog();
      fetchTasks();
    } catch {
      setError('Failed to assign sprint');
    }
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
      // Optimistically remove from backlog immediately
      setBacklogTasks(prev => prev.filter(t => t.id !== importedId));
      setImportConfigTask(null);
      setImportAssignedTo('');
      setImportDueDate('');
      fetchTasks();
      fetchBacklog();
    } catch {
      setError('Failed to import task to sprint');
    }
  };

  const handleUnscheduleTask = (taskId, taskTitle, closeAfter) => {
    showConfirm(
      'Move to Backlog',
      `Move "${taskTitle || 'this task'}" to backlog? It will be removed from the planner.`,
      async () => {
        closeConfirm();
        try {
          await unscheduleTask(taskId);
          fetchTasks();
          if (backlogOpen || activeTab === 'backlog') fetchBacklog();
          if (closeAfter) closeAfter();
        } catch {
          setError('Failed to move task to backlog');
        }
      },
      { confirmText: 'Move to Backlog' }
    );
  };

  const sortedBacklogTasks = useMemo(() => {
    const sorted = [...backlogTasks];
    switch (backlogSort) {
      case 'priority':
        sorted.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 };
          return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
        });
        break;
      case 'newest':
        sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        break;
      case 'due_date':
        sorted.sort((a, b) => {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date.localeCompare(b.due_date);
        });
        break;
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      default:
        break;
    }
    return sorted;
  }, [backlogTasks, backlogSort]);

  const formatRelativeTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    if (diffD < 30) return `${Math.floor(diffD / 7)}w ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const confirmDeleteWithRefresh = async () => {
    if (!taskToDelete) return;
    try {
      await deleteTask(taskToDelete.id);
      setTaskToDelete(null);
      if (commentTaskId === taskToDelete.id) closeComments();
      if (detailTask?.id === taskToDelete.id) closeTaskDetail();
      fetchTasks();
      if (backlogOpen || activeTab === 'backlog') fetchBacklog();
    } catch {
      setError('Failed to delete item');
    }
  };

  // ─── Task CRUD ────────────────────────────────────────────────────────
  const handleDelete = (task) => setTaskToDelete(task);

  const confirmDelete = async () => {
    await confirmDeleteWithRefresh();
  };

  const clearFilters = () => {
    setFilterAssignee('');
    setFilterLabel('');
    setFilterPriority('');
    setFilterStatus('');
    setFilterSearch('');
  };

  // ─── Global search ───────────────────────────────────────────────────
  const handleGlobalSearch = (value) => {
    setGlobalSearch(value);
    if (globalSearchTimer.current) clearTimeout(globalSearchTimer.current);
    if (!value.trim() || value.trim().length < 2) {
      setGlobalResults([]);
      setGlobalSearchOpen(false);
      setGlobalSearching(false);
      return;
    }
    setGlobalSearching(true);
    setGlobalSearchOpen(true);
    globalSearchTimer.current = setTimeout(async () => {
      try {
        const res = await searchTasks(value.trim());
        setGlobalResults(res.data);
      } catch {
        setGlobalResults([]);
      } finally {
        setGlobalSearching(false);
      }
    }, 300);
  };

  // Close search results on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (globalSearchRef.current && !globalSearchRef.current.contains(e.target)) {
        setGlobalSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ─── Drag & Drop handlers ────────────────────────────────────────────
  const onDragStart = (e, taskId) => {
    dragTaskId.current = taskId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(taskId));
    const el = document.getElementById(`task-${taskId}`);
    if (el) el.classList.add(s.dragging);
  };

  const onDragEnd = (e, taskId) => {
    const el = document.getElementById(`task-${taskId}`);
    if (el) el.classList.remove(s.dragging);
    dragTaskId.current = null;
    setDragOverCol(null);
  };

  const onDragOver = (e, colId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== colId) setDragOverCol(colId);
  };

  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverCol(null);
  };

  const onDrop = async (e, colId) => {
    e.preventDefault();
    setDragOverCol(null);
    const rawId = e.dataTransfer.getData('text/plain');
    const taskId = rawId ? parseInt(rawId, 10) : dragTaskId.current;
    dragTaskId.current = null;
    if (!taskId) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === colId) return;
    const colLabel = COLUMNS.find(c => c.id === colId)?.label || colId;
    showConfirm(
      'Change Status',
      `Move "${task.title}" to ${colLabel}?`,
      async () => {
        closeConfirm();
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: colId } : t));
        try {
          await updateTaskStatus(taskId, colId);
          fetchTasks();
        } catch {
          setError('Failed to move item');
          fetchTasks();
        }
      },
      { confirmText: 'Move' }
    );
  };

  // ─── Helpers ──────────────────────────────────────────────────────────
  const isToday = date === getLocalToday();
  const getPriority = (p) => PRIORITIES.find(pr => pr.value === p) || PRIORITIES[1];
  const getColTasks = (colId) => tasks.filter(t => t.status === colId);

  const toggleLabel = (labelId, list, setter) => {
    setter(prev => prev.includes(labelId) ? prev.filter(id => id !== labelId) : [...prev, labelId]);
  };

  const parseLocalDate = (value) => new Date(`${value}T00:00:00`);

  const getAvatarUrl = (avatar) => {
    if (!avatar) return '';
    return avatar.startsWith('/') ? avatar : `/uploads/avatars/${avatar}`;
  };

  const formatDueDate = (d) => {
    if (!d) return null;
    const today = getLocalToday();
    if (d === today) return 'Today';
    const diff = Math.ceil((parseLocalDate(d) - parseLocalDate(today)) / 86400000);
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff < 0) return `${Math.abs(diff)}d overdue`;
    if (diff <= 7) return `${diff}d left`;
    return parseLocalDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const formatDate = (d) => {
    if (!d) return '';
    return parseLocalDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const isDueOverdue = (d) => d && d < getLocalToday();

  // ─── Label Selector Component ─────────────────────────────────────────
  function LabelSelector({ labels, selected, onToggle, open, setOpen }) {
    const ref = useRef(null);
    useEffect(() => {
      const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [setOpen]);

    return (
      <div className={s['label-selector']} ref={ref}>
        <button type="button" className={s['label-selector-btn']} onClick={() => setOpen(o => !o)}>
          🏷️ Labels {selected.length > 0 && <span className={s['label-count']}>{selected.length}</span>}
        </button>
        {open && (
          <div className={s['label-dropdown']}>
            {labels.length === 0 && <div className={s['label-dropdown-empty']}>No labels configured</div>}
            {labels.map(l => (
              <label key={l.id} className={s['label-option']}>
                <input type="checkbox" checked={selected.includes(l.id)} onChange={() => onToggle(l.id)} />
                <span className={s['label-pill']} style={{ '--label-color': l.color }}>{l.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Comment Panel ────────────────────────────────────────────────────
  function renderCommentPanel() {
    if (!commentTaskId) return null;
    const task = tasks.find(t => t.id === commentTaskId);
    if (!task) return null;

    return (
      <div className={s['comment-overlay']} onClick={closeComments}>
        <div className={s['comment-panel']} onClick={e => e.stopPropagation()}>
          <div className={s['comment-panel-header']}>
            <h3>💬 Comments — {task.title}</h3>
            <button className={s['close-form-btn']} onClick={closeComments}>✕</button>
          </div>
          <div className={s['comment-list']}>
            {commentsLoading && <div className="loading-spinner"><div className="spinner" /></div>}
            {!commentsLoading && comments.length === 0 && (
              <div className={s['comment-empty']}>No comments yet. Start the conversation!</div>
            )}
            {comments.map(c => (
              <div key={c.id} className={s['comment-item']}>
                <div className={s['comment-meta']}>
                  {c.avatar ? (
                    <img src={getAvatarUrl(c.avatar)} alt="" className={s['comment-avatar']} />
                  ) : (
                    <span className={s['comment-avatar-placeholder']}>{(c.full_name || c.username || '?')[0].toUpperCase()}</span>
                  )}
                  <strong>{c.full_name || c.username}</strong>
                  <span className={s['comment-time']}>{new Date(c.created_at + 'Z').toLocaleString()}</span>
                  {c.updated_at && c.updated_at !== c.created_at && <span className={s['comment-edited']}>(edited)</span>}
                </div>
                {editingCommentId === c.id ? (
                  <div className={s['comment-edit']}>
                    <div className={s['comment-quill-wrapper']}>
                      <ReactQuill theme="snow" value={editCommentText} onChange={setEditCommentText} modules={COMMENT_QUILL_MODULES} placeholder="Edit comment..." />
                    </div>
                    <div className={s['comment-edit-actions']}>
                      <button className="btn btn-primary btn-sm" onClick={() => handleEditComment(c.id)}>Save</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingCommentId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <HighlightedHtml html={c.content} className={s['comment-body']} />
                    <div className={s['comment-actions']}>
                      {c.user_id === currentUser?.id && (
                        <button onClick={() => { setEditingCommentId(c.id); setEditCommentText(c.content); }}>Edit</button>
                      )}
                      <button onClick={() => handleDeleteComment(c.id)}>Delete</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className={s['comment-input']}>
            <div className={s['comment-quill-wrapper']}>
              <ReactQuill theme="snow" value={commentText} onChange={setCommentText} modules={COMMENT_QUILL_MODULES} placeholder="Write a comment..." />
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleAddComment} disabled={!stripHtml(commentText).trim()}>Send</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s['tasks-page']}>
      {/* Header */}
      <div className={s['tasks-header']}>
        <div>
          {activeTab === 'sprint' ? (
            (() => {
              const sp = availableSprints.find(s => s.id === selectedSprintId);
              const teamName = currentUser?.team_name || 'Team';
              const daysLeft = sp ? Math.max(0, Math.ceil(
                (Date.UTC(...sp.end_date.split('-').map((v,i) => i===1?v-1:+v))
                - Date.UTC(...getLocalToday().split('-').map((v,i) => i===1?v-1:+v))) / 86400000
              )) : 0;
              return (
                <>
                  <h2>
                    <span className="page-icon">🏃</span> {teamName} — {sp ? sp.name : 'Sprint'}
                  </h2>
                  <p>
                    {sp ? `${sp.start_date} → ${sp.end_date} • ${daysLeft}d remaining` : 'Loading sprint…'}
                  </p>
                </>
              );
            })()
          ) : activeTab === 'backlog' ? (
            <>
              <h2><span className="page-icon">📦</span> Backlog</h2>
              <p>Unscheduled items waiting to be planned</p>
            </>
          ) : (
            <>
              <h2><span className="page-icon">☀️</span> My Day</h2>
              <p>{isToday ? 'Your personal tasks for today' : `Tasks for ${formatDate(date)}`}</p>
            </>
          )}
        </div>
        <div className={s['tasks-header-actions']}>
          <div className={s['tab-switcher']}>
            <button
              className={`${s['tab-btn']} ${activeTab === 'myday' ? s['tab-active'] : ''}`}
              onClick={() => setActiveTab('myday')}
            >
              ☀️ My Day
            </button>
            {currentUser?.team_id && availableSprints.length > 0 && (
              <button
                className={`${s['tab-btn']} ${activeTab === 'sprint' ? s['tab-active'] : ''}`}
                onClick={() => {
                  setActiveTab('sprint');
                  if (!selectedSprintId) {
                    const active = availableSprints.find(sp => sp.status === 'active');
                    setSelectedSprintId(active ? active.id : (availableSprints[0]?.id ?? null));
                  }
                }}
              >
                🏃 Sprint
              </button>
            )}
            <button
              className={`${s['tab-btn']} ${activeTab === 'backlog' ? s['tab-active'] : ''}`}
              onClick={() => setActiveTab('backlog')}
            >
              📦 Backlog {backlogTasks.length > 0 && <span className={s['tab-badge']}>{backlogTasks.length}</span>}
            </button>
          </div>
          {activeTab === 'sprint' && availableSprints.length > 1 && (
            <select
              value={selectedSprintId || ''}
              onChange={e => setSelectedSprintId(Number(e.target.value))}
              className={s['date-input']}
            >
              {availableSprints.map(sp => (
                <option key={sp.id} value={sp.id}>
                  {sp.name} {sp.status === 'active' ? '(Active)' : ''}
                </option>
              ))}
            </select>
          )}
          {activeTab === 'myday' && (
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={s['date-input']}
            />
          )}
          <button
            className={`btn btn-secondary ${s['filter-toggle-btn']} ${filterCount > 0 ? s['has-filters'] : ''}`}
            onClick={() => setFiltersOpen(o => !o)}
          >
            🔍 {filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
          </button>
          {activeTab === 'backlog' && (
            <button
              className={`btn btn-secondary ${s['add-task-toggle']}`}
              onClick={() => setBacklogFormOpen(o => !o)}
            >
              ➕ New Ticket
            </button>
          )}
          {activeTab === 'sprint' && selectedSprintId && (
            <button
              className={`btn btn-secondary ${s['add-task-toggle']} ${sprintImportOpen ? s['tab-active'] : ''}`}
              onClick={() => { setSprintImportOpen(o => !o); if (!backlogTasks.length) fetchBacklog(); }}
            >
              📦 Import from Backlog
            </button>
          )}
        </div>
      </div>

      {/* Global Search */}
      <div className={s['global-search-wrapper']} ref={globalSearchRef}>
        <div className={s['global-search-input-row']}>
          <span className={s['global-search-icon']}>🔍</span>
          <input
            type="text"
            value={globalSearch}
            onChange={e => handleGlobalSearch(e.target.value)}
            onFocus={() => { if (globalResults.length > 0 || globalSearch.trim().length >= 2) setGlobalSearchOpen(true); }}
            placeholder="Search all tasks..."
            className={s['global-search-input']}
          />
          {globalSearch && (
            <button className={s['global-search-clear']} onClick={() => { setGlobalSearch(''); setGlobalResults([]); setGlobalSearchOpen(false); }}>✕</button>
          )}
        </div>
        {globalSearchOpen && (
          <div className={s['global-search-results']}>
            {globalSearching ? (
              <div className={s['global-search-status']}>Searching...</div>
            ) : globalResults.length === 0 ? (
              <div className={s['global-search-status']}>No results found</div>
            ) : (
              globalResults.map(task => {
                const pri = getPriority(task.priority);
                const colInfo = COLUMNS.find(c => c.id === task.status) || COLUMNS[0];
                return (
                  <div
                    key={task.id}
                    className={s['global-search-item']}
                    onClick={() => { openTaskDetail(task); setGlobalSearchOpen(false); }}
                  >
                    <div className={s['global-search-item-top']}>
                      <span className={s['backlog-ticket-id']}>#{task.id}</span>
                      <span className={s['global-search-item-title']}>{task.title}</span>
                    </div>
                    <div className={s['global-search-item-meta']}>
                      <span
                        className={s['backlog-status-badge']}
                        style={{ '--badge-bg': colInfo.color + '20', '--badge-color': colInfo.color }}
                      >
                        {colInfo.icon} {colInfo.label}
                      </span>
                      <span
                        className={s['task-priority-badge']}
                        style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
                      >
                        {pri.icon} {pri.label}
                      </span>
                      {task.date ? (
                        <span className={s['global-search-date']}>📅 {task.date}</span>
                      ) : (
                        <span className={s['global-search-date']}>📦 Backlog</span>
                      )}
                      {task.labels && task.labels.map(l => (
                        <span key={l.id} className={s['label-pill']} style={{ '--label-color': l.color }}>{l.name}</span>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Filter Bar */}
      {filtersOpen && (
        <div className={s['filter-bar']}>
          <div className={s['filter-row']}>
            <div className={s['filter-group']}>
              <label>Assignee</label>
              <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)} className={s['filter-select']}>
                <option value="">All</option>
                <option value="me">My Tasks</option>
                {assignableUsers.map(u => (
                  <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                ))}
              </select>
            </div>
            <div className={s['filter-group']}>
              <label>Label</label>
              <select value={filterLabel} onChange={e => setFilterLabel(e.target.value)} className={s['filter-select']}>
                <option value="">All</option>
                {orgLabels.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div className={s['filter-group']}>
              <label>Priority</label>
              <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className={s['filter-select']}>
                <option value="">All</option>
                {PRIORITIES.map(p => (
                  <option key={p.value} value={p.value}>{p.icon} {p.label}</option>
                ))}
              </select>
            </div>
            {(activeTab === 'myday' || activeTab === 'sprint') && (
              <div className={s['filter-group']}>
                <label>Status</label>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={s['filter-select']}>
                  <option value="">All</option>
                  {COLUMNS.map(c => (
                    <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
                  ))}
                </select>
              </div>
            )}
            {filterCount > 0 && (
              <button className={`btn btn-secondary btn-sm ${s['clear-filters-btn']}`} onClick={clearFilters}>
                ✕ Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* ─── SPRINT TAB ────────────────────────────────────── */}
      {activeTab === 'sprint' && (
        <>
          {/* Progress Bar */}
          <div className={s['tasks-progress-card']}>
            <div className={s['tasks-progress-info']}>
              <span className={s['tasks-progress-label']}>{stats.done}/{stats.total} completed</span>
              <span className={s['tasks-progress-pct']}>{stats.percent}%</span>
            </div>
            <div className={s['tasks-progress-bar']}>
              <div className={s['tasks-progress-fill']} style={{ '--fill-width': `${stats.percent}%` }} />
            </div>
            <div className={s['tasks-progress-counts']}>
              {COLUMNS.map(col => (
                <span key={col.id} style={{ color: col.color }}>
                  {col.icon} {getColTasks(col.id).length} {col.label}
                </span>
              ))}
            </div>
          </div>

          {carriedCount > 0 && (
            <div className={s['carry-banner']}>
              📥 {carriedCount} incomplete item{carriedCount > 1 ? 's' : ''} from yesterday carried forward automatically.
            </div>
          )}
          {error && <div className="error-msg error-msg-mb">{error}</div>}

          {/* Import from Backlog panel */}
          {sprintImportOpen && (
            <div className={s['sprint-import-panel']}>
              <div className={s['sprint-import-header']}>
                <span>📦 Import tickets from Backlog into this sprint</span>
                <button className={s['close-form-btn']} onClick={() => { setSprintImportOpen(false); setImportConfigTask(null); }}>✕</button>
              </div>
              {backlogLoading ? (
                <div className="loading-spinner"><div className="spinner" /></div>
              ) : (() => {
                const importable = backlogTasks.filter(t => t.sprint_id !== selectedSprintId && t.status !== 'done');
                if (importable.length === 0) {
                  return <p className={s['sprint-import-empty']}>No backlog tickets available to import.</p>;
                }
                return (
                  <div className={s['sprint-import-list']}>
                    {importable.map(task => {
                      const pri = getPriority(task.priority);
                      const configuring = importConfigTask?.id === task.id;
                      return (
                        <div key={task.id} className={`${s['sprint-import-item']} ${configuring ? s['sprint-import-item-active'] : ''}`}>
                          <div className={s['sprint-import-item-top']}>
                            <span className={s['backlog-ticket-id']}>#{task.id}</span>
                            <span
                              className={s['task-priority-badge']}
                              style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
                            >{pri.icon} {pri.label}</span>
                            <span className={s['sprint-import-title']}>{task.title}</span>
                            {!configuring && (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => {
                                  setImportConfigTask(task);
                                  setImportAssignedTo(task.assigned_to ? String(task.assigned_to) : '');
                                  const sprint = availableSprints.find(sp => sp.id === selectedSprintId);
                                  setImportDueDate(sprint?.end_date || task.due_date || '');
                                }}
                              >Import</button>
                            )}
                          </div>
                          {configuring && (
                            <div className={s['sprint-import-config']}>
                              <div className={s['sprint-import-config-row']}>
                                <label>👤 Assign to</label>
                                <select
                                  value={importAssignedTo}
                                  onChange={e => setImportAssignedTo(e.target.value)}
                                  className={s['sprint-import-select']}
                                >
                                  <option value="">Unassigned</option>
                                  {assignableUsers.map(u => (
                                    <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                                  ))}
                                </select>
                                <label>📅 Due date</label>
                                <input
                                  type="date"
                                  value={importDueDate}
                                  onChange={e => setImportDueDate(e.target.value)}
                                  className={s['date-input']}
                                />
                              </div>
                              <div className={s['sprint-import-config-actions']}>
                                <button className="btn btn-primary btn-sm" onClick={handleImportToSprint}>
                                  ✓ Confirm Import
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => { setImportConfigTask(null); setImportAssignedTo(''); setImportDueDate(''); }}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Kanban Board */}
          {loading ? (
            <div className="loading-spinner"><div className="spinner" /></div>
          ) : (
            <div className={s['kanban-board']}>
              {COLUMNS.map(col => {
                const colTasks = getColTasks(col.id);
                const isDragOver = dragOverCol === col.id;

                return (
                  <div
                    key={col.id}
                    className={`${s['kanban-column']} ${isDragOver ? s['drag-over'] : ''}`}
                    style={{ '--col-color': col.color }}
                    onDragOver={(e) => onDragOver(e, col.id)}
                    onDragLeave={onDragLeave}
                    onDrop={(e) => onDrop(e, col.id)}
                  >
                    <div className={s['column-header']}>
                      <div className={s['column-header-left']}>
                        <span className={s['column-dot']} style={{ background: col.color }} />
                        <span className={s['column-label']}>{sprintMode && col.id === 'pending' ? 'New' : col.label}</span>
                      </div>
                      <span className={s['column-count']}>{colTasks.length}</span>
                    </div>

                    {isDragOver && (
                      <div className={s['drop-indicator']}>Drop here</div>
                    )}

                    <div className={s['column-tasks']}>
                      {colTasks.length === 0 && !isDragOver && (
                        <div className={s['column-empty']}><span>No items</span></div>
                      )}
                      {colTasks.map(task => renderCard(task, col))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tasks.length === 0 && !loading && (
            <div className={s['tasks-empty']}>
              <div className={s['tasks-empty-icon']}>📋</div>
              <p>No items in this sprint</p>
              <span>Assign tickets from the Backlog to this sprint.</span>
            </div>
          )}
        </>
      )}

      {/* ─── MY DAY TAB ─────────────────────────────────────── */}
      {activeTab === 'myday' && (
        <>
          {error && <div className="error-msg error-msg-mb">{error}</div>}
          <div className={s['myday-layout']}>

            {/* ─── Left: task list panel ─── */}
            <div className={s['myday-tasks-panel']}>

              {/* Progress row */}
              {tasks.length > 0 && !loading && (
                <div className={s['myday-progress-row']}>
                  <div className={s['myday-progress-track']}>
                    <div className={s['myday-progress-fill']} style={{ width: `${stats.percent}%` }} />
                  </div>
                  <span className={s['myday-progress-label']}>{stats.done}/{stats.total} done · {stats.percent}%</span>
                </div>
              )}

              {/* Task list */}
              {loading ? (
                <div className="loading-spinner"><div className="spinner" /></div>
              ) : tasks.length === 0 ? (
                <div className={s['myday-empty']}>
                  <div className={s['myday-empty-icon']}>☀️</div>
                  <p>Nothing planned for today yet</p>
                  <span>Add a task above or pull from your backlog</span>
                </div>
              ) : (
                <div className={s['myday-task-list']}>
                  {[...tasks].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] ?? 1) - ({ high: 0, medium: 1, low: 2 }[b.priority] ?? 1)).map(task => {
                    const pri = getPriority(task.priority);
                    const done = task.status === 'done';
                    return (
                      <div key={task.id} className={`${s['myday-task-item']} ${done ? s['myday-task-done'] : ''}`}>
                        <button
                          className={s['myday-check-btn']}
                          onClick={() => handleToggleDone(task)}
                          title={done ? 'Mark incomplete' : 'Mark done'}
                          style={{ color: done ? 'var(--success)' : 'var(--text-muted)' }}
                        >{done ? '●' : '○'}</button>
                        <div className={s['myday-task-body']} onClick={() => openTaskDetail(task)}>
                          <span className={s['myday-task-title']}>{task.title}</span>
                          {task.due_date && <span className={s['myday-task-due']}>📅 {task.due_date}</span>}
                          {task.labels && task.labels.length > 0 && task.labels.map(l => (
                            <span key={l.id} className={s['label-pill']} style={{ '--label-color': l.color }}>{l.name}</span>
                          ))}
                        </div>
                        <span style={{ color: pri.color, fontSize: '0.85rem' }} title={pri.label}>{pri.icon}</span>
                        <button className={s['myday-task-del']} onClick={() => handleDelete(task)} title="Delete">🗑</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ─── Right: Daily notes ─── */}
            <DailyNotes userId={currentUser?.id} />
          </div>
        </>
      )}


      {/* ─── BACKLOG TAB ──────────────────────────────────────────── */}
      {activeTab === 'backlog' && (
        <>
          {error && <div className="error-msg error-msg-mb">{error}</div>}

          {/* Backlog Summary Bar */}
          {!backlogLoading && backlogTasks.length > 0 && (
            <div className={s['backlog-summary']}>
              <button
                type="button"
                className={`${s['backlog-summary-chip']} ${s['chip-all']} ${summaryAllActive ? s['backlog-summary-chip-active'] : ''}`}
                onClick={handleSummaryTotal}
                aria-pressed={summaryAllActive}
              >
                <span className={s['backlog-summary-value']}>{backlogSummary.total || backlogTasks.length}</span>
                <span className={s['backlog-summary-text']}>Total</span>
              </button>

              <div className={s['backlog-summary-group']}>
                {PRIORITIES.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    className={`${s['backlog-summary-chip']} ${filterPriority === p.value ? s['backlog-summary-chip-active'] : ''}`}
                    onClick={() => handleSummaryPriority(p.value)}
                    aria-pressed={filterPriority === p.value}
                    style={{ '--chip-accent': p.color }}
                  >
                    <span className={s['backlog-summary-value']}>
                      {backlogSummary.byPriority?.[p.value] || 0}
                    </span>
                    <span className={s['backlog-summary-text']}>{p.icon} {p.label}</span>
                  </button>
                ))}
              </div>

            </div>
          )}

          {/* Sort + Controls Bar */}
          {!backlogLoading && backlogTasks.length > 0 && (
            <div className={s['backlog-toolbar']}>
              <div className={s['backlog-toolbar-left']}>
                <span className={s['backlog-toolbar-label']}>Sort by</span>
                <select
                  value={backlogSort}
                  onChange={e => setBacklogSort(e.target.value)}
                  className={s['backlog-sort-select']}
                >
                  <option value="priority">Priority</option>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="due_date">Due date</option>
                  <option value="title">Title A-Z</option>
                </select>
              </div>
              <span className={s['backlog-toolbar-count']}>
                {backlogTasks.length} ticket{backlogTasks.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          {/* Add Backlog Form */}
          {backlogFormOpen && (
            <div className={s['tasks-form-card']}>
              <div className={s['form-card-header']}>
                <h3>➕ New Backlog Ticket</h3>
                <button className={s['close-form-btn']} onClick={() => setBacklogFormOpen(false)} title="Close">✕</button>
              </div>
              <form onSubmit={handleAddBacklog} className={s['add-form']}>
                <div className="form-group">
                  <input
                    type="text"
                    value={backlogTitle}
                    onChange={(e) => setBacklogTitle(e.target.value)}
                    placeholder="Ticket title..."
                    required
                    autoFocus
                  />
                </div>
                <div className={`form-group ${s['quill-wrapper']}`}>
                  <ReactQuill
                    theme="snow"
                    value={backlogDesc}
                    onChange={setBacklogDesc}
                    placeholder="Description (optional)"
                  />
                </div>
                <div className={s['form-extras']}>
                  <div className={s['form-extra-group']}>
                    <label>👤 Assign to</label>
                    <select value={backlogAssignedTo} onChange={e => setBacklogAssignedTo(e.target.value)}>
                      <option value="">Unassigned</option>
                      {assignableUsers.map(u => (
                        <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                      ))}
                    </select>
                  </div>
                  <div className={s['form-extra-group']}>
                    <label>📅 Due date</label>
                    <input type="date" value={backlogDueDate} onChange={e => setBacklogDueDate(e.target.value)} />
                  </div>
                  <SprintSelector
                    sprints={availableSprints}
                    selected={backlogSprintId}
                    onChange={id => { setBacklogSprintId(id); if (!id) { setBacklogDueDate(''); } else { const sp = availableSprints.find(s => s.id === id); if (sp) setBacklogDueDate(sp.end_date); } }}
                  />
                  <LabelSelector
                    labels={orgLabels}
                    selected={backlogLabels}
                    onToggle={(id) => toggleLabel(id, backlogLabels, setBacklogLabels)}
                    open={backlogLabelDropdownOpen}
                    setOpen={setBacklogLabelDropdownOpen}
                  />
                </div>
                <div className={s['form-bottom']}>
                  <div className={s['priority-selector']}>
                    {PRIORITIES.map(p => (
                      <button
                        key={p.value}
                        type="button"
                        className={`${s['priority-btn']} ${backlogPriority === p.value ? s.active : ''}`}
                        style={{ '--pri-color': p.color }}
                        onClick={() => setBacklogPriority(p.value)}
                      >
                        {p.icon} {p.label}
                      </button>
                    ))}
                  </div>
                  <button type="submit" className="btn btn-primary">
                    Create Ticket
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Backlog List */}
          {backlogLoading ? (
            <div className="loading-spinner"><div className="spinner" /></div>
          ) : (
            <div className={s['backlog-list']}>
              {backlogTasks.length === 0 && (
                <div className={s['tasks-empty']}>
                  <div className={s['tasks-empty-icon']}>📦</div>
                  <p>Backlog is empty</p>
                  <span>Create a ticket to organize work that doesn't have a scheduled date yet.</span>
                </div>
              )}
              {sortedBacklogTasks.map(task => {
                const pri = getPriority(task.priority);
                const dueFmt = formatDueDate(task.due_date);
                const overdue = isDueOverdue(task.due_date) && task.status !== 'done';
                const colInfo = COLUMNS.find(c => c.id === task.status) || COLUMNS[0];
                const descPreview = stripHtml(task.description);

                return (
                  <div
                    key={task.id}
                    className={`${s['backlog-card']} ${s.clickable} ${task.status === 'done' ? s['backlog-card-done'] : ''}`}
                    onClick={(e) => {
                      if (e.target.closest(`.${s['backlog-actions']}`)) return;
                      openTaskDetail(task);
                    }}
                  >
                    <div className={s['backlog-priority-bar']} style={{ '--pri-color': pri.color }} />
                    <div className={s['backlog-card-body']}>
                      <div className={s['backlog-card-header']}>
                        <span className={s['backlog-ticket-id']}>#{task.id}</span>
                        <span
                          className={s['backlog-status-badge']}
                          style={{ '--badge-bg': colInfo.color + '20', '--badge-color': colInfo.color }}
                        >
                          {colInfo.icon} {colInfo.label}
                        </span>
                        <span
                          className={s['task-priority-badge']}
                          style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
                        >
                          {pri.icon} {pri.label}
                        </span>
                        {task.labels && task.labels.length > 0 && task.labels.map(l => (
                          <span key={l.id} className={s['label-pill']} style={{ '--label-color': l.color }}>
                            {l.name}
                          </span>
                        ))}
                      </div>
                      <span className={s['backlog-card-title']}>{task.title}</span>
                      {descPreview && (
                        <div className={s['backlog-desc-preview']}>{descPreview}</div>
                      )}
                      <div className={s['backlog-card-footer']}>
                        {task.assignee && (
                          <span className={s['backlog-meta-chip']}>
                            {task.assignee.avatar ? (
                              <img src={getAvatarUrl(task.assignee.avatar)} alt="" className={s['backlog-meta-avatar']} />
                            ) : (
                              <span className={s['backlog-meta-avatar-placeholder']}>
                                {(task.assignee.full_name || task.assignee.username || '?')[0].toUpperCase()}
                              </span>
                            )}
                            {task.assignee.full_name || task.assignee.username}
                          </span>
                        )}
                        {dueFmt && (
                          <span className={`${s['backlog-meta-chip']} ${overdue ? s['overdue'] : ''}`}>
                            📅 {dueFmt}
                          </span>
                        )}
                        {task.comment_count > 0 && (
                          <span className={s['backlog-meta-chip']}>💬 {task.comment_count}</span>
                        )}
                        <span className={s['backlog-meta-time']}>{formatRelativeTime(task.created_at)}</span>
                        <div className={s['backlog-actions']}>
                          {scheduleTaskId === task.id ? (
                            <div className={s['schedule-popover']}>
                              <input
                                type="date"
                                value={scheduleDate}
                                onChange={e => setScheduleDate(e.target.value)}
                                className={s['date-input']}
                              />
                              <button className="btn btn-primary btn-sm" onClick={() => handleScheduleTask(task.id, task.title)}>
                                Go
                              </button>
                              <button className="btn btn-secondary btn-sm" onClick={() => setScheduleTaskId(null)}>
                                ✕
                              </button>
                            </div>
                          ) : (
                            <button
                              className={s['backlog-action-btn']}
                              onClick={() => { setScheduleTaskId(task.id); setScheduleDate(getLocalToday()); }}
                              title="Schedule to a day"
                            >
                              📅 Schedule
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {renderCommentPanel()}
      {renderTaskDetailModal()}

      <ConfirmDialog
        isOpen={!!taskToDelete}
        title="Delete Item"
        message={`Are you sure you want to delete "${taskToDelete?.title}"? This cannot be undone.`}
        confirmText="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setTaskToDelete(null)}
      />

      <ConfirmDialog
        isOpen={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText={confirmDialog.confirmText}
        isDanger={confirmDialog.isDanger}
        onConfirm={() => { if (confirmDialog.onConfirm) confirmDialog.onConfirm(); }}
        onCancel={closeConfirm}
      />
    </div>
  );

  function renderCard(task) {
    const pri = getPriority(task.priority);
    const dueFmt = formatDueDate(task.due_date);
    const overdue = isDueOverdue(task.due_date) && task.status !== 'done';

    return (
      <div
        key={task.id}
        id={`task-${task.id}`}
        className={`${s['task-card']} ${s.clickable} ${task.status === 'done' ? s['task-done'] : ''}`}
        draggable
        onDragStart={(e) => onDragStart(e, task.id)}
        onDragEnd={(e) => onDragEnd(e, task.id)}
        onClick={(e) => {
          // Don't open detail if clicking action buttons
          if (e.target.closest(`.${s['task-actions']}`) || e.target.closest(`.${s['task-action-btn']}`) || e.target.closest(`.${s['comment-icon']}`)) return;
          openTaskDetail(task);
        }}
      >
        <div className={s['task-card-top']}>
          <span
            className={s['task-priority-badge']}
            style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
          >
            {pri.icon} {pri.label}
          </span>
          <div className={s['task-actions']}>
            <span className={s['comment-icon']} onClick={() => openComments(task.id)} title="Comments">
              💬{task.comment_count > 0 && <span className={s['comment-badge']}>{task.comment_count}</span>}
            </span>
          </div>
        </div>
        <div className={s['task-title-row']}>
          <div className={s['task-title']}>{task.title}</div>
          {task.labels && task.labels.length > 0 && (
            <div className={s['task-labels']}>
              {task.labels.map(l => (
                <span key={l.id} className={s['label-pill']} style={{ '--label-color': l.color }}>
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {task.description && (
          <HighlightedHtml html={task.description} className={s['task-desc']} />
        )}

        <div className={s['task-card-footer']}>
          <div className={s['task-meta']}>
            {task.assignee && (
              <span className={s['task-assignee']} title={`Assigned to ${task.assignee.full_name || task.assignee.username}`}>
                👤 {task.assignee.full_name || task.assignee.username}
              </span>
            )}
            {task.creator && task.assigned_to && task.user_id !== task.assigned_to && (
              <span className={s['task-creator']} title={`Created by ${task.creator.full_name || task.creator.username}`}>
                ✍️ {task.creator.full_name || task.creator.username}
              </span>
            )}
            {dueFmt && (
              <span className={`${s['task-due']} ${overdue ? s['overdue'] : ''}`}>
                📅 {dueFmt}
              </span>
            )}
          </div>
          <span className={s['drag-hint']}>⠿ drag to move</span>
        </div>
      </div>
    );
  }

  function renderTaskDetailModal() {
    if (!detailTask) return null;
    const pri = getPriority(detailTask.priority);
    const colInfo = COLUMNS.find(c => c.id === detailTask.status) || COLUMNS[0];
    const dueFmt = formatDueDate(detailTask.due_date);
    const overdue = isDueOverdue(detailTask.due_date) && detailTask.status !== 'done';
    const isBacklogItem = !detailTask.date;

    return (
      <div className={s['detail-overlay']} onClick={closeTaskDetail}>
        <div className={s['detail-modal']} onClick={e => e.stopPropagation()}>
          <div className={s['detail-modal-header']}>
            <div className={s['detail-badges']}>
              <span
                className={s['task-priority-badge']}
                style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
              >
                {pri.icon} {pri.label}
              </span>
              <span
                className={s['backlog-status-badge']}
                style={{ '--badge-bg': colInfo.color + '20', '--badge-color': colInfo.color }}
              >
                {colInfo.icon} {colInfo.label}
              </span>
              {isBacklogItem && <span className={s['backlog-badge']}>📦 Backlog</span>}
              {detailTask.date && <span className={s['detail-date-badge']}>📅 {detailTask.date}</span>}
            </div>
            <div className={s['detail-header-actions']}>
              {!detailEditing && (
                <>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => startDetailEdit(detailTask)}
                  >
                    ✏️ Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDelete(detailTask)}
                  >
                    🗑 Delete
                  </button>
                </>
              )}
              <button className={s['close-form-btn']} onClick={closeTaskDetail}>✕</button>
            </div>
          </div>

          <div className={s['detail-modal-body']}>
            {/* ─── EDIT MODE ──────────────────────────── */}
            {detailEditing ? (
              <>
                <div className={s['detail-edit-section']}>
                  <div className="form-group">
                    <label>Title</label>
                    <input
                      type="text"
                      value={detailEditTitle}
                      onChange={e => setDetailEditTitle(e.target.value)}
                      className={s['task-edit-input']}
                      autoFocus
                    />
                  </div>
                  <div className={`form-group ${s['quill-wrapper']}`}>
                    <label>Description</label>
                    <ReactQuill theme="snow" value={detailEditDesc} onChange={setDetailEditDesc} placeholder="Description" />
                  </div>
                  <div className={s['form-extras']}>
                    <div className={s['form-extra-group']}>
                      <label>Priority</label>
                      <select value={detailEditPriority} onChange={e => setDetailEditPriority(e.target.value)}>
                        {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.icon} {p.label}</option>)}
                      </select>
                    </div>
                    <div className={s['form-extra-group']}>
                      <label>Assign to</label>
                      <select value={detailEditAssignedTo} onChange={e => setDetailEditAssignedTo(e.target.value)}>
                        <option value="">Unassigned</option>
                        {assignableUsers.map(u => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
                      </select>
                    </div>
                    <div className={s['form-extra-group']}>
                      <label>Due date</label>
                      <input type="date" value={detailEditDueDate} onChange={e => setDetailEditDueDate(e.target.value)} />
                    </div>
                    <SprintSelector
                      sprints={availableSprints}
                      selected={detailEditSprintId}
                      onChange={id => { setDetailEditSprintId(id); if (!id) { setDetailEditDueDate(''); } else { const sp = availableSprints.find(s => s.id === id); if (sp) setDetailEditDueDate(sp.end_date); } }}
                    />
                    <LabelSelector
                      labels={orgLabels}
                      selected={detailEditLabels}
                      onToggle={(id) => toggleLabel(id, detailEditLabels, setDetailEditLabels)}
                      open={detailEditLabelDropdownOpen}
                      setOpen={setDetailEditLabelDropdownOpen}
                    />
                  </div>
                  <div className={s['detail-edit-buttons']}>
                    {isBacklogItem ? (
                      <div className={s['detail-schedule-row']}>
                        <input
                          type="date"
                          value={scheduleDate}
                          onChange={e => setScheduleDate(e.target.value)}
                          className={s['date-input']}
                        />
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleScheduleTask(detailTask.id, detailTask.title, closeTaskDetail)}
                        >
                          📅 Schedule to Day
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleUnscheduleTask(detailTask.id, detailTask.title, closeTaskDetail)}
                      >
                        📦 Move to Backlog
                      </button>
                    )}
                    <button className="btn btn-primary btn-sm" onClick={saveDetailEdit}>💾 Save Changes</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setDetailEditing(false)}>Cancel</button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* ─── VIEW MODE ──────────────────────────── */}
                <div className={s['detail-title-row']}>
                  <span className={s['backlog-ticket-id']}>#{detailTask.id}</span>
                  <h2 className={s['detail-title']}>{detailTask.title}</h2>
                  {/* Labels */}
                  {detailTask.labels && detailTask.labels.length > 0 && (
                    <div className={s['detail-labels']}>
                      {detailTask.labels.map(l => (
                        <span key={l.id} className={s['label-pill']} style={{ '--label-color': l.color }}>
                          {l.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {detailTask.description && (
                  <HighlightedHtml html={detailTask.description} className={s['detail-description']} />
                )}

                {/* Meta info */}
                <div className={s['detail-meta-grid']}>
                  {detailTask.assignee && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Assigned to</span>
                      <span className={s['detail-meta-value']}>
                        {detailTask.assignee.avatar ? (
                          <img src={getAvatarUrl(detailTask.assignee.avatar)} alt="" className={s['detail-avatar']} />
                        ) : (
                          <span className={s['detail-avatar-placeholder']}>
                            {(detailTask.assignee.full_name || detailTask.assignee.username || '?')[0].toUpperCase()}
                          </span>
                        )}
                        {detailTask.assignee.full_name || detailTask.assignee.username}
                      </span>
                    </div>
                  )}
                  {detailTask.creator && detailTask.assigned_to && detailTask.user_id !== detailTask.assigned_to && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Created by</span>
                      <span className={s['detail-meta-value']}>
                        {detailTask.creator.avatar ? (
                          <img src={getAvatarUrl(detailTask.creator.avatar)} alt="" className={s['detail-avatar']} />
                        ) : (
                          <span className={s['detail-avatar-placeholder']}>
                            {(detailTask.creator.full_name || detailTask.creator.username || '?')[0].toUpperCase()}
                          </span>
                        )}
                        {detailTask.creator.full_name || detailTask.creator.username}
                      </span>
                    </div>
                  )}
                  {dueFmt && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Due date</span>
                      <span className={`${s['detail-meta-value']} ${overdue ? s['overdue'] : ''}`}>
                        📅 {dueFmt}
                      </span>
                    </div>
                  )}
                  {detailTask.created_at && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Created</span>
                      <span className={s['detail-meta-value']}>{new Date(detailTask.created_at + 'Z').toLocaleString()}</span>
                    </div>
                  )}
                  {detailTask.completed_at && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Completed</span>
                      <span className={s['detail-meta-value']}>{new Date(detailTask.completed_at + 'Z').toLocaleString()}</span>
                    </div>
                  )}
                  {detailTask.sprint_id && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Sprint</span>
                      <span className={s['detail-meta-value']}>
                        🏃 {availableSprints.find(sp => sp.id === detailTask.sprint_id)?.name || `Sprint #${detailTask.sprint_id}`}
                      </span>
                    </div>
                  )}
                </div>

                {/* Status change buttons — only for sprint tickets */}
                {detailTask.sprint_id && (
                <div className={s['detail-status-bar']}>
                  <span className={s['detail-status-label']}>Move to:</span>
                  {COLUMNS.map(col => (
                    <button
                      key={col.id}
                      className={`${s['detail-status-btn']} ${detailTask.status === col.id ? s['detail-status-active'] : ''}`}
                      style={{ '--col-color': col.color }}
                      disabled={detailTask.status === col.id}
                      onClick={() => {
                        showConfirm(
                          'Change Status',
                          `Change status of "${detailTask.title}" to ${col.label}?`,
                          async () => {
                            closeConfirm();
                            try {
                              await updateTaskStatus(detailTask.id, col.id);
                              setDetailTask(prev => ({ ...prev, status: col.id }));
                              refreshDetailHistory(detailTask.id);
                              fetchTasks();
                              if (backlogOpen || activeTab === 'backlog') fetchBacklog();
                            } catch {
                              setError('Failed to update status');
                            }
                          },
                          { confirmText: 'Move' }
                        );
                      }}
                    >
                      {col.icon} {col.label}
                    </button>
                  ))}
                </div>
                )}

              </>
            )}

            {/* Comments & History Tabs */}
            <div className={s['detail-comments']}>
              <div className={s['detail-tab-switcher']}>
                <button
                  className={`${s['detail-tab-btn']} ${detailTab === 'comments' ? s.active : ''}`}
                  onClick={() => setDetailTab('comments')}
                >
                  💬 Comments <span className={s['detail-tab-count']}>{detailComments.length}</span>
                </button>
                <button
                  className={`${s['detail-tab-btn']} ${detailTab === 'history' ? s.active : ''}`}
                  onClick={() => setDetailTab('history')}
                >
                  📜 History <span className={s['detail-tab-count']}>{detailHistory.length}</span>
                </button>
              </div>

              {detailTab === 'comments' && (
                <CommentSection
                  comments={detailComments}
                  loading={detailLoading}
                  currentUserId={currentUser?.id}
                  users={assignableUsers}
                  onAdd={async (content) => {
                    try {
                      const res = await addTaskComment(detailTask.id, content);
                      setDetailComments(prev => [...prev, res.data]);
                      setTasks(prev => prev.map(t => t.id === detailTask.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
                      setBacklogTasks(prev => prev.map(t => t.id === detailTask.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
                    } catch { setError('Failed to add comment'); }
                  }}
                  onEdit={async (commentId, content) => {
                    try {
                      const res = await updateTaskComment(detailTask.id, commentId, content);
                      setDetailComments(prev => prev.map(c => c.id === commentId ? res.data : c));
                    } catch { setError('Failed to update comment'); }
                  }}
                  onDelete={(commentId) => handleDetailDeleteComment(commentId)}
                />
              )}

              {detailTab === 'history' && (
                <div className={s['history-list']}>
                  {detailHistory.length === 0 && (
                    <div className={s['history-empty']}>No history recorded yet.</div>
                  )}
                  {detailHistory.map(h => {
                    const actionIcons = {
                      created: '✨', status_change: '🔄', updated: '✏️',
                      scheduled: '📅', unscheduled: '📦', comment_added: '💬',
                      deleted: '🗑️',
                    };
                    const fieldLabels = {
                      status: 'status', title: 'title', description: 'description',
                      priority: 'priority', assigned_to: 'assignee', due_date: 'due date',
                      date: 'schedule', labels: 'labels',
                    };
                    const actionText = () => {
                      if (h.action === 'created') {
                        if (h.field === 'date' && h.old_value) return <>carried forward from <span className={s['history-old']}>{h.old_value}</span></>;
                        return 'created this task';
                      }
                      if (h.action === 'comment_added') return 'added a comment';
                      if (h.action === 'status_change') return <>changed status from <span className={s['history-old']}>{h.old_value}</span> → <span className={s['history-new']}>{h.new_value}</span></>;
                      if (h.action === 'scheduled') return <>scheduled to <span className={s['history-new']}>{h.new_value}</span></>;
                      if (h.action === 'unscheduled') return 'moved to backlog';
                      if (h.action === 'updated' && h.field) {
                        const label = fieldLabels[h.field] || h.field;
                        if (h.field === 'description') return `updated ${label}`;
                        return <>{`updated ${label}: `}<span className={s['history-old']}>{h.old_value || '—'}</span>{' → '}<span className={s['history-new']}>{h.new_value || '—'}</span></>;
                      }
                      return h.action;
                    };
                    return (
                      <div key={h.id} className={s['history-item']}>
                        <span className={s['history-icon']}>{actionIcons[h.action] || '📝'}</span>
                        <div className={s['history-content']}>
                          <span className={s['history-actor']}>{h.full_name || h.username}</span>{' '}
                          <span className={s['history-action']}>{actionText()}</span>
                        </div>
                        <span className={s['history-time']}>{new Date(h.created_at + 'Z').toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
