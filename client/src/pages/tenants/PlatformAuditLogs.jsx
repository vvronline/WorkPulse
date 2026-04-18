import React, { useState, useEffect, useCallback } from 'react';
import { ScrollText, Shield, Building2, ChevronLeft, ChevronRight, Clock, Eye, Edit3 } from 'lucide-react';
import { getPlatformAuditLogs, getTenants, getPlatformUsers } from '../../api';
import s from './Tenants.module.css';

const ACTION_COLORS = {
    tenant_created: '#10b981',
    tenant_updated: '#3b82f6',
    tenant_suspended: '#f59e0b',
    tenant_reactivated: '#10b981',
    tenant_soft_deleted: '#ef4444',
    tenant_hard_deleted: '#ef4444',
    tenant_domain_changed: '#8b5cf6',
    tenant_features_updated: '#6366f1',
    tenant_limits_updated: '#6366f1',
    tenant_impersonation_session: '#f97316',
    tenant_impersonation_started: '#f97316',
    tenant_impersonation_ended: '#f97316',
    tenant_user_created: '#0ea5e9',
    tenant_user_deactivated: '#ef4444',
    tenant_seeded: '#14b8a6',
    platform_admin_created: '#0284c7',
    platform_admin_deactivated: '#ef4444',
    platform_admin_reactivated: '#10b981',
    platform_admin_reset_password: '#f59e0b',
};

const SEVERITY = {
    tenant_impersonation_session: 'high',
    tenant_impersonation_started: 'high',
    tenant_hard_deleted: 'high',
    tenant_suspended: 'high',
    platform_admin_deactivated: 'high',
    platform_admin_reset_password: 'medium',
    tenant_soft_deleted: 'medium',
    tenant_user_deactivated: 'medium',
};

const PAGE_SIZE = 50;

