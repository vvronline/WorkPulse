import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    getTeamAttendance, getTeamAnalytics, getApprovals, getMyRequests,
    approveRequest, rejectRequest, bulkApproval, getMemberHours, getMemberTasks,
    getMemberOverview, getMemberLeaves, getMemberRequests
} from '../api';
import s from './Admin.module.css';
import m from './ManagerDashboard.module.css';

const ROLE_LABELS = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr_admin: 'HR Admin', super_admin: 'Super Admin' };
const STATUS_COLORS = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)' };
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

    const user = overview?.user || member;

    return (
        <div className={s.adminPage}>
            <div className={m.employeeHeader}>
                <button onClick={onBack} className={s.btnCancel} style={{ padding: '0.4rem 0.8rem' }}>← Back</button>
                <div className={m.employeeProfile}>
                    {user.avatar ? <img src={user.avatar} className={m.memberAvatarLg} alt="" /> : <span className={s.initials} style={{ width: 42, height: 42, fontSize: '0.9rem' }}>{user.full_name?.charAt(0)}</span>}
                    <div>
                        <h2 className={m.employeeName}>{user.full_name}</h2>
                        <div className={m.employeeMeta}>
                            <span className={m.memberRole}>{ROLE_LABELS[user.role] || user.role}</span>
                            {user.email && <span className={m.metaDot}>· {user.email}</span>}
                            {user.department_name && <span className={m.metaDot}>· {user.department_name}</span>}
                            {user.team_name && <span className={m.metaDot}>· {user.team_name}</span>}
                        </div>
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
    const stats = data.stats30d || {};
    const taskStats = data.monthTaskStats || {};

    return (
        <>
            {/* Quick Stats */}
            <div className={m.summaryGrid}>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>⏱</div>
                    <div className={m.summaryValue}>{data.todayHours}h</div>
                    <div className={m.summaryLabel}>Today's Hours</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>☕</div>
                    <div className={m.summaryValue}>{formatMin(data.todayBreakMin || 0)}</div>
                    <div className={m.summaryLabel}>Today's Break</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>📋</div>
                    <div className={`${m.summaryValue} ${m.colorAmber}`}>{data.pendingRequests}</div>
                    <div className={m.summaryLabel}>Pending Requests</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>🗓</div>
                    <div className={m.summaryValue}>{data.monthLeaves}</div>
                    <div className={m.summaryLabel}>Leaves This Month</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>✅</div>
                    <div className={m.summaryValue}>{data.todayTasks?.length || 0}</div>
                    <div className={m.summaryLabel}>Today's Tasks</div>
                </div>
            </div>

            {/* Weekly Trend */}
            {data.weeklyTrend && data.weeklyTrend.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Weekly Trend (Last 7 Days)</h3>
                    <div className={m.weeklyTrendGrid}>
                        {data.weeklyTrend.map((day, i) => {
                            const maxMin = Math.max(...data.weeklyTrend.map(d => d.floorMinutes || 0), 480, 1);
                            const barH = ((day.floorMinutes || 0) / maxMin) * 100;
                            return (
                                <div key={i} className={m.weeklyDayCol}>
                                    <div className={m.weeklyBarContainer}>
                                        <div className={m.weeklyBar} style={{ height: `${barH}%`, background: day.floorMinutes >= 480 ? 'var(--success)' : day.floorMinutes > 0 ? 'var(--warning)' : 'var(--border)' }} />
                                    </div>
                                    <div className={m.weeklyDayLabel}>{day.dayLabel}</div>
                                    <div className={m.weeklyDayHours}>{formatMin(day.floorMinutes)}</div>
                                    {day.workMode && <div className={m.weeklyDayMode}>{day.workMode === 'remote' ? '🏠' : '🏢'}</div>}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 30-Day Stats */}
            {stats.daysWorked !== undefined && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>30-Day Performance</h3>
                    <div className={m.perfGrid}>
                        <div className={m.perfItem}>
                            <span className={m.perfValue}>{stats.daysWorked}</span>
                            <span className={m.perfLabel}>Days Worked</span>
                        </div>
                        <div className={m.perfItem}>
                            <span className={m.perfValue}>{formatMin(stats.totalFloorMinutes)}</span>
                            <span className={m.perfLabel}>Total Floor Time</span>
                        </div>
                        <div className={m.perfItem}>
                            <span className={m.perfValue}>{formatMin(stats.avgFloorMinutes)}</span>
                            <span className={m.perfLabel}>Avg Floor/Day</span>
                        </div>
                        <div className={m.perfItem}>
                            <span className={m.perfValue}>{formatMin(stats.avgBreakMinutes)}</span>
                            <span className={m.perfLabel}>Avg Break/Day</span>
                        </div>
                        <div className={m.perfItem}>
                            <span className={m.perfValue}>{stats.targetMetPercent}%</span>
                            <span className={m.perfLabel}>Target Met</span>
                        </div>
                        <div className={m.perfItem}>
                            <span className={m.perfValue}>{stats.punctualityPercent}%</span>
                            <span className={m.perfLabel}>Punctuality</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Task Stats + Leave Balances side-by-side */}
            <div className={m.twoColSection}>
                {taskStats.total !== undefined && (
                    <div className={m.overviewSection}>
                        <h3 className={m.sectionTitle}>Tasks This Month</h3>
                        <div className={m.taskStatsGrid}>
                            <div className={m.taskStatCard}><span className={m.taskStatNum}>{taskStats.total}</span><span className={m.taskStatLbl}>Total</span></div>
                            <div className={m.taskStatCard}><span className={`${m.taskStatNum} ${m.colorGreen}`}>{taskStats.done}</span><span className={m.taskStatLbl}>Done</span></div>
                            <div className={m.taskStatCard}><span className={`${m.taskStatNum} ${m.colorAmber}`}>{taskStats.inProgress}</span><span className={m.taskStatLbl}>In Progress</span></div>
                            <div className={m.taskStatCard}><span className={m.taskStatNum}>{taskStats.completionRate}%</span><span className={m.taskStatLbl}>Completion</span></div>
                        </div>
                    </div>
                )}

                {data.leaveBalances && data.leaveBalances.length > 0 && (
                    <div className={m.overviewSection}>
                        <h3 className={m.sectionTitle}>Leave Balances</h3>
                        <div className={m.leaveBalanceList}>
                            {data.leaveBalances.map((lb, i) => {
                                const used = lb.used || 0;
                                const total = lb.total_days || 0;
                                const pct = total > 0 ? Math.round((used / total) * 100) : 0;
                                return (
                                    <div key={i} className={m.leaveBalanceRow}>
                                        <div className={m.lbInfo}>
                                            <span className={m.lbName}>{LEAVE_ICONS[lb.leave_type] || '📋'} {lb.policy_name || lb.leave_type}</span>
                                            <span className={m.lbCount}>{used}/{total} used</span>
                                        </div>
                                        <div className={m.lbBarTrack}>
                                            <div className={m.lbBarFill} style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 90 ? 'var(--danger)' : pct >= 60 ? 'var(--warning)' : 'var(--success)' }} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Today's Tasks */}
            {data.todayTasks && data.todayTasks.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Today's Tasks</h3>
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

            {/* Recent Leaves */}
            {data.recentLeaves && data.recentLeaves.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Recent Leaves</h3>
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

            {/* Recent Requests */}
            {data.recentRequests && data.recentRequests.length > 0 && (
                <div className={m.overviewSection}>
                    <h3 className={m.sectionTitle}>Recent Requests</h3>
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
                                            <button className={`${s.btnSmall} ${s.btnSuccess}`} onClick={() => handleApprove(a.id)} disabled={!!processing}>{processing === a.id ? '…' : '✓'}</button>
                                            <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => setRejectId(a.id)} disabled={!!processing}>✗</button>
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
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [search, setSearch] = useState('');
    const [sortBy, setSortBy] = useState('hours');
    const [sortAsc, setSortAsc] = useState(false);
    const [expandedId, setExpandedId] = useState(null);
    const [filterDept, setFilterDept] = useState('');

    useEffect(() => {
        if (range === 'custom') {
            if (customFrom && customTo && customFrom <= customTo) {
                getTeamAnalytics(null, customFrom, customTo).then(r => setData(r.data)).catch(e => console.error(e));
            }
            return;
        }
        getTeamAnalytics(range).then(r => setData(r.data)).catch(e => console.error(e));
    }, [range, customFrom, customTo]);

    const handleRangeChange = (val) => {
        setRange(val);
        if (val !== 'custom') { setCustomFrom(''); setCustomTo(''); }
    };

    const departments = useMemo(() => {
        if (!data?.members) return [];
        const depts = new Set(data.members.map(m => m.department_name).filter(Boolean));
        return [...depts].sort();
    }, [data]);

    const filteredMembers = useMemo(() => {
        if (!data?.members) return [];
        let list = data.members;
        if (search) {
            const q = search.toLowerCase();
            list = list.filter(m => m.full_name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q) || m.role?.toLowerCase().includes(q));
        }
        if (filterDept) list = list.filter(m => m.department_name === filterDept);
        list = [...list].sort((a, b) => {
            let av = a[sortBy], bv = b[sortBy];
            if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
            return sortAsc ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
        });
        return list;
    }, [data, search, filterDept, sortBy, sortAsc]);

    const handleSort = (col) => {
        if (sortBy === col) setSortAsc(!sortAsc);
        else { setSortBy(col); setSortAsc(false); }
    };
    const SortIcon = ({ col }) => sortBy === col ? (sortAsc ? ' ▲' : ' ▼') : '';

    if (!data) return <p>Loading...</p>;

    const rangeLabel = range === '7' ? 'This Week' : range === '30' ? 'This Month' : range === '90' ? 'This Quarter' : (customFrom && customTo) ? `${customFrom} — ${customTo}` : 'Custom Range';

    return (
        <>
            {/* Controls */}
            <div className={m.analyticsToolbar}>
                <select value={range} onChange={e => handleRangeChange(e.target.value)} className={m.selectField}>
                    <option value="7">This Week</option>
                    <option value="30">This Month</option>
                    <option value="90">This Quarter</option>
                    <option value="custom">Custom Range</option>
                </select>
                {range === 'custom' && (
                    <div className={m.dateRangePicker}>
                        <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={m.inputField} max={customTo || undefined} />
                        <span className={m.dateRangeSep}>to</span>
                        <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className={m.inputField} min={customFrom || undefined} max={new Date().toISOString().split('T')[0]} />
                    </div>
                )}
                <input placeholder="Search members..." value={search} onChange={e => setSearch(e.target.value)} className={m.inputField} />
                {departments.length > 0 && (
                    <select value={filterDept} onChange={e => setFilterDept(e.target.value)} className={m.selectField}>
                        <option value="">All Departments</option>
                        {departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                )}
            </div>

            {/* Team Summary Cards */}
            <div className={m.summaryGrid}>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>👥</div>
                    <div className={m.summaryValue}>{data.totalMembers}</div>
                    <div className={m.summaryLabel}>Team Members</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>⏱</div>
                    <div className={m.summaryValue}>{data.avgHours?.toFixed(1) || 0}h</div>
                    <div className={m.summaryLabel}>Avg Hours/Day</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>✅</div>
                    <div className={m.summaryValue}>{data.totalTasksDone || 0}</div>
                    <div className={m.summaryLabel}>Tasks Completed</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>🎯</div>
                    <div className={m.summaryValue}>{data.avgTargetMet || 0}%</div>
                    <div className={m.summaryLabel}>Avg Target Met</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>⏰</div>
                    <div className={m.summaryValue}>{data.avgPunctuality || 0}%</div>
                    <div className={m.summaryLabel}>Avg Punctuality</div>
                </div>
                <div className={m.summaryCard}>
                    <div className={m.summaryIcon}>📋</div>
                    <div className={`${m.summaryValue} ${m.colorAmber}`}>{data.pendingApprovals || 0}</div>
                    <div className={m.summaryLabel}>Pending Approvals</div>
                </div>
            </div>

            {/* Member Table */}
            <h3 className={m.sectionTitle}>Member Performance — {rangeLabel} <span className={m.memberCount}>({filteredMembers.length})</span></h3>
            <div className={m.tableWrap}>
                <table className={m.analyticsTable}>
                    <thead>
                        <tr>
                            <th onClick={() => handleSort('full_name')} className={m.sortable}>Member<SortIcon col="full_name" /></th>
                            <th>Today</th>
                            <th onClick={() => handleSort('hours')} className={m.sortable}>Total Hours<SortIcon col="hours" /></th>
                            <th onClick={() => handleSort('avgFloorMinutes')} className={m.sortable}>Avg/Day<SortIcon col="avgFloorMinutes" /></th>
                            <th onClick={() => handleSort('tasksDone')} className={m.sortable}>Tasks<SortIcon col="tasksDone" /></th>
                            <th onClick={() => handleSort('targetMetPercent')} className={m.sortable}>Target Met<SortIcon col="targetMetPercent" /></th>
                            <th onClick={() => handleSort('punctualityPercent')} className={m.sortable}>Punctuality<SortIcon col="punctualityPercent" /></th>
                            <th>Trend</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredMembers.map(mem => (
                            <React.Fragment key={mem.id}>
                                <tr className={m.memberRow} onClick={() => setExpandedId(expandedId === mem.id ? null : mem.id)}>
                                    <td>
                                        <div className={m.memberInfo}>
                                            {mem.avatar ? <img src={mem.avatar} className={m.memberAvatarSm} alt="" /> : <span className={m.avatarPlaceholder}>{mem.full_name?.charAt(0)}</span>}
                                            <div>
                                                <div className={m.memberNameCol}>{mem.full_name}</div>
                                                <div className={m.memberMeta}>
                                                    {ROLE_LABELS[mem.role] || mem.role}
                                                    {mem.department_name && <> · {mem.department_name}</>}
                                                    {mem.team_name && <> · {mem.team_name}</>}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td><TodayStatusBadge status={mem.todayStatus} minutes={mem.todayHoursMin} /></td>
                                    <td className={m.numCell}>{mem.hours?.toFixed(1)}h</td>
                                    <td className={m.numCell}>{formatMin(mem.avgFloorMinutes)}</td>
                                    <td className={m.numCell}>
                                        <span className={m.tasksPill}>{mem.tasksDone}<span className={m.tasksSep}>/{mem.tasksTotal}</span></span>
                                    </td>
                                    <td><PercentBar value={mem.targetMetPercent} /></td>
                                    <td><PercentBar value={mem.punctualityPercent} color="blue" /></td>
                                    <td><MiniTrend data={mem.trend} target={data.targetMinutes} /></td>
                                    <td>
                                        <button className={m.viewBtn} onClick={(e) => { e.stopPropagation(); onSelectMember(mem); }} title="View full profile">→</button>
                                    </td>
                                </tr>
                                {expandedId === mem.id && (
                                    <tr className={m.expandedRow}>
                                        <td colSpan={9}>
                                            <MemberExpandedCard member={mem} targetMinutes={data.targetMinutes} expectedWeekdays={data.expectedWeekdays} />
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        ))}
                        {filteredMembers.length === 0 && (
                            <tr><td colSpan={9} className={m.emptyState}>No members match your filters</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
}

function TodayStatusBadge({ status, minutes }) {
    const config = {
        working: { label: 'Working', cls: 'badgeApproved', icon: '🟢' },
        on_break: { label: 'Break', cls: 'badgePending', icon: '🟡' },
        on_leave: { label: 'On Leave', cls: 'badgeRejected', icon: '🔴' },
        left: { label: 'Left', cls: 'badgeDefault', icon: '⚪' },
        absent: { label: 'Absent', cls: 'badgeDefault', icon: '⚫' },
    };
    const c = config[status] || config.absent;
    return (
        <div className={m.todayStatus}>
            <span className={`${m.badge} ${m[c.cls]}`}>{c.icon} {c.label}</span>
            {minutes > 0 && <span className={m.todayMins}>{formatMin(minutes)}</span>}
        </div>
    );
}

function PercentBar({ value, color }) {
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

function MiniTrend({ data, target }) {
    if (!data || data.length === 0) return <span className={m.muted}>—</span>;
    const max = Math.max(...data, target || 480, 1);
    return (
        <div className={m.miniTrend}>
            {data.map((val, i) => (
                <div key={i} className={m.trendBarWrap} title={`${formatMin(val)}`}>
                    <div
                        className={m.trendBar}
                        style={{
                            height: `${Math.max((val / max) * 28, 2)}px`,
                            background: val >= (target || 480) ? 'var(--success)' : val > 0 ? 'var(--warning)' : 'var(--border)',
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

function MemberExpandedCard({ member: mem, targetMinutes, expectedWeekdays }) {
    const utilization = expectedWeekdays > 0 ? Math.round((mem.hours / (expectedWeekdays * (targetMinutes / 60))) * 100) : 0;
    return (
        <div className={m.expandedContent}>
            <div className={m.expandedGrid}>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Email</span>
                    <span className={m.expandedStatValue}>{mem.email || '—'}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Department</span>
                    <span className={m.expandedStatValue}>{mem.department_name || '—'}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Team</span>
                    <span className={m.expandedStatValue}>{mem.team_name || '—'}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Days Worked</span>
                    <span className={m.expandedStatValue}>{mem.daysWorked}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Target Met</span>
                    <span className={m.expandedStatValue}>{mem.targetMetDays}/{mem.daysWorked} days</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Avg Break</span>
                    <span className={m.expandedStatValue}>{formatMin(mem.avgBreakMinutes)}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Work Mode</span>
                    <span className={m.expandedStatValue}>🏢 {mem.officeDays} · 🏠 {mem.remoteDays}</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Utilization</span>
                    <span className={m.expandedStatValue}>{utilization}%</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Current Streak</span>
                    <span className={m.expandedStatValue}>{mem.streak} day{mem.streak !== 1 ? 's' : ''} 🔥</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Task Completion</span>
                    <span className={m.expandedStatValue}>{mem.taskCompletionRate}% ({mem.tasksDone}/{mem.tasksTotal})</span>
                </div>
                <div className={m.expandedStat}>
                    <span className={m.expandedStatLabel}>Leaves</span>
                    <span className={m.expandedStatValue}>
                        {mem.leaves} total
                        {mem.leavesByType && Object.keys(mem.leavesByType).length > 0 && (
                            <span className={m.leaveBreakdown}>
                                {Object.entries(mem.leavesByType).map(([type, count]) => (
                                    <span key={type} className={m.leaveChip}>{LEAVE_ICONS[type] || '📋'} {count}</span>
                                ))}
                            </span>
                        )}
                    </span>
                </div>
            </div>
        </div>
    );
}

function formatMin(totalMin) {
    if (!totalMin) return '0h 0m';
    const h = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return `${h}h ${mins}m`;
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
