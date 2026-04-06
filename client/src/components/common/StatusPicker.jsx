import { useState, useRef } from 'react';
import { useUserStatus } from '../../UserStatusContext';
import { useClickOutside } from '../../hooks/useClickOutside';
import s from './StatusPicker.module.css';

const STATUSES = [
    { value: 'available', label: 'Available', color: '#22c55e', icon: '●' },
    { value: 'busy', label: 'Busy', color: '#ef4444', icon: '●' },
    { value: 'dnd', label: 'Do Not Disturb', color: '#ef4444', icon: '⊖' },
    { value: 'away', label: 'Away', color: '#f59e0b', icon: '●' },
    { value: 'offline', label: 'Appear Offline', color: '#64748b', icon: '○' },
];

const STATUS_LABELS = {
    available: 'Available',
    busy: 'Busy',
    dnd: 'Do Not Disturb',
    away: 'Away',
    offline: 'Offline',
    in_call: 'In a Call',
    in_meeting: 'In a Meeting',
};

const STATUS_COLORS = {
    available: '#22c55e',
    busy: '#ef4444',
    dnd: '#ef4444',
    away: '#f59e0b',
    offline: '#64748b',
    in_call: '#ef4444',
    in_meeting: '#8b5cf6',
};

export default function StatusPicker() {
    const { myStatus, setManualStatus } = useUserStatus();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useClickOutside(ref, () => setOpen(false));

    const currentLabel = STATUS_LABELS[myStatus] || 'Available';
    const currentColor = STATUS_COLORS[myStatus] || '#22c55e';
    const isAutoStatus = myStatus === 'in_call' || myStatus === 'in_meeting';

    return (
        <div className={s.picker} ref={ref}>
            <button className={s.trigger} onClick={() => setOpen(o => !o)}>
                <span className={s.statusDot} style={{ background: currentColor }} />
                <span className={s.statusLabel}>{currentLabel}</span>
                {isAutoStatus && <span className={s.autoBadge}>auto</span>}
                <svg className={s.chevron} width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {open && (
                <div className={s.dropdown}>
                    <div className={s.dropdownTitle}>Set status</div>
                    {STATUSES.map(st => (
                        <button
                            key={st.value}
                            className={`${s.option} ${myStatus === st.value ? s.active : ''}`}
                            onClick={() => { setManualStatus(st.value); setOpen(false); }}
                        >
                            <span className={s.optionDot} style={{ background: st.color }}>{st.icon}</span>
                            <span className={s.optionLabel}>{st.label}</span>
                        </button>
                    ))}
                    {isAutoStatus && (
                        <div className={s.autoNote}>
                            Status automatically set to "{currentLabel}" — will revert when done.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