export default function PlatformAuditLogs() {
    const [logs, setLogs] = useState([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const [filters, setFilters] = useState({ action: '', tenant_id: '', entity_type: '' });
    const [tenants, setTenants] = useState([]);
    const [admins, setAdmins] = useState([]);
    const [expandedId, setExpandedId] = useState(null);

    useEffect(() => {
        getTenants({ limit: 200 }).then(r => setTenants(r.data.tenants || [])).catch(() => {});
        getPlatformUsers().then(r => setAdmins(r.data || [])).catch(() => {});
    }, []);

    const fetchLogs = useCallback(() => {
        const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
        if (filters.action) params.action = filters.action;
        if (filters.tenant_id) params.tenant_id = filters.tenant_id;
        if (filters.entity_type) params.entity_type = filters.entity_type;
        getPlatformAuditLogs(params)
            .then(r => { setLogs(r.data.logs); setTotal(r.data.total); })
            .catch(e => console.error(e));
    }, [page, filters]);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const formatTime = (ts) => new Date(ts).toLocaleString();

    const updateFilter = (key, value) => {
        setFilters(f => ({ ...f, [key]: value }));
        setPage(0);
    };

    const actions = [...new Set(Object.keys(ACTION_COLORS))];
    const entityTypes = ['tenant', 'platform_user', 'user'];

    return (
        <div className={s.auditSection}>
            <div className={s.auditHeader}>
                <div className={s.auditHeaderIcon}><ScrollText size={20} /></div>
                <div>
                    <h2 className={s.auditTitle}>Platform Audit Trail</h2>
                    <p className={s.auditSubtitle}>
                        Every platform admin action is logged for compliance and accountability
                    </p>
                </div>
                <span className={s.auditCount}>{total} event{total !== 1 ? 's' : ''}</span>
            </div>

            <div className={s.auditToolbar}>
                <select value={filters.entity_type} onChange={e => updateFilter('entity_type', e.target.value)}>
                    <option value="">All Entities</option>
                    {entityTypes.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
                <select value={filters.action} onChange={e => updateFilter('action', e.target.value)}>
                    <option value="">All Actions</option>
                    {actions.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
                </select>
                <select value={filters.tenant_id} onChange={e => updateFilter('tenant_id', e.target.value)}>
                    <option value="">All Tenants</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.org_name} ({t.slug})</option>)}
                </select>
            </div>

            <div className={s.auditTableWrap}>
                <table className={s.auditTable}>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>User</th>
                            <th>Action</th>
                            <th>Entity</th>
                            <th>Tenant</th>
                            <th>IP</th>
                        </tr>
                    </thead>
                    <tbody>
                        {logs.map(log => {
                            const color = ACTION_COLORS[log.action] || '#6b7280';
                            const severity = SEVERITY[log.action];
                            const isExpanded = expandedId === log.id;
                            const details = log.details ? (typeof log.details === 'string' ? JSON.parse(log.details) : log.details) : null;
                            const isSession = log.action === 'tenant_impersonation_session';

                            return (
                                <React.Fragment key={log.id}>
                                    <tr
                                        className={`${s.auditRow} ${severity === 'high' ? s.auditRowHigh : severity === 'medium' ? s.auditRowMedium : ''}`}
                                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                                    >
                                        <td className={s.auditTime}>
                                            {isSession ? (
                                                <div className={s.sessionTime}>
                                                    <span>{formatTime(log.created_at)}</span>
                                                    {log.ended_at && (
                                                        <span className={s.sessionEndTime}>→ {formatTime(log.ended_at)}</span>
                                                    )}
                                                    {!log.ended_at && (
                                                        <span className={s.sessionActive}>● Active</span>
                                                    )}
                                                </div>
                                            ) : formatTime(log.created_at)}
                                        </td>
                                        <td>
                                            <span className={s.auditActor}>
                                                <Shield size={12} />
                                                {log.actor_name || log.actor_username || `Admin #${log.actor_id}`}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={s.auditBadge} style={{ background: `${color}18`, color }}>
                                                {log.action.replace(/_/g, ' ')}
                                            </span>
                                        </td>
                                        <td className={s.auditEntity}>
                                            {log.entity_type}{log.entity_id ? ` #${log.entity_id}` : ''}
                                        </td>
                                        <td>
                                            {log.tenant_name ? (
                                                <span className={s.auditTenant}>
                                                    <Building2 size={12} />
                                                    {log.tenant_name}
                                                </span>
                                            ) : '—'}
                                        </td>
                                        <td className={s.auditIp}>{log.ip_address || '—'}</td>
                                    </tr>
                                    {isExpanded && details && (
                                        <tr className={s.auditDetailRow}>
                                            <td colSpan={6}>
                                                <div className={s.auditDetails}>
                                                    {isSession && details.duration_seconds != null ? (
                                                        <div className={s.sessionDetails}>
                                                            <div className={s.sessionStats}>
                                                                <span className={s.sessionStat}>
                                                                    <Clock size={13} />
                                                                    {details.duration_seconds < 60
                                                                        ? `${details.duration_seconds}s`
                                                                        : `${Math.floor(details.duration_seconds / 60)}m ${details.duration_seconds % 60}s`}
                                                                </span>
                                                                <span className={s.sessionStat}>
                                                                    <Eye size={13} />
                                                                    {details.reads || 0} reads
                                                                </span>
                                                                <span className={s.sessionStat}>
                                                                    <Edit3 size={13} />
                                                                    {details.writes || 0} writes
                                                                </span>
                                                                <span className={s.sessionStat}>
                                                                    {details.total_actions || 0} total actions
                                                                </span>
                                                                {details.target_username && (
                                                                    <span className={s.sessionStat}>
                                                                        <Shield size={13} />
                                                                        as {details.target_username}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {details.actions?.length > 0 && (
                                                                <div className={s.sessionActionLog}>
                                                                    {details.actions.map((a, i) => (
                                                                        <div key={i} className={s.sessionActionItem}>
                                                                            <span className={`${s.sessionActionMethod} ${a.type === 'write' ? s.sessionMethodWrite : s.sessionMethodRead}`}>
                                                                                {a.method}
                                                                            </span>
                                                                            <span className={s.sessionActionPath}>{a.path}</span>
                                                                            <span className={s.sessionActionTime}>
                                                                                {new Date(a.timestamp).toLocaleTimeString()}
                                                                            </span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <strong>Details:</strong>
                                                            <pre>{JSON.stringify(details, null, 2)}</pre>
                                                        </>
                                                    )}
                                                    {log.user_agent && (
                                                        <div className={s.auditUa}>
                                                            <strong>User-Agent:</strong> {log.user_agent}
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        {logs.length === 0 && (
                            <tr>
                                <td colSpan={6} className={s.auditEmpty}>
                                    <ScrollText size={32} strokeWidth={1} />
                                    <span>No audit logs found</span>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div className={s.auditPagination}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                        <ChevronLeft size={14} /> Previous
                    </button>
                    <span>Page {page + 1} of {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                        Next <ChevronRight size={14} />
                    </button>
                </div>
            )}
        </div>
    );
}
