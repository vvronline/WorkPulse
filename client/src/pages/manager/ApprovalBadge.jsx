import React from 'react';
import m from '../ManagerDashboard.module.css';

export default function ApprovalBadge({ status }) {
    const cls = status === 'pending' ? m.badgePending : status === 'approved' ? m.badgeApproved : status === 'rejected' ? m.badgeRejected : m.badgeDefault;
    return <span className={`${m.badge} ${cls}`}>{status}</span>;
}
