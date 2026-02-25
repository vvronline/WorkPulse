import React, { memo } from 'react';
import s from './TasksSummary.module.css';

const TasksSummary = memo(function TasksSummary({ taskSummary }) {
  if (!taskSummary || taskSummary.total === 0) return null;

  return (
    <div className={`status-card ${s['tasks-summary-card']}`}>
      <h3 className={s['timeline-title']}>
        <span className="page-icon">✅</span> Today's Tasks
      </h3>
      <div className={s['tasks-summary-stats']}>
        <div className={`${s['task-stat']} ${s['done-stat']}`}>
          <span className={s['task-stat-num']}>{taskSummary.done}</span>
          <span className={s['task-stat-label']}>Done</span>
        </div>
        <div className={`${s['task-stat']} ${s['progress-stat']}`}>
          <span className={s['task-stat-num']}>{taskSummary.inProgress}</span>
          <span className={s['task-stat-label']}>In Progress</span>
        </div>
        <div className={`${s['task-stat']} ${s['pending-stat']}`}>
          <span className={s['task-stat-num']}>{taskSummary.pending}</span>
          <span className={s['task-stat-label']}>Pending</span>
        </div>
      </div>
      <div className={s['task-progress-bar']}>
        <div className={`${s['task-progress-fill']} ${s['done-fill']}`} style={{ '--fill-width': `${(taskSummary.done / taskSummary.total) * 100}%` }} />
        <div className={`${s['task-progress-fill']} ${s['progress-fill']}`} style={{ '--fill-width': `${(taskSummary.inProgress / taskSummary.total) * 100}%` }} />
      </div>
      {taskSummary.nextTask && (
        <div className={s['next-task']}>
          <span className={s['next-task-label']}>Next:</span>
          <span className={s['next-task-title']}>{taskSummary.nextTask.title}</span>
          <span className={`${s['next-task-priority']} ${s[taskSummary.nextTask.priority]}`}>{taskSummary.nextTask.priority}</span>
        </div>
      )}
    </div>
  );
});

export default TasksSummary;
