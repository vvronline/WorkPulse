import React, { useState, useEffect, useCallback } from 'react';
import {
    getTeamAttendance, getTeamAnalytics, getApprovals, getMyRequests,
    approveRequest, rejectRequest, bulkApproval, getMemberHours, getMemberTasks,
    getMemberOverview, getMemberLeaves, getMemberRequests
} from '../api';
import s from './Admin.module.css';
import m from './ManagerDashboard.module.css';

const ROLE_LABELS = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr_admin: 'HR Admin', super_admin: 'Super Admin' };
const STATUS_COLORS = { pending: '#f59e0b', approved: '#22c55e', rejected: '#ef4444' };
const LEAVE_ICONS = { sick: '🤒', holiday: '🎉', planned: '📅', personal: '👤', other: '📝' };

export default function ManagerDashboard() {
    const [tab, setTab] = useState('attendance');
    const [selectedMember, setSelectedMember] = useState(null);

    if (selectedMember) {
        return <EmployeeDashboard member={selectedMember} onBack={() => setSelectedMember(null)} />;
    }

    return (
        <div className={s.adminPage}>
            <h1>Manager Dashboard</h1>
            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'attendance' ? s.active : ''}`} onClick={() => setTab('attendance')}>Team Attendance</button>
                <button className={`${s.tab} ${tab === 'approvals' ? s.active : ''}`} onClick={() => setTab('approvals')}>Approvals</button>
                <button className={`${s.tab} ${tab === 'analytics' ? s.active : ''}`} onClick={() => setTab('analytics')}>Analytics</button>
                <button className={`${s.tab} ${tab === 'requests' ? s.active : ''}`} onClick={() => setTab('requests')}>My Requests</button>
            </div>
            {tab === 'attendance' && <TeamAttendance onSelectMember={setSelectedMember} />}
            {tab === 'approvals' && <ApprovalsTab />}
            {tab === 'analytics' && <TeamAnalytics onSelectMember={setSelectedMember} />}
            {tab === 'requests' && <MyRequests />}
        </div>
    );
}

// ==================== TEAM ATTENDANCE ====================

function TeamAttendance({ onSelectMember }) {
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
            <div className={m.dateInput}>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} className={m.inputField} />
            </div>
            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={`${s.value} ${m.colorGreen}`}>{groups.working.length}</div><div className={s.label}>Working</div></div>
                <div className={s.statCard}><div className={`${s.value} ${m.colorAmber}`}>{groups.away.length}</div><div className={s.label}>Away</div></div>
                <div className={s.statCard}><div className={s.value}>{groups.not_started.length}</div><div className={s.label}>Not Started</div></div>
                <div className={s.statCard}><div className={`${s.value} ${m.colorRed}`}>{groups.on_leave.length}</div><div className={s.label}>On Leave</div></div>
            </div>

            {loading ? <p>Loading...</p> : Object.entries(groups).map(([status, members]) => members.length > 0 && (
                <div key={status} className={m.groupSection}>
                    <h3 className={m.groupTitle}>{statusLabel[status]}</h3>
                    <div className={m.groupGrid}>
                        {members.map(m2 => (
                            <MemberCard key={m2.id} member={m2} onSelect={onSelectMember} />
                        ))}
                    </div>
                </div>
            ))}
            {!loading && data.length === 0 && <p className={m.emptyState}>No team members found. Make sure you are part of an organization.</p>}
        </>
    );
}

function MemberCard({ member, onSelect }) {
    return (
        <div
            className={m.memberCard}
            onClick={() => onSelect(member)}
        >
            <div className={m.memberCardHeader}>
                {member.avatar ? <img src={member.avatar} className={m.memberAvatar} alt="" /> : <span className={s.initials} style={{ width: 36, height: 36, fontSize: '0.75rem' }}>{member.full_name?.charAt(0)}</span>}
                <div style={{ flex: 1 }}>
                    <div className={m.memberName}>{member.full_name}</div>
                    <div className={m.memberRole}>{ROLE_LABELS[member.role] || member.role}</div>
                </div>
            </div>
            <div className={m.memberCardMeta}>
                {member.hours_today != null && <span>⏱ {member.hours_today}h</span>}
                {member.workMode && <span>{member.workMode === 'remote' ? '🏠' : '🏢'} {member.workMode}</span>}
                {member.current_task && <span className={m.taskHighlight}>• {member.current_task}</span>}
                {member.leave_type && <span>{LEAVE_ICONS[member.leave_type] || '📋'} {member.leave_type}</span>}
            </div>
        </div>
    );
}

// ==================== EMPLOYEE DASHBOARD ====================

function EmployeeDashboard({ member, onBack }) {
    const [overview, setOverview] = useState(null);
    const [tab, setTab] = useState('overview');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getMemberOverview(member.id)
            .then(r => { setOverview(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [member.id]);

    return (
        <div className={s.adminPage}>
            <div className={m.employeeHeader}>
                <button onClick={onBack} className={s.btnCancel} style={{ padding: '0.4rem 0.8rem' }}>← Back</button>
                <div className={m.employeeProfile}>
                    {member.avatar ? <img src={member.avatar} className={m.memberAvatarLg} alt="" /> : <span className={s.initials} style={{ width: 42, height: 42, fontSize: '0.9rem' }}>{member.full_name?.charAt(0)}</span>}
                    <div>
                        <h2 className={m.employeeName}>{member.full_name}</h2>
                        <span className={m.memberRole}>{ROLE_LABELS[member.role] || member.role}</span>
                    </div>
                </div>
            </div>

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'overview' ? s.active : ''}`} onClick={() => setTab('overview')}>Overview</button>
                <button className={`${s.tab} ${tab === 'leaves' ? s.active : ''}`} onClick={() => setTab('leaves')}>Leaves</button>
                <button className={`${s.tab} ${tab === 'requests' ? s.active : ''}`} onClick={() => setTab('requests')}>Requests</button>
                <button className={`${s.tab} ${tab === 'hours' ? s.active : ''}`} onClick={() => setTab('hours')}>Hours</button>
            </div>

            {loading ? <p>Loading...</p> : (
                <>
                    {tab === 'overview' && overview && <MemberOverview data={overview} />}
                    {tab === 'leaves' && <MemberLeavesTab userId={member.id} />}
                    {tab === 'requests' && <MemberRequestsTab userId={member.id} />}
                    {tab === 'hours' && <MemberHoursTab userId={member.id} />}
                </>
            )}
        </div>
    );
}

