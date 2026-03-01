import React, { useState, useEffect, useCallback } from 'react';
import {
    getTeamAttendance, getTeamAnalytics, getApprovals, getMyRequests,
    approveRequest, rejectRequest, bulkApproval, getMemberHours, getMemberTasks
} from '../api';
import s from './Admin.module.css';

const ROLE_LABELS = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr_admin: 'HR Admin', super_admin: 'Super Admin' };
const STATUS_COLORS = { pending: '#f59e0b', approved: '#22c55e', rejected: '#ef4444' };

export default function ManagerDashboard() {
    const [tab, setTab] = useState('attendance');

    return (
        <div className={s.adminPage}>
            <h1>Manager Dashboard</h1>
            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'attendance' ? s.active : ''}`} onClick={() => setTab('attendance')}>Team Attendance</button>
                <button className={`${s.tab} ${tab === 'approvals' ? s.active : ''}`} onClick={() => setTab('approvals')}>Approvals</button>
                <button className={`${s.tab} ${tab === 'analytics' ? s.active : ''}`} onClick={() => setTab('analytics')}>Analytics</button>
                <button className={`${s.tab} ${tab === 'requests' ? s.active : ''}`} onClick={() => setTab('requests')}>My Requests</button>
            </div>
            {tab === 'attendance' && <TeamAttendance />}
            {tab === 'approvals' && <ApprovalsTab />}
            {tab === 'analytics' && <TeamAnalytics />}
            {tab === 'requests' && <MyRequests />}
        </div>
    );
}

function TeamAttendance() {
    const [data, setData] = useState([]);
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getTeamAttendance(date)
            .then(r => { setData(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [date]);

    const groups = { working: [], away: [], not_started: [], on_leave: [] };
    data.forEach(m => { (groups[m.status] || groups.not_started).push(m); });

    const statusLabel = { working: '🟢 Working', away: '🟡 Away', not_started: '⚪ Not Started', on_leave: '🔴 On Leave' };

    return (
        <>
            <div style={{ marginBottom: '1rem' }}>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: '0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
            </div>
            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={s.value} style={{ color: '#22c55e' }}>{groups.working.length}</div><div className={s.label}>Working</div></div>
                <div className={s.statCard}><div className={s.value} style={{ color: '#f59e0b' }}>{groups.away.length}</div><div className={s.label}>Away</div></div>
                <div className={s.statCard}><div className={s.value}>{groups.not_started.length}</div><div className={s.label}>Not Started</div></div>
                <div className={s.statCard}><div className={s.value} style={{ color: '#ef4444' }}>{groups.on_leave.length}</div><div className={s.label}>On Leave</div></div>
            </div>

            {loading ? <p>Loading...</p> : Object.entries(groups).map(([status, members]) => members.length > 0 && (
                <div key={status} style={{ marginBottom: '1.25rem' }}>
                    <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{statusLabel[status]}</h3>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        {members.map(m => (
                            <MemberCard key={m.id} member={m} />
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
}

function MemberCard({ member }) {
    const [expanded, setExpanded] = useState(false);
    const [details, setDetails] = useState(null);

    const loadDetails = async () => {
        if (expanded) { setExpanded(false); return; }
        try {
            const d = new Date().toISOString().split('T')[0];
            const [hours, tasks] = await Promise.all([
                getMemberHours(member.id, d, d),
                getMemberTasks(member.id)
            ]);
            setDetails({ hours: hours.data, tasks: tasks.data });
            setExpanded(true);
        } catch { setExpanded(true); }
    };

    return (
        <div style={{ background: 'var(--card-bg)', borderRadius: 10, padding: '0.8rem', border: '1px solid var(--border)', minWidth: 200, cursor: 'pointer' }} onClick={loadDetails}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {member.avatar ? <img src={member.avatar} style={{ width: 32, height: 32, borderRadius: '50%' }} alt="" /> : <span className={s.initials} style={{ width: 32, height: 32, fontSize: '0.7rem' }}>{member.full_name?.charAt(0)}</span>}
                <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{member.full_name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {member.hours_today != null ? `${member.hours_today.toFixed(1)}h today` : ''} {member.current_task && `• ${member.current_task}`}
                    </div>
                </div>
            </div>
            {expanded && details && (
                <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem', fontSize: '0.8rem' }} onClick={e => e.stopPropagation()}>
                    <div><strong>Total hours:</strong> {details.hours.total?.toFixed(1) || 0}h</div>
                    {details.tasks.slice(0, 3).map(t => (
                        <div key={t.id} style={{ padding: '0.2rem 0' }}>• {t.title} <span className={s.badgeRole} style={{ fontSize: '0.6rem', padding: '0.05rem 0.3rem' }}>{t.status}</span></div>
                    ))}
                    {details.tasks.length > 3 && <div style={{ color: 'var(--text-secondary)' }}>+{details.tasks.length - 3} more tasks</div>}
                </div>
            )}
        </div>
    );
}

function ApprovalsTab() {
    const [approvals, setApprovals] = useState([]);
    const [filter, setFilter] = useState('pending');
    const [selected, setSelected] = useState(new Set());
    const [rejectId, setRejectId] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [loading, setLoading] = useState(true);

    const fetch = useCallback(() => {
        setLoading(true);
        getApprovals(filter).then(r => { setApprovals(r.data); setLoading(false); setSelected(new Set()); }).catch(() => setLoading(false));
    }, [filter]);

    useEffect(() => { fetch(); }, [fetch]);

    const handleApprove = async (id) => {
        try { await approveRequest(id); fetch(); } catch { }
    };

    const handleReject = async () => {
        if (!rejectId) return;
        try { await rejectRequest(rejectId, rejectReason); setRejectId(null); setRejectReason(''); fetch(); } catch { }
    };

    const handleBulk = async (action) => {
        if (selected.size === 0) return;
        try { await bulkApproval(Array.from(selected), action); fetch(); } catch { }
    };

    const toggleSelect = (id) => {
        const next = new Set(selected);
        next.has(id) ? next.delete(id) : next.add(id);
        setSelected(next);
    };

    const toggleAll = () => {
        if (selected.size === approvals.length) setSelected(new Set());
        else setSelected(new Set(approvals.map(a => a.id)));
    };

    const pendingApprovals = approvals;

    return (
        <>
            <div className={s.toolbar}>
                <select value={filter} onChange={e => setFilter(e.target.value)} style={{ padding: '0.5rem 1.8rem 0.5rem 0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="">All</option>
                </select>
                {filter === 'pending' && selected.size > 0 && (
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button className={s.btnPrimary} onClick={() => handleBulk('approve')}>Approve ({selected.size})</button>
                        <button className={s.btnDanger} onClick={() => handleBulk('reject')}>Reject ({selected.size})</button>
                    </div>
                )}
            </div>

            {loading ? <p>Loading...</p> : (
                <table className={s.table}>
                    <thead>
                        <tr>
                            {filter === 'pending' && <th><input type="checkbox" checked={selected.size === approvals.length && approvals.length > 0} onChange={toggleAll} /></th>}
                            <th>Type</th>
                            <th>Requester</th>
                            <th>Details</th>
                            <th>Date</th>
                            <th>Status</th>
                            {filter === 'pending' && <th>Actions</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {pendingApprovals.map(a => (
                            <tr key={a.id}>
                                {filter === 'pending' && <td><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} /></td>}
                                <td><span className={s.badgeRole}>{a.request_type.replace('_', ' ')}</span></td>
                                <td>
                                    <div className={s.userCell}>
                                        <span className={s.initials}>{a.requester_name?.charAt(0)}</span>
                                        <div><div className={s.userName}>{a.requester_name}</div></div>
                                    </div>
                                </td>
                                <td style={{ maxWidth: 300 }}>
                                    {a.request_type === 'leave' && <span>{a.details?.leave_type} • {a.details?.start_date} to {a.details?.end_date}</span>}
                                    {a.request_type === 'manual_entry' && <span>{a.details?.date} • {a.details?.hours}h</span>}
                                    {a.request_type === 'overtime' && <span>{a.details?.date} • {a.details?.hours}h</span>}
                                </td>
                                <td style={{ fontSize: '0.85rem' }}>{new Date(a.created_at).toLocaleDateString()}</td>
                                <td><span className={`${s.badge} ${s['badge' + a.status.charAt(0).toUpperCase() + a.status.slice(1)]}`}>{a.status}</span></td>
                                {filter === 'pending' && (
                                    <td>
                                        <div className={s.actions}>
                                            <button className={s.btnSmall} style={{ background: '#22c55e', color: '#fff' }} onClick={() => handleApprove(a.id)}>✓</button>
                                            <button className={s.btnSmall} style={{ background: '#ef4444', color: '#fff' }} onClick={() => setRejectId(a.id)}>✗</button>
                                        </div>
                                    </td>
                                )}
                            </tr>
                        ))}
                        {pendingApprovals.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No {filter || ''} requests</td></tr>}
                    </tbody>
                </table>
            )}

            {rejectId && (
                <div className={s.modalOverlay} onClick={() => setRejectId(null)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h3>Reject Request</h3>
                        <div className={s.formGroup}>
                            <label>Reason (optional)</label>
                            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3} style={{ width: '100%', padding: '0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', resize: 'vertical' }} placeholder="Provide a reason..." />
                        </div>
                        <div className={s.formActions}>
                            <button className={s.btnCancel} onClick={() => setRejectId(null)}>Cancel</button>
                            <button className={s.btnDanger} onClick={handleReject}>Reject</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function TeamAnalytics() {
    const [data, setData] = useState(null);
    const [range, setRange] = useState('week');

    useEffect(() => {
        getTeamAnalytics(range).then(r => setData(r.data)).catch(() => {});
    }, [range]);

    if (!data) return <p>Loading...</p>;

    return (
        <>
            <div style={{ marginBottom: '1rem' }}>
                <select value={range} onChange={e => setRange(e.target.value)} style={{ padding: '0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                    <option value="quarter">This Quarter</option>
                </select>
            </div>

            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={s.value}>{data.totalMembers}</div><div className={s.label}>Team Members</div></div>
                <div className={s.statCard}><div className={s.value}>{data.avgHours?.toFixed(1) || 0}h</div><div className={s.label}>Avg Hours</div></div>
                <div className={s.statCard}><div className={s.value}>{data.totalTasks || 0}</div><div className={s.label}>Tasks Completed</div></div>
                <div className={s.statCard}><div className={s.value}>{data.pendingApprovals || 0}</div><div className={s.label}>Pending Approvals</div></div>
            </div>

            <h3 style={{ marginTop: '1.5rem', marginBottom: '0.75rem' }}>Member Performance</h3>
            <table className={s.table}>
                <thead><tr><th>Member</th><th>Hours</th><th>Tasks</th><th>Leaves</th><th>Utilization</th></tr></thead>
                <tbody>
                    {(data.members || []).map(m => {
                        const util = data.expectedHours ? Math.round((m.hours / data.expectedHours) * 100) : 0;
                        return (
                            <tr key={m.id}>
                                <td>
                                    <div className={s.userCell}>
                                        <span className={s.initials}>{m.full_name?.charAt(0)}</span>
                                        <div><div className={s.userName}>{m.full_name}</div><div className={s.userEmail}>{ROLE_LABELS[m.role]}</div></div>
                                    </div>
                                </td>
                                <td>{m.hours?.toFixed(1) || 0}h</td>
                                <td>{m.tasks || 0}</td>
                                <td>{m.leaves || 0}</td>
                                <td>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3 }}>
                                            <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(util, 100)}%`, background: util >= 80 ? '#22c55e' : util >= 50 ? '#f59e0b' : '#ef4444' }} />
                                        </div>
                                        <span style={{ fontSize: '0.8rem', fontWeight: 600, width: 35 }}>{util}%</span>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </>
    );
}

