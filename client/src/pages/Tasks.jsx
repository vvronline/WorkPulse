import React, { useState, useEffect, useCallback } from 'react';
import { getTasks, addTask, updateTaskStatus, updateTask, deleteTask, carryForwardTasks, getLocalToday } from '../api';
import s from './Tasks.module.css';

const PRIORITIES = [
  { value: 'high', label: 'High', icon: '🔴', color: '#ef4444' },
  { value: 'medium', label: 'Medium', icon: '🟡', color: '#f59e0b' },
  { value: 'low', label: 'Low', icon: '🟢', color: '#22c55e' },
];

const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  done: '●',
};

const STATUS_LABELS = {
  pending: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
};

const NEXT_STATUS = {
  pending: 'in_progress',
  in_progress: 'done',
  done: 'pending',
};

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

  const handleStatusToggle = async (task) => {
    try {
      await updateTaskStatus(task.id, NEXT_STATUS[task.status]);
      fetchTasks();
    } catch {
      setError('Failed to update status');
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

  const handleCarryForward = async () => {
    try {
      const res = await carryForwardTasks();
      if (res.data.carried > 0) {
        fetchTasks();
      }
      setError('');
      alert(res.data.message);
    } catch {
      setError('Failed to carry forward tasks');
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

  const isToday = date === getLocalToday();
  const getPriority = (p) => PRIORITIES.find(pr => pr.value === p) || PRIORITIES[1];

  const pendingTasks = tasks.filter(t => t.status === 'pending');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
  const doneTasks = tasks.filter(t => t.status === 'done');

  return (
    <div className={s['tasks-page']}>
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
          {isToday && (
            <button className="btn btn-secondary" onClick={handleCarryForward} title="Copy yesterday's incomplete tasks to today">
              📥 Carry Forward
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className={s['tasks-progress-card']}>
        <div className={s['tasks-progress-info']}>
          <span className={s['tasks-progress-label']}>
            {stats.done}/{stats.total} completed
          </span>
          <span className={s['tasks-progress-pct']}>{stats.percent}%</span>
        </div>
        <div className={s['tasks-progress-bar']}>
          <div className={s['tasks-progress-fill']} style={{ '--fill-width': `${stats.percent}%` }} />
        </div>
        <div className={s['tasks-progress-counts']}>
          <span>○ {stats.total - stats.done - stats.inProgress} to do</span>
          <span>◐ {stats.inProgress} in progress</span>
          <span>● {stats.done} done</span>
        </div>
      </div>

      {error && <div className="error-msg error-msg-mb">{error}</div>}

      <div className={s['tasks-layout']}>
        {/* Add Task Form */}
        <div className={s['tasks-form-card']}>
          <h3>➕ New Task</h3>
          <form onSubmit={handleAdd}>
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
            <div className="form-group">
              <label>Priority</label>
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
            </div>
            <button type="submit" className="btn btn-primary btn-fullwidth">
              Add Task
            </button>
          </form>
        </div>

        {/* Task Lists */}
        <div className={s['tasks-lists']}>
          {loading ? (
            <div className="loading-spinner"><div className="spinner"></div></div>
          ) : tasks.length === 0 ? (
            <div className={s['tasks-empty']}>
              <div className={s['tasks-empty-icon']}>📋</div>
              <p>No tasks for this day</p>
              <span>Add a task to get started!</span>
            </div>
          ) : (
            <>
              {inProgressTasks.length > 0 && (
                <div className={s['task-section']}>
                  <h4 className={s['task-section-title']}>
                    <span className={`${s['task-section-dot']} ${s.in_progress}`} /> In Progress ({inProgressTasks.length})
                  </h4>
                  {inProgressTasks.map(task => renderTask(task))}
                </div>
              )}
              {pendingTasks.length > 0 && (
                <div className={s['task-section']}>
                  <h4 className={s['task-section-title']}>
                    <span className={`${s['task-section-dot']} ${s.pending}`} /> To Do ({pendingTasks.length})
                  </h4>
                  {pendingTasks.map(task => renderTask(task))}
                </div>
              )}
              {doneTasks.length > 0 && (
                <div className={s['task-section']}>
                  <h4 className={s['task-section-title']}>
                    <span className={`${s['task-section-dot']} ${s.done}`} /> Done ({doneTasks.length})
                  </h4>
                  {doneTasks.map(task => renderTask(task))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  function renderTask(task) {
    const pri = getPriority(task.priority);
    const isDone = task.status === 'done';

    if (editingId === task.id) {
      return (
        <div key={task.id} className={`${s['task-item']} ${s.editing}`}>
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
      <div key={task.id} className={`${s['task-item']} ${isDone ? s['task-done'] : ''}`}>
        <button
          className={`${s['task-status-btn']} ${s[task.status]}`}
          onClick={() => handleStatusToggle(task)}
          title={`Click: ${STATUS_LABELS[NEXT_STATUS[task.status]]}`}
        >
          {STATUS_ICONS[task.status]}
        </button>
        <div className={s['task-content']}>
          <div className={s['task-title']}>{task.title}</div>
          {task.description && <div className={s['task-desc']}>{task.description}</div>}
        </div>
        <span className={s['task-priority-badge']} style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}>
          {pri.icon} {pri.label}
        </span>
        <div className={s['task-actions']}>
          <button className={s['task-action-btn']} onClick={() => startEdit(task)} title="Edit">✏️</button>
          <button className={`${s['task-action-btn']} ${s['delete-btn']}`} onClick={() => handleDelete(task.id)} title="Delete">🗑</button>
        </div>
      </div>
    );
  }
}
