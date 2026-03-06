import React from 'react';
import m from '../ManagerDashboard.module.css';

export default function PercentBar({ value, color }) {
    const bg = color === 'blue'
        ? (value >= 80 ? 'var(--primary)' : value >= 50 ? 'var(--primary-light)' : 'var(--text-secondary)')
        : (value >= 80 ? 'var(--success)' : value >= 50 ? 'var(--warning)' : 'var(--danger)');
    return (
        <div className={m.percentBarWrap}>
            <div className={m.percentTrack}>
                <div className={m.percentFill} style={{ width: `${Math.min(value, 100)}%`, background: bg }} />
            </div>
            <span className={m.percentLabel}>{value}%</span>
        </div>
    );
}