function MyRequests() {
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getMyRequests().then(r => { setRequests(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <h3 style={{ marginBottom: '0.75rem' }}>Your Submitted Requests</h3>
            <table className={s.table}>
                <thead><tr><th>Type</th><th>Details</th><th>Status</th><th>Submitted</th><th>Reviewed By</th></tr></thead>
                <tbody>
                    {requests.map(r => (
                        <tr key={r.id}>
                            <td><span className={s.badgeRole}>{r.request_type.replace('_', ' ')}</span></td>
                            <td style={{ maxWidth: 300 }}>
                                {r.request_type === 'leave' && <span>{r.details?.leave_type} • {r.details?.start_date} to {r.details?.end_date}</span>}
                                {r.request_type === 'manual_entry' && <span>{r.details?.date} • {r.details?.hours}h</span>}
                                {r.request_type === 'overtime' && <span>{r.details?.date} • {r.details?.hours}h</span>}
                            </td>
                            <td>
                                <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 600, background: `${STATUS_COLORS[r.status]}22`, color: STATUS_COLORS[r.status] }}>
                                    {r.status}
                                </span>
                            </td>
                            <td style={{ fontSize: '0.85rem' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                            <td>{r.reviewer_name || '—'}</td>
                        </tr>
                    ))}
                    {requests.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No requests submitted</td></tr>}
                </tbody>
            </table>
        </>
    );
}
