/**
 * Reusable Agile pickers + badges, all driven by the tenant's customisable
 * AgileConfig. Bundled in one module so consumers can import multiple bits
 * without a long import list.
 *
 * Components:
 *   - <StoryPointPicker value onChange />
 *   - <StoryPointBadge value />
 *   - <WorkItemTypePicker value onChange />
 *   - <WorkItemTypeBadge value />
 *   - <WorkflowStatePicker value onChange />
 *   - <BlockerBadge task />
 */
import React from 'react';
import { useAgileConfig } from '../../AgileConfigContext';
import s from './AgilePickers.module.css';

// ────────────────────────────────────────────────────────────────────────────
// Story Point picker — chip-style, supports null ("?" = unestimated)
// ────────────────────────────────────────────────────────────────────────────
export function StoryPointPicker({ value, onChange, disabled, compact }) {
    const { pointScale, unitLabel, features } = useAgileConfig();
    if (!features.storyPoints) return null;
    const handleClick = (v) => {
        if (disabled) return;
        // toggle off if user clicks the currently selected chip
        const same = String(value ?? '') === String(v ?? '');
        onChange(same ? null : v);
    };
    const isSel = (v) => String(value ?? '') === String(v ?? '');
    return (
        <div className={`${s.spPicker} ${compact ? s.spPickerCompact : ''}`}>
            <span className={s.spPickerLabel}>{unitLabel}</span>
            <button
                type="button"
                className={`${s.spChip} ${value == null ? s.spChipActive : ''}`}
                onClick={() => handleClick(null)}
                disabled={disabled}
                title="Unestimated"
            >?</button>
            {pointScale.map(v => (
                <button
                    key={String(v)}
                    type="button"
                    className={`${s.spChip} ${isSel(v) ? s.spChipActive : ''}`}
                    onClick={() => handleClick(v)}
                    disabled={disabled}
                >{v}</button>
            ))}
        </div>
    );
}

// Format a numeric story-point value for display:
//   1.00 → "1", 0.50 → "0.5", 1.25 → "1.25", "S"/"M"/"L" → unchanged.
// PostgreSQL returns NUMERIC as a string, hence the parseFloat dance.
function formatPoints(value) {
    if (value == null || value === '') return '';
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isNaN(num)) return String(value);            // T-shirt sizes etc.
    if (Number.isInteger(num)) return String(num);
    // Trim trailing zeros — "1.5" not "1.50", "0.5" not "0.500"
    return num.toFixed(2).replace(/\.?0+$/, '');
}

export function StoryPointBadge({ value, label }) {
    const { unitLabel, features } = useAgileConfig();
    if (!features.storyPoints) return null;
    if (value == null || value === '') return null;
    const display = formatPoints(value);
    if (!display) return null;
    // Compact display: show only the number on the card. The unit (e.g. "SP")
    // is reserved for the tooltip so the badge stays visually quiet.
    const tooltip = label || `${display} ${unitLabel} — Story Points`;
    return (
        <span className={s.spBadge} title={tooltip}>
            {display}
        </span>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Work Item Type picker (icon dot + name)
// ────────────────────────────────────────────────────────────────────────────
export function WorkItemTypePicker({ value, onChange, disabled }) {
    const { workItemTypes } = useAgileConfig();
    return (
        <select
            className={s.witSelect}
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={disabled}
        >
            <option value="">— Type —</option>
            {workItemTypes.map(t => (
                <option key={t.id || t.key} value={t.id || t.key}>
                    {t.name}
                </option>
            ))}
        </select>
    );
}

export function WorkItemTypeBadge({ value }) {
    const { typeById, typeByKey } = useAgileConfig();
    if (!value) return null;
    const t = typeById[value] || typeByKey[value];
    if (!t) return null;
    return (
        <span
            className={s.witBadge}
            style={{ '--wit-color': t.color || '#6366f1' }}
            title={t.name}
        >
            <span className={s.witDot} />
            {t.name}
        </span>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Workflow State picker — single select. For a Kanban-style transition
// you'd use the column drag/drop instead.
// ────────────────────────────────────────────────────────────────────────────
export function WorkflowStatePicker({ value, onChange, disabled }) {
    const { workflowStates } = useAgileConfig();
    return (
        <select
            className={s.wsSelect}
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={disabled}
        >
            {workflowStates.map(st => (
                <option key={st.id || st.key} value={st.id || st.key}>
                    {st.name}
                </option>
            ))}
        </select>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Blocker badge — shows when task.is_blocked is true
// ────────────────────────────────────────────────────────────────────────────
export function BlockerBadge({ task }) {
    const { features } = useAgileConfig();
    if (!features.blockers) return null;
    if (!task?.is_blocked) return null;
    return (
        <span className={s.blocker} title={task.blocked_reason || 'Blocked'}>
            ⛔ Blocked
        </span>
    );
}