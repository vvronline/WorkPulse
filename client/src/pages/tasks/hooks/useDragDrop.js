import { useState, useRef } from 'react';
import { updateTaskStatus } from '../../../api';
import s from '../TaskCard.module.css';

/**
 * Drag-and-drop between Kanban columns. Columns are dynamic, so the API
 * change goes through the underlying workflow state's key (or id) — both
 * work server-side.
 */
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

  const onDragOver = (e, colId /*, col */) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== colId) setDragOverCol(colId);
  };

  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverCol(null);
  };

  const onDrop = async (e, colId, col) => {
    e.preventDefault();
    setDragOverCol(null);
    const rawId = e.dataTransfer.getData('text/plain');
    const taskId = rawId ? parseInt(rawId, 10) : dragTaskId.current;
    dragTaskId.current = null;
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const targetKey = col?.key || colId;
    if (task.status === targetKey || task.workflow_state_id === col?.id) return;

    const colLabel = col?.name || targetKey;
    showConfirm(
      'Change Status',
      `Move "${task.title}" to ${colLabel}?`,
      async () => {
        closeConfirm();
        setTasks((prev) => prev.map((t) => (t.id === taskId
          ? { ...t, status: targetKey, workflow_state_id: col?.id || t.workflow_state_id }
          : t)));
        // Optimistic snapshot — restore on failure (e.g. WIP limit hit).
        const previousStatus = task.status;
        const previousStateId = task.workflow_state_id;
        try {
          // Send by key (back-compat with default workflow); server resolves to
          // workflow_state_id and writes both columns.
          await updateTaskStatus(taskId, targetKey);
        } catch (err) {
          // Roll back the optimistic move so the card snaps back to its
          // original column. Surface the server-supplied error message when
          // available — Phase 3 added a 409 with a helpful WIP-exceeded
          // message that we want users to actually see.
          setTasks((prev) => prev.map((t) => (t.id === taskId
            ? { ...t, status: previousStatus, workflow_state_id: previousStateId }
            : t)));
          const apiMsg = err?.response?.data?.error;
          const code = err?.response?.data?.code;
          if (code === 'WIP_EXCEEDED') {
            setError(apiMsg || 'WIP limit reached for this column.');
          } else {
            setError(apiMsg || 'Failed to move item');
          }
        }
      },
      { confirmText: 'Move' }
    );
  };

  return { dragOverCol, dragTaskId, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop };
}
