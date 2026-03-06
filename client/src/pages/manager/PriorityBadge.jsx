import React from 'react';
import m from '../ManagerDashboard.module.css';

export default function PriorityBadge({ priority }) {
    const cls = priority === 'high' ? m.badgeHigh : priority === 'medium' ? m.badgeMedium : priority === 'low' ? m.badgeLow : m.badgeDefault;
    return <span className={`${m.badgeSmall} ${cls}`}>{priority}</span>;
}
