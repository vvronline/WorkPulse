import React from 'react';
import { LEAVE_ICONS } from './constants';

export default function RequestDetails({ request }) {
    const meta = request.metadata;
    if (!meta) return <span>—</span>;

    if (request.type === 'leave') {
        return <span>{LEAVE_ICONS[meta.leave_type] || ''} {meta.leave_type} • {meta.date} {meta.duration && meta.duration !== 'full' ? `(${meta.duration})` : ''}</span>;
    }
    if (request.type === 'leave_withdraw') {
        return <span>🔙 Withdraw {LEAVE_ICONS[meta.leave_type] || ''} {meta.leave_type} • {meta.date} {meta.previous_status ? `(was ${meta.previous_status})` : ''}</span>;
    }
    if (request.type === 'manual_entry') {
        return <span>📝 {meta.date} • {meta.clock_in}{meta.clock_out ? ` → ${meta.clock_out}` : ''} {meta.work_mode ? `(${meta.work_mode})` : ''}</span>;
    }
    if (request.type === 'overtime') {
        return <span>⏰ {meta.date} • {meta.hours}h</span>;
    }
    return <span>{JSON.stringify(meta)}</span>;
}
