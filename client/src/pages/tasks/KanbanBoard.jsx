import React from 'react';
import { COLUMNS } from './constants.js';
import TaskCard from './TaskCard.jsx';
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
  const getColTasks = (colId) => tasks.filter((t) => t.status === colId);

  return (
    <div className={s['kanban-board']}>
      {COLUMNS.map((col) => {
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
                <span className={s['column-label']}>
                  {sprintMode && col.id === 'pending' ? 'New' : col.label}
                </span>
              </div>
              <span className={s['column-count']}>{colTasks.length}</span>
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
