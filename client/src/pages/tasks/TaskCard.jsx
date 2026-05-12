import React from 'react';
import { HighlightedHtml, formatDueDate, isDueOverdue } from './utils.jsx';
import { PRIORITIES } from './constants.js';
import { User, CalendarDays, PenLine } from 'lucide-react';
import { StoryPointBadge, WorkItemTypeBadge, BlockerBadge } from '../../components/agile/AgilePickers.jsx';
import s from './TaskCard.module.css';

function getPriority(p) {
  return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}

export default function TaskCard({ task, sprintMode, onOpenDetail, onOpenComments, onDragStart, onDragEnd }) {
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
        if (
          e.target.closest(`.${s['task-actions']}`) ||
          e.target.closest(`.${s['task-action-btn']}`) ||
          e.target.closest(`.${s['comment-icon']}`)
        )
          return;
        onOpenDetail(task);
      }}
    >
      <div className={s['task-card-top']}>
        <div className={s['task-card-top-left']}>
          <WorkItemTypeBadge value={task.work_item_type_id || task.work_item_type_key} />
          <span
            className={s['task-priority-badge']}
            style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
          >
            {pri.icon} {pri.label}
          </span>
          <StoryPointBadge value={task.story_points} />
          <BlockerBadge task={task} />
        </div>
        <div className={s['task-actions']}>
          <span
            className={s['comment-icon']}
            onClick={() => onOpenComments(task.id)}
            title="Comments"
          >
            💬
            {task.comment_count > 0 && (
              <span className={s['comment-badge']}>{task.comment_count}</span>
            )}
          </span>
        </div>
      </div>

      <div className={s['task-title-row']}>
        <div className={s['task-title']}>{task.title}</div>
        {task.labels && task.labels.length > 0 && (
          <div className={s['task-labels']}>
            {task.labels.map((l) => (
              <span
                key={l.id}
                className={s['label-pill']}
                style={{ '--label-color': l.color }}
              >
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
            <span
              className={s['task-assignee']}
              title={`Assigned to ${task.assignee.full_name || task.assignee.username}`}
            >
              <User size={12} style={{marginRight:3,verticalAlign:'middle'}} />{task.assignee.full_name || task.assignee.username}
            </span>
          )}
          {task.creator && task.assigned_to && task.user_id !== task.assigned_to && (
            <span
              className={s['task-creator']}
              title={`Created by ${task.creator.full_name || task.creator.username}`}
            >
              <PenLine size={12} style={{marginRight:3,verticalAlign:'middle'}} />{task.creator.full_name || task.creator.username}
            </span>
          )}
          {dueFmt && (
            <span className={`${s['task-due']} ${overdue ? s['overdue'] : ''}`}>
              <CalendarDays size={12} style={{marginRight:3,verticalAlign:'middle'}} />{dueFmt}
            </span>
          )}
        </div>
        <span className={s['drag-hint']}>⠿ drag to move</span>
      </div>
    </div>
  );
}
