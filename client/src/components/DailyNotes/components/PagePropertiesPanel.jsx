/* ─────────────────────────────────────────────────────────
   PagePropertiesPanel — typed metadata fields per page
   (status, priority, due date, owner). Stored in
   `page.properties` (free-form object) so it round-trips
   cleanly through the existing notebook JSON blob.
   ───────────────────────────────────────────────────────── */
import React from 'react';
import {
    Circle, AlertCircle, Calendar, User, Flame,
} from '../../../constants/icons';
import s from './PagePropertiesPanel.module.css';

const STATUS_OPTIONS = [
    { value: '', label: '— None —', color: 'transparent' },
    { value: 'todo', label: 'To do', color: '#94a3b8' },
    { value: 'in_progress', label: 'In progress', color: '#3b82f6' },
    { value: 'review', label: 'In review', color: '#f59e0b' },
    { value: 'done', label: 'Done', color: '#10b981' },
    { value: 'blocked', label: 'Blocked', color: '#ef4444' },
];

const PRIORITY_OPTIONS = [
    { value: '', label: '— None —' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
];

export default function PagePropertiesPanel({ page, readOnly, onChange }) {
    if (!page) return null;
    const props = page.properties || {};

    const setProp = (key, value) => {
        if (readOnly) return;
        const next = { ...props };
        if (value === '' || value == null) delete next[key];
        else next[key] = value;
        onChange?.(next);
    };

    const statusMeta = STATUS_OPTIONS.find(s => s.value === props.status);

    return (
        <div className={s.panel} aria-label="Page properties">
            <div className={s.row}>
                <label className={s.label}>
                    <Circle size={12} className={s.icon} aria-hidden="true" />
                    Status
                </label>
                <div className={s.value}>
                    {statusMeta?.color && statusMeta.value && (
                        <span className={s.statusDot} style={{ background: statusMeta.color }} />
                    )}
                    <select
                        className={s.select}
                        value={props.status || ''}
                        disabled={readOnly}
                        onChange={(e) => setProp('status', e.target.value)}
                    >
                        {STATUS_OPTIONS.map(o => (
                            <option key={o.value || 'none'} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className={s.row}>
                <label className={s.label}>
                    <Flame size={12} className={s.icon} aria-hidden="true" />
                    Priority
                </label>
                <div className={s.value}>
                    <select
                        className={s.select}
                        value={props.priority || ''}
                        disabled={readOnly}
                        onChange={(e) => setProp('priority', e.target.value)}
                    >
                        {PRIORITY_OPTIONS.map(o => (
                            <option key={o.value || 'none'} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className={s.row}>
                <label className={s.label}>
                    <Calendar size={12} className={s.icon} aria-hidden="true" />
                    Due date
                </label>
                <div className={s.value}>
                    <input
                        type="date"
                        className={s.input}
                        value={props.dueDate || ''}
                        disabled={readOnly}
                        onChange={(e) => setProp('dueDate', e.target.value)}
                    />
                </div>
            </div>

            <div className={s.row}>
                <label className={s.label}>
                    <User size={12} className={s.icon} aria-hidden="true" />
                    Owner
                </label>
                <div className={s.value}>
                    <input
                        type="text"
                        className={s.input}
                        value={props.owner || ''}
                        placeholder="Add owner…"
                        disabled={readOnly}
                        onChange={(e) => setProp('owner', e.target.value)}
                    />
                </div>
            </div>
        </div>
    );
}