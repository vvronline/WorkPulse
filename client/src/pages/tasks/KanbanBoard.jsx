import React from 'react';
import TaskCard from './TaskCard.jsx';
import { useAgileConfig } from '../../AgileConfigContext';
import s from './KanbanBoard.module.css';

export default function KanbanBoard({
  tasks,
  dragOverCol,
  sprintMode,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDragEnd,
  onOpenDetail,
  onOpenComments,
}) {
  const { workflowStates, features } = useAgileConfig();
  // Match a task to a column either by workflow_state_id (preferred) or by the
  // legacy `status` key (back-compat for tasks created pre-migration).
  const getColTasks = (col) => tasks.filter((t) =>
    (t.workflow_state_id && col.id && t.workflow_state_id === col.id) ||
    (t.status && col.key && t.status === col.key)
  );

  return (
    <div className={s['kanban-board']}>
      {workflowStates.map((col) => {
        const colTasks = getColTasks(col);
        // Drag-over compares against either id or key — useDragDrop passes whichever it has
        const isDragOver = dragOverCol === col.id || dragOverCol === col.key;
        const wipExceeded = features.wipLimits && col.wip_limit && colTasks.length > col.wip_limit;

        return (
          <div
            key={col.id || col.key}
            className={`${s['kanban-column']} ${isDragOver ? s['drag-over'] : ''} ${wipExceeded ? s['wip-exceeded'] : ''}`}
            style={{ '--col-color': col.color }}
            onDragOver={(e) => onDragOver(e, col.id || col.key, col)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(e, col.id || col.key, col)}
          >
            <div className={s['column-header']}>
              <div className={s['column-header-left']}>
                <span className={s['column-dot']} style={{ background: col.color }} />
                <span className={s['column-label']}>
                  {sprintMode && col.is_initial ? 'New' : col.name}
                </span>
              </div>
              <span className={s['column-count']}>
                {colTasks.length}
                {features.wipLimits && col.wip_limit ? ` / ${col.wip_limit}` : ''}
              </span>
            </div>

            {isDragOver && (
              <div className={s['drop-indicator']}>Drop here</div>
            )}

            <div className={s['column-tasks']}>
              {colTasks.length === 0 && !isDragOver && (
                <div className={s['column-empty']}>
                  <span>No items</span>
                </div>
              )}
              {colTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  sprintMode={sprintMode}
                  onOpenDetail={onOpenDetail}
                  onOpenComments={onOpenComments}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
