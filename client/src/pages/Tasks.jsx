import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getTasks, addTask, updateTaskStatus, updateTask, deleteTask, carryForwardTasks, getLocalToday } from '../api';
import s from './Tasks.module.css';

const PRIORITIES = [
  { value: 'high', label: 'High', icon: '🔴', color: '#ef4444' },
  { value: 'medium', label: 'Medium', icon: '🟡', color: '#f59e0b' },
  { value: 'low', label: 'Low', icon: '🟢', color: '#22c55e' },
];

const COLUMNS = [
  { id: 'pending', label: 'To Do', icon: '○', color: '#64748b' },
  { id: 'in_progress', label: 'In Progress', icon: '◐', color: '#f59e0b' },
  { id: 'in_review', label: 'In Review', icon: '◑', color: '#6366f1' },
  { id: 'done', label: 'Done', icon: '●', color: '#22c55e' },
];

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState({ total: 0, done: 0, inProgress: 0, percent: 0 });
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => getLocalToday());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [dragOverCol, setDragOverCol] = useState(null);
  const [formOpen, setFormOpen] = useState(true);
  const [carriedCount, setCarriedCount] = useState(0);
  const dragTaskId = useRef(null);
  const autoCarriedRef = useRef(false);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await getTasks(date);
      setTasks(res.data.tasks);
      setStats(res.data.stats);
      setError('');
    } catch {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [fetchTasks]);

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
      .catch(() => { }); // silent — don't surface errors for auto action
  }, [date, fetchTasks]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await addTask({ title, description, priority, date });
      setTitle('');
      setDescription('');
      setPriority('medium');
      fetchTasks();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add task');
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteTask(id);
      fetchTasks();
    } catch {
      setError('Failed to delete task');
    }
  };



  const startEdit = (task) => {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditDesc(task.description || '');
  };

  const saveEdit = async (id) => {
    try {
      await updateTask(id, { title: editTitle, description: editDesc });
      setEditingId(null);
      fetchTasks();
    } catch {
      setError('Failed to update task');
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
    setEditDesc('');
  };

  // ─── Drag & Drop handlers ────────────────────────────────────────────────
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
    // Only clear if leaving the column entirely, not just a child element
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverCol(null);
    }
  };

  const onDrop = async (e, colId) => {
    e.preventDefault();
    setDragOverCol(null);
    // Read from dataTransfer first (more reliable cross-column), fallback to ref
    const rawId = e.dataTransfer.getData('text/plain');
    const taskId = rawId ? parseInt(rawId, 10) : dragTaskId.current;
    dragTaskId.current = null;
    if (!taskId) return;

    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === colId) return;

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: colId } : t));

    try {
      await updateTaskStatus(taskId, colId);
      fetchTasks();
    } catch {
      setError('Failed to move task');
      fetchTasks();
    }
  };

  const isToday = date === getLocalToday();
  const getPriority = (p) => PRIORITIES.find(pr => pr.value === p) || PRIORITIES[1];
  const getColTasks = (colId) => tasks.filter(t => t.status === colId);

  return (
    <div className={s['tasks-page']}>
      {/* Header */}
      <div className={s['tasks-header']}>
        <div>
          <h2><span className="page-icon">✅</span> Daily Tasks</h2>
          <p>Plan and track your daily work</p>
        </div>
        <div className={s['tasks-header-actions']}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={s['date-input']}
          />
          <button
            className={`btn btn-secondary ${s['add-task-toggle']}`}
            onClick={() => setFormOpen(o => !o)}
          >
            {formOpen ? '✕ Close' : '➕ New Task'}
          </button>
        </div>
      </div>

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
          📥 {carriedCount} incomplete task{carriedCount > 1 ? 's' : ''} from yesterday carried forward automatically.
        </div>
      )}
      {error && <div className="error-msg error-msg-mb">{error}</div>}

      {/* Add Task Form (collapsible) */}
      {formOpen && (
        <div className={s['tasks-form-card']}>
          <h3>➕ New Task</h3>
          <form onSubmit={handleAdd} className={s['add-form']}>
            <div className="form-group">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Details (optional)"
                rows={2}
              />
            </div>
            <div className={s['form-bottom']}>
              <div className={s['priority-selector']}>
                {PRIORITIES.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    className={`${s['priority-btn']} ${priority === p.value ? s.active : ''}`}
                    style={{ '--pri-color': p.color }}
                    onClick={() => setPriority(p.value)}
                  >
                    {p.icon} {p.label}
                  </button>
                ))}
              </div>
              <button type="submit" className="btn btn-primary">
                Add Task
              </button>
            </div>
          </form>
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
                {/* Column Header */}
                <div className={s['column-header']}>
                  <div className={s['column-header-left']}>
                    <span className={s['column-dot']} style={{ background: col.color }} />
                    <span className={s['column-label']}>{col.label}</span>
                  </div>
                  <span className={s['column-count']}>{colTasks.length}</span>
                </div>

                {/* Drop zone visual hint */}
                {isDragOver && (
                  <div className={s['drop-indicator']}>
                    Drop here
                  </div>
                )}

                {/* Task Cards */}
                <div className={s['column-tasks']}>
                  {colTasks.length === 0 && !isDragOver && (
                    <div className={s['column-empty']}>
                      <span>No tasks</span>
                    </div>
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
          <p>No tasks for this day</p>
          <span>Add a task above to get started!</span>
        </div>
      )}
    </div>
  );

  function renderCard(task, col) {
    const pri = getPriority(task.priority);

    if (editingId === task.id) {
      return (
        <div key={task.id} className={`${s['task-card']} ${s.editing}`}>
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className={s['task-edit-input']}
            autoFocus
          />
          <textarea
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            className={s['task-edit-textarea']}
            placeholder="Description"
            rows={2}
          />
          <div className={s['task-edit-actions']}>
            <button className="btn btn-primary btn-sm" onClick={() => saveEdit(task.id)}>Save</button>
            <button className="btn btn-secondary btn-sm" onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={task.id}
        id={`task-${task.id}`}
        className={`${s['task-card']} ${task.status === 'done' ? s['task-done'] : ''}`}
        draggable
        onDragStart={(e) => onDragStart(e, task.id)}
        onDragEnd={(e) => onDragEnd(e, task.id)}
      >
        <div className={s['task-card-top']}>
          <span
            className={s['task-priority-badge']}
            style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
          >
            {pri.icon} {pri.label}
          </span>
          <div className={s['task-actions']}>
            <button className={s['task-action-btn']} onClick={() => startEdit(task)} title="Edit">✏️</button>
            <button
              className={`${s['task-action-btn']} ${s['delete-btn']}`}
              onClick={() => handleDelete(task.id)}
              title="Delete"
            >🗑</button>
          </div>
        </div>
        <div className={s['task-title']}>{task.title}</div>
        {task.description && <div className={s['task-desc']}>{task.description}</div>}
        <div className={s['task-card-footer']}>
          <span className={s['drag-hint']}>⠿ drag to move</span>
        </div>
      </div>
    );
  }
}
