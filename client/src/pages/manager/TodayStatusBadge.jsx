import React from 'react';
import { formatMin } from './constants';
import m from '../ManagerDashboard.module.css';

const config = {
    working: { label: 'Working', cls: 'badgeApproved', icon: '🟢' },
    on_break: { label: 'Break', cls: 'badgePending', icon: '🟡' },
    on_leave: { label: 'On Leave', cls: 'badgeRejected', icon: '🔴' },
    left: { label: 'Left', cls: 'badgeDefault', icon: '⚪' },
    absent: { label: 'Absent', cls: 'badgeDefault', icon: '⚫' },
};

export default function TodayStatusBadge({ status, minutes }) {
    const c = config[status] || config.absent;
    return (
        <div className={m.todayStatus}>
            <span className={`${m.badge} ${m[c.cls]}`}>{c.icon} {c.label}</span>
            {minutes > 0 && <span className={m.todayMins}>{formatMin(minutes)}</span>}
        </div>
    );
}
