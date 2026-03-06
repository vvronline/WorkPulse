import React, { useState, useEffect, useCallback } from 'react';
import { getAuditLogs } from '../../api';
import s from '../Admin.module.css';
import al from './AuditLogs.module.css';
import su from './AdminUtils.module.css';

export default function AuditLogs() {
    const [logs, setLogs] = useState([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const [filters, setFilters] = useState({ entity_type: '', action: '' });
    const pageSize = 50;

    const fetchLogs = useCallback(() => {
        const params = { limit: pageSize, offset: page * pageSize };
        if (filters.entity_type) params.entity_type = filters.entity_type;
        if (filters.action) params.action = filters.action;
        getAuditLogs(params).then(r => { setLogs(r.data.logs); setTotal(r.data.total); }).catch(e => console.error(e));
    }, [page, filters]);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    const totalPages = Math.ceil(total / pageSize);

    return (
        <>
            <h2 className={su['section-heading']}>📋 Audit Logs</h2>
            <p className={su['section-desc']}>Track all administrative actions and system events</p>
            <div className={s.toolbar}>
                <select value={filters.entity_type} onChange={e => { setFilters({ ...filters, entity_type: e.target.value }); setPage(0); }}>
                    <option value="">All Entities</option>
                    {['user', 'leave', 'time_entry', 'task', 'team', 'department', 'organization', 'leave_policy', 'holiday', 'approval_request'].map(t => (
                        <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                <select value={filters.action} onChange={e => { setFilters({ ...filters, action: e.target.value }); setPage(0); }}>
                    <option value="">All Actions</option>
                    {['create', 'update', 'delete', 'approve', 'reject', 'login', 'update_role', 'deactivate', 'reactivate', 'admin_create', 'admin_reset_password', 'invite', 'remove_member'].map(a => (
                        <option key={a} value={a}>{a}</option>
                    ))}
                </select>
                <span className={su['text-muted-sm']}>{total} log(s)</span>
            </div>

            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th>
                    </tr>
                </thead>
                <tbody>
                    {logs.map(log => (
                        <tr key={log.id}>
                            <td className={al['audit-time']}>{new Date(log.created_at + 'Z').toLocaleString()}</td>
                            <td>{log.actor_name || log.actor_username || `User #${log.actor_id}`}</td>
                            <td><span className={`${s.badge} ${al['badge-accent']}`}>{log.action}</span></td>
                            <td>{log.entity_type}{log.entity_id ? ` #${log.entity_id}` : ''}</td>
                            <td className={al['audit-details']}>
                                {log.details ? JSON.stringify(JSON.parse(log.details)) : '—'}
                            </td>
                            <td className={su['text-xs']}>{log.ip_address || '—'}</td>
                        </tr>
                    ))}
                    {logs.length === 0 && (
                        <tr><td colSpan={6} className={s.emptyRow}>No logs found</td></tr>
                    )}
                </tbody>
            </table>

            {totalPages > 1 && (
                <div className={s.pagination}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
                    <span className={su['text-muted-sm']}>Page {page + 1} of {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
                </div>
            )}
        </>
    );
}
