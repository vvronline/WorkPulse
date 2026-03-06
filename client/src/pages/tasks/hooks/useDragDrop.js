import { useState, useRef } from 'react';
import { updateTaskStatus } from '../../../api';
import { COLUMNS } from '../constants.js';
import s from '../TaskCard.module.css';

export function useDragDrop({ tasks, setTasks, showConfirm, closeConfirm, setError }) {
  const [dragOverCol, setDragOverCol] = useState(null);
  const dragTaskId = useRef(null);

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
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === colId) return;
    const colLabel = COLUMNS.find((c) => c.id === colId)?.label || colId;
    showConfirm(
      'Change Status',
      `Move "${task.title}" to ${colLabel}?`,
      async () => {
        closeConfirm();
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: colId } : t)));
        try {
          await updateTaskStatus(taskId, colId);
        } catch {
          setError('Failed to move item');
        }
      },
      { confirmText: 'Move' }
    );
  };

  return { dragOverCol, dragTaskId, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop };
}
