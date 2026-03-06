import React from 'react';
import DailyNotes from '../../components/DailyNotes';
import { PRIORITIES } from './constants.js';
import s from './MyDayPanel.module.css';

function getPriority(p) {
  return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}

export default function MyDayPanel({
  tasks,
  loading,
  stats,
  currentUser,
  error,
  onOpenDetail,
  onToggleDone,
  onDelete,
}) {
  return (
    <>
      {error && <div className="error-msg error-msg-mb">{error}</div>}
      <div className={s['myday-layout']}>
        {/* Left: task list */}
        <div className={s['myday-tasks-panel']}>
          {tasks.length > 0 && !loading && (
            <div className={s['myday-progress-row']}>
              <div className={s['myday-progress-track']}>
                <div
                  className={s['myday-progress-fill']}
                  style={{ width: `${stats.percent}%` }}
                />
              </div>
              <span className={s['myday-progress-label']}>
                {stats.done}/{stats.total} done · {stats.percent}%
              </span>
            </div>
          )}

          {loading ? (
            <div className="loading-spinner">
              <div className="spinner" />
            </div>
          ) : tasks.length === 0 ? (
            <div className={s['myday-empty']}>
              <div className={s['myday-empty-icon']}>☀️</div>
              <p>Nothing planned for today yet</p>
              <span>Add a task above or pull from your backlog</span>
            </div>
          ) : (
            <div className={s['myday-task-list']}>
              {[...tasks]
                .sort(
                  (a, b) =>
                    ({ high: 0, medium: 1, low: 2 }[a.priority] ?? 1) -
                    ({ high: 0, medium: 1, low: 2 }[b.priority] ?? 1)
                )
                .map((task) => {
                  const pri = getPriority(task.priority);
                  const done = task.status === 'done';
                  return (
                    <div
                      key={task.id}
                      className={`${s['myday-task-item']} ${done ? s['myday-task-done'] : ''}`}
                    >
                      <button
                        className={s['myday-check-btn']}
                        onClick={() => onToggleDone(task)}
                        title={done ? 'Mark incomplete' : 'Mark done'}
                        style={{ color: done ? 'var(--success)' : 'var(--text-muted)' }}
                      >
                        {done ? '●' : '○'}
                      </button>
                      <div
                        className={s['myday-task-body']}
                        onClick={() => onOpenDetail(task)}
                      >
                        <span className={s['myday-task-title']}>{task.title}</span>
                        {task.due_date && (
                          <span className={s['myday-task-due']}>📅 {task.due_date}</span>
                        )}
                        {task.labels &&
                          task.labels.length > 0 &&
                          task.labels.map((l) => (
                            <span
                              key={l.id}
                              className={s['label-pill']}
                              style={{ '--label-color': l.color }}
                            >
                              {l.name}
                            </span>
                          ))}
                      </div>
                      <span
                        style={{ color: pri.color, fontSize: '0.85rem' }}
                        title={pri.label}
                      >
                        {pri.icon}
                      </span>
                      {currentUser?.id === task.user_id && (
                        <button
                          className={s['myday-task-del']}
                          onClick={() => onDelete(task)}
                          title="Delete"
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Right: Daily notes */}
        <DailyNotes userId={currentUser?.id} />
      </div>
    </>
  );
}
