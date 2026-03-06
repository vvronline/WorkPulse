import React from 'react';
import m from '../ManagerDashboard.module.css';

export default function StatusBadge({ status }) {
    const cls = status === 'done' ? m.badgeDone : status === 'in_progress' ? m.badgeInProgress : status === 'in_review' ? m.badgeInReview : m.badgeDefault;
    return <span className={`${m.badgeSmall} ${cls}`}>{status?.replace('_', ' ')}</span>;
}