function MemberOverview({ data }) {
    return (
        <>
            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={s.value}>{data.todayHours}h</div><div className={s.label}>Today's Hours</div></div>
                <div className={s.statCard}><div className={s.value} style={{ color: '#f59e0b' }}>{data.pendingRequests}</div><div className={s.label}>Pending Requests</div></div>
                <div className={s.statCard}><div className={s.value}>{data.monthLeaves}</div><div className={s.label}>Leaves This Month</div></div>
                <div className={s.statCard}><div className={s.value}>{data.todayTasks?.length || 0}</div><div className={s.label}>Today's Tasks</div></div>
            </div>

            {data.todayTasks && data.todayTasks.length > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                    <h3 style={{ marginBottom: '0.75rem' }}>📋 Today's Tasks</h3>
                    <table className={s.table}>
                        <thead><tr><th>Task</th><th>Priority</th><th>Status</th></tr></thead>
                        <tbody>
                            {data.todayTasks.map(t => (
                                <tr key={t.id}>
                                    <td>{t.title}</td>
                                    <td><PriorityBadge priority={t.priority} /></td>
                                    <td><StatusBadge status={t.status} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {data.recentLeaves && data.recentLeaves.length > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                    <h3 style={{ marginBottom: '0.75rem' }}>🗓 Recent Leaves</h3>
                    <table className={s.table}>
                        <thead><tr><th>Date</th><th>Type</th><th>Status</th><th>Reason</th></tr></thead>
                        <tbody>
                            {data.recentLeaves.map(l => (
                                <tr key={l.id}>
                                    <td>{new Date(l.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                                    <td>{LEAVE_ICONS[l.leave_type] || ''} {l.leave_type}</td>
                                    <td><ApprovalBadge status={l.status} /></td>
                                    <td style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{l.reason || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {data.recentRequests && data.recentRequests.length > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                    <h3 style={{ marginBottom: '0.75rem' }}>📝 Recent Requests</h3>
                    <table className={s.table}>
                        <thead><tr><th>Type</th><th>Details</th><th>Status</th><th>Date</th></tr></thead>
                        <tbody>
                            {data.recentRequests.map(r => (
                                <tr key={r.id}>
                                    <td><span className={s.badgeRole}>{r.type?.replace('_', ' ')}</span></td>
                                    <td style={{ maxWidth: 300 }}><RequestDetails request={r} /></td>
                                    <td><ApprovalBadge status={r.status} /></td>
                                    <td style={{ fontSize: '0.85rem' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

function MemberLeavesTab({ userId }) {
    const [leaves, setLeaves] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const now = new Date();
        const from = `${now.getFullYear()}-01-01`;
        getMemberLeaves(userId, from)
            .then(r => { setLeaves(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <h3 style={{ marginBottom: '0.75rem' }}>Leave History</h3>
            <table className={s.table}>
                <thead><tr><th>Date</th><th>Type</th><th>Duration</th><th>Status</th><th>Reason</th></tr></thead>
                <tbody>
                    {leaves.map(l => (
                        <tr key={l.id}>
                            <td>{new Date(l.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                            <td>{LEAVE_ICONS[l.leave_type] || ''} {l.leave_type}</td>
                            <td>{l.duration || 'full'}</td>
                            <td><ApprovalBadge status={l.status} /></td>
                            <td style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{l.reason || '—'}</td>
                        </tr>
                    ))}
                    {leaves.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No leaves found</td></tr>}
                </tbody>
            </table>
        </>
    );
}

function MemberRequestsTab({ userId }) {
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getMemberRequests(userId)
            .then(r => { setRequests(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <h3 style={{ marginBottom: '0.75rem' }}>Approval Requests</h3>
            <table className={s.table}>
                <thead><tr><th>Type</th><th>Details</th><th>Status</th><th>Submitted</th><th>Reviewed By</th></tr></thead>
                <tbody>
                    {requests.map(r => (
                        <tr key={r.id}>
                            <td><span className={s.badgeRole}>{r.type?.replace('_', ' ')}</span></td>
                            <td style={{ maxWidth: 300 }}><RequestDetails request={r} /></td>
                            <td><ApprovalBadge status={r.status} /></td>
                            <td style={{ fontSize: '0.85rem' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                            <td>{r.approver_name || '—'}</td>
                        </tr>
                    ))}
                    {requests.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No requests found</td></tr>}
                </tbody>
            </table>
        </>
    );
}

function MemberHoursTab({ userId }) {
    const [hours, setHours] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const now = new Date();
        const to = now.toISOString().split('T')[0];
        const from = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];
        getMemberHours(userId, from, to)
            .then(r => { setHours(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    const totalHours = hours.reduce((acc, d) => acc + (d.floorMinutes || 0), 0) / 60;

    return (
        <>
            <h3 style={{ marginBottom: '0.75rem' }}>Hours (Last 30 Days) — Total: {totalHours.toFixed(1)}h</h3>
            <table className={s.table}>
                <thead><tr><th>Date</th><th>Floor Time</th><th>Break Time</th><th>Work Mode</th></tr></thead>
                <tbody>
                    {hours.map(d => (
                        <tr key={d.date}>
                            <td>{new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                            <td>{Math.floor(d.floorMinutes / 60)}h {d.floorMinutes % 60}m</td>
                            <td>{Math.floor(d.breakMinutes / 60)}h {d.breakMinutes % 60}m</td>
                            <td>{d.workMode === 'remote' ? '🏠 Remote' : '🏢 Office'}</td>
                        </tr>
                    ))}
                    {hours.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No data found</td></tr>}
                </tbody>
            </table>
        </>
    );
}

// ==================== APPROVALS TAB ====================

function ApprovalsTab() {
    const [approvals, setApprovals] = useState([]);
    const [filter, setFilter] = useState('pending');
    const [selected, setSelected] = useState(new Set());
    const [rejectId, setRejectId] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [loading, setLoading] = useState(true);
    const [processing, setProcessing] = useState(null); // id being processed

    const fetchApprovals = useCallback(() => {
        setLoading(true);
        getApprovals({ status: filter || undefined })
            .then(r => { setApprovals(r.data); setLoading(false); setSelected(new Set()); })
            .catch(() => setLoading(false));
    }, [filter]);

    useEffect(() => { fetchApprovals(); }, [fetchApprovals]);

    const handleApprove = async (id) => {
        if (processing) return;
        setProcessing(id);
        try { await approveRequest(id); fetchApprovals(); } catch { } finally { setProcessing(null); }
    };

    const handleReject = async () => {
        if (!rejectId || processing) return;
        setProcessing(rejectId);
        try { await rejectRequest(rejectId, rejectReason); setRejectId(null); setRejectReason(''); fetchApprovals(); } catch { } finally { setProcessing(null); }
    };

    const handleBulk = async (action) => {
        if (selected.size === 0 || processing) return;
        setProcessing('bulk');
        try { await bulkApproval(Array.from(selected), action); fetchApprovals(); } catch { } finally { setProcessing(null); }
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
                        <button className={s.btnPrimary} onClick={() => handleBulk('approve')} disabled={!!processing}>Approve ({selected.size})</button>
                        <button className={s.btnDanger} onClick={() => handleBulk('reject')} disabled={!!processing}>Reject ({selected.size})</button>
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
                        {approvals.map(a => (
                            <tr key={a.id}>
                                {filter === 'pending' && <td><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} /></td>}
                                <td><span className={s.badgeRole}>{a.type?.replace('_', ' ')}</span></td>
                                <td>
                                    <div className={s.userCell}>
                                        {a.requester_avatar ? <img src={a.requester_avatar} style={{ width: 28, height: 28, borderRadius: '50%' }} alt="" /> : <span className={s.initials}>{a.requester_name?.charAt(0)}</span>}
                                        <div><div className={s.userName}>{a.requester_name}</div></div>
                                    </div>
                                </td>
                                <td style={{ maxWidth: 300 }}><RequestDetails request={a} /></td>
                                <td style={{ fontSize: '0.85rem' }}>{new Date(a.created_at).toLocaleDateString()}</td>
                                <td><ApprovalBadge status={a.status} /></td>
                                {filter === 'pending' && (
                                    <td>
                                        <div className={s.actions}>
                                            <button className={s.btnSmall} style={{ background: '#22c55e', color: '#fff' }} onClick={() => handleApprove(a.id)} disabled={!!processing}>{processing === a.id ? '…' : '✓'}</button>
                                            <button className={s.btnSmall} style={{ background: '#ef4444', color: '#fff' }} onClick={() => setRejectId(a.id)} disabled={!!processing}>✗</button>
                                        </div>
                                    </td>
                                )}
                            </tr>
                        ))}
                        {approvals.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No {filter || ''} requests</td></tr>}
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
                            <button className={s.btnCancel} onClick={() => setRejectId(null)} disabled={!!processing}>Cancel</button>
                            <button className={s.btnDanger} onClick={handleReject} disabled={!!processing}>{processing ? 'Rejecting…' : 'Reject'}</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// ==================== TEAM ANALYTICS ====================

function TeamAnalytics({ onSelectMember }) {
    const [data, setData] = useState(null);
    const [range, setRange] = useState('7');

    useEffect(() => {
        getTeamAnalytics(range).then(r => setData(r.data)).catch(() => {});
    }, [range]);

    if (!data) return <p>Loading...</p>;

    return (
        <>
            <div style={{ marginBottom: '1rem' }}>
                <select value={range} onChange={e => setRange(e.target.value)} style={{ padding: '0.5rem 1.8rem 0.5rem 0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
                    <option value="7">This Week</option>
                    <option value="30">This Month</option>
                    <option value="90">This Quarter</option>
                </select>
            </div>

            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={s.value}>{data.totalMembers}</div><div className={s.label}>Team Members</div></div>
                <div className={s.statCard}><div className={s.value}>{data.avgHours?.toFixed(1) || 0}h</div><div className={s.label}>Avg Hours/Day</div></div>
                <div className={s.statCard}><div className={s.value}>{data.totalTasks || 0}</div><div className={s.label}>Tasks Completed</div></div>
                <div className={s.statCard}><div className={s.value} style={{ color: '#f59e0b' }}>{data.pendingApprovals || 0}</div><div className={s.label}>Pending Approvals</div></div>
            </div>

            <h3 style={{ marginTop: '1.5rem', marginBottom: '0.75rem' }}>Member Performance</h3>
            <table className={s.table}>
                <thead><tr><th>Member</th><th>Hours</th><th>Tasks Done</th><th>Leaves</th><th>Utilization</th></tr></thead>
                <tbody>
                    {(data.members || []).map(m => {
                        const util = data.expectedHours ? Math.round((m.hours / data.expectedHours) * 100) : 0;
                        return (
                            <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => onSelectMember(m)}>
                                <td>
                                    <div className={s.userCell}>
                                        {m.avatar ? <img src={m.avatar} style={{ width: 28, height: 28, borderRadius: '50%' }} alt="" /> : <span className={s.initials}>{m.full_name?.charAt(0)}</span>}
                                        <div><div className={s.userName}>{m.full_name}</div><div className={s.userEmail}>{ROLE_LABELS[m.role] || m.role}</div></div>
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

// ==================== MY REQUESTS ====================

function MyRequests() {
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getMyRequests({ status: 'all' }).then(r => { setRequests(r.data); setLoading(false); }).catch(() => setLoading(false));
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
                            <td><span className={s.badgeRole}>{r.type?.replace('_', ' ')}</span></td>
                            <td style={{ maxWidth: 300 }}><RequestDetails request={r} /></td>
                            <td><ApprovalBadge status={r.status} /></td>
                            <td style={{ fontSize: '0.85rem' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                            <td>{r.approver_name || '—'}</td>
                        </tr>
                    ))}
                    {requests.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No requests submitted</td></tr>}
                </tbody>
            </table>
        </>
    );
}

// ==================== SHARED COMPONENTS ====================

function ApprovalBadge({ status }) {
    const cls = status === 'pending' ? m.badgePending : status === 'approved' ? m.badgeApproved : status === 'rejected' ? m.badgeRejected : m.badgeDefault;
    return <span className={`${m.badge} ${cls}`}>{status}</span>;
}

function PriorityBadge({ priority }) {
    const cls = priority === 'high' ? m.badgeHigh : priority === 'medium' ? m.badgeMedium : priority === 'low' ? m.badgeLow : m.badgeDefault;
    return <span className={`${m.badgeSmall} ${cls}`}>{priority}</span>;
}

function StatusBadge({ status }) {
    const cls = status === 'done' ? m.badgeDone : status === 'in_progress' ? m.badgeInProgress : status === 'in_review' ? m.badgeInReview : m.badgeDefault;
    return <span className={`${m.badgeSmall} ${cls}`}>{status?.replace('_', ' ')}</span>;
}

function RequestDetails({ request }) {
    const meta = request.metadata;
    if (!meta) return <span>—</span>;

    if (request.type === 'leave') {
        return <span>{LEAVE_ICONS[meta.leave_type] || ''} {meta.leave_type} • {meta.date} {meta.duration && meta.duration !== 'full' ? `(${meta.duration})` : ''}</span>;
    }
    if (request.type === 'manual_entry') {
        return <span>📝 {meta.date} • {meta.clock_in}{meta.clock_out ? ` → ${meta.clock_out}` : ''} {meta.work_mode ? `(${meta.work_mode})` : ''}</span>;
    }
    if (request.type === 'overtime') {
        return <span>⏰ {meta.date} • {meta.hours}h</span>;
    }
    return <span>{JSON.stringify(meta)}</span>;
}
