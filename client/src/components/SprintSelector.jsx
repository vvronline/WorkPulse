import React from 'react';
import s from './SprintSelector.module.css';

/**
 * Reusable sprint selector dropdown.
 * Props:
 * - sprints: Array of { id, name, start_date, end_date, status }
 * - selected: currently selected sprint_id (or '')
 * - onChange: (sprintId: string) => void
 * - disabled?: boolean
 * - showBadge?: boolean - show sprint status badge
 */
export default function SprintSelector({ sprints, selected, onChange, disabled = false, showBadge = true }) {
  if (!sprints || sprints.length === 0) return null;

  return (
    <div className={s['form-extra-group']}>
      <label>🏃 Sprint</label>
      <select
        value={selected || ''}
        onChange={e => onChange(e.target.value ? parseInt(e.target.value, 10) : '')}
        disabled={disabled}
      >
        <option value="">📦 Backlog (no sprint)</option>
        {sprints.map(sp => (
          <option key={sp.id} value={sp.id}>
            {sp.name} ({sp.start_date} → {sp.end_date})
            {sp.status === 'active' ? ' ● Active' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
