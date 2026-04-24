import { useState, useMemo, useEffect } from 'react';
import { LEAVE_TYPES, STATUS_CONFIG, getLeaveType, buildLeaveTypeMeta, buildLeaveTypeOptions } from '../../constants/leaves';
import { getLeavePolicies } from '../../api';
import { fmtDate } from '../../utils/date';
import s from '../Leaves.module.css';

/**
 * Leave history panel with inline status/type filters.
 * Receives the full leaves array from the parent (already fetched for the
 * selected month) and applies UI-only filters internally.
 */
/** A leave row is treated as an auto-booked public holiday when it is a
 *  Holiday-type leave whose reason starts with the marker we write from the
 *  server (`Public holiday: <name>`). These are company-wide closures and
 *  should not appear in the personal leave history — they are surfaced on
 *  the Attendance Calendar instead. */
function isPublicHoliday(l) {
    return l && l.leave_type === 'holiday'
        && typeof l.reason === 'string'
        && l.reason.startsWith('Public holiday:');
}

export default function LeaveHistory({ leaves, loading, onWithdraw }) {
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterType, setFilterType] = useState('all');
    const [policies, setPolicies] = useState([]);

    /* Load org policies so the type filter and item rendering use whatever
       custom leave types the organisation has defined. */
    useEffect(() => {
        let cancelled = false;
        getLeavePolicies()
            .then(r => { if (!cancelled) setPolicies(r.data || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    const typeMeta = useMemo(() => buildLeaveTypeMeta(policies), [policies]);
    const typeOptions = useMemo(() => buildLeaveTypeOptions(policies), [policies]);
    /* Resolves a leave_type to its display metadata, falling back to the
       built-in helper for any unknown values. */
    const lookupType = (val) => typeMeta[val] || getLeaveType(val);

    /* Personal leaves only — public holidays auto-booked by HR are excluded
       from every count and from the visible list (they live on the Attendance
       Calendar instead). */
    const personalLeaves = useMemo(() => leaves.filter(l => !isPublicHoliday(l)), [leaves]);

    const totalDays = useMemo(() =>
        personalLeaves.reduce((acc, l) => acc + (l.duration === 'half' ? 0.5 : l.duration === 'quarter' ? 0.25 : 1), 0),
        [personalLeaves]
    );

    const filteredLeaves = useMemo(() =>
        personalLeaves.filter(l =>
            (filterStatus === 'all' || l.status === filterStatus) &&
            (filterType === 'all' || l.leave_type === filterType)
        ),
        [personalLeaves, filterStatus, filterType]
    );

    return (
        <>
            {/* Summary stats strip — counts personal leaves only (auto-booked
                public holidays are deliberately excluded). */}
            <div className={s.statsStrip}>
                <div className={s.statItem}>
                    <span className={s.statNum}>{personalLeaves.length}</span>
                    <span className={s.statLabel}>Requests</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum}>{totalDays}</span>
                    <span className={s.statLabel}>Total Days</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum} style={{ color: '#10b981' }}>{personalLeaves.filter(l => l.status === 'approved').length}</span>
                    <span className={s.statLabel}>Approved</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum} style={{ color: '#f59e0b' }}>{personalLeaves.filter(l => l.status === 'pending').length}</span>
                    <span className={s.statLabel}>Pending</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum} style={{ color: '#ef4444' }}>{personalLeaves.filter(l => l.status === 'rejected').length}</span>
                    <span className={s.statLabel}>Rejected</span>
                </div>
            </div>

            {/* Filters */}
            <div className={s.filters}>
                <div className={s.filterGroup}>
                    <label className={s.filterLabel}>Status</label>
                    <select className={s.filterSelect} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                        <option value="all">All</option>
                        <option value="pending">Pending</option>
                        <option value="approved">Approved</option>
                        <option value="rejected">Rejected</option>
                        <option value="withdraw_pending">Withdrawal Pending</option>
                    </select>
                </div>
                <div className={s.filterGroup}>
                    <label className={s.filterLabel}>Type</label>
                    <select className={s.filterSelect} value={filterType} onChange={e => setFilterType(e.target.value)}>
                        <option value="all">All Types</option>
                        {typeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                </div>
            </div>

            {/* Leave list */}
            <div className={s.card}>
                <div className={s.cardHeader}>
                    <h2 className={s.cardTitle}>Leave History</h2>
                    <span className={s.cardCount}>{filteredLeaves.length} record{filteredLeaves.length !== 1 ? 's' : ''}</span>
                </div>
                {loading ? (
                    <div className={s.loadingWrap}><div className="spinner" /></div>
                ) : filteredLeaves.length === 0 ? (
                    <div className={s.emptyState}>
                        <div className={s.emptyIcon}>📭</div>
                        <p className={s.emptyText}>No leave requests found for this period</p>
                    </div>
                ) : (
                    <div className={s.leaveList}>
                        {filteredLeaves.map(leave => {
                            const type = lookupType(leave.leave_type);
                            const status = STATUS_CONFIG[leave.status] ?? STATUS_CONFIG.pending;
                            const durLabel = leave.duration === 'half' ? 'Half Day' : leave.duration === 'quarter' ? 'Quarter Day' : 'Full Day';
                            // Public holidays are auto-booked by HR for the whole org and
                            // can't be withdrawn by individual employees — they're
                            // company-wide closures, not personal leave. The server
                            // marks these with reason starting "Public holiday:".
                            const isPublicHoliday = typeof leave.reason === 'string' && leave.reason.startsWith('Public holiday:');
                            const canWithdraw = !isPublicHoliday && (leave.status === 'pending' || leave.status === 'approved');
                            return (
                                <div key={leave.id} className={s.leaveItem}>
                                    <div className={s.leaveItemLeft}>
                                        <div className={s.leaveTypeIcon} style={{ background: type.bg, color: type.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{type.Icon && <type.Icon size={16} />}</div>
                                        <div className={s.leaveItemBody}>
                                            <div className={s.leaveItemRow}>
                                                <span className={s.leaveTypeName}>{type.label}</span>
                                                <span className={s.leaveDurBadge}>{durLabel}</span>
                                                <span className={s.leaveStatusBadge} style={{ background: status.bg, color: status.color }}>{status.label}</span>
                                            </div>
                                            <div className={s.leaveDate}>{fmtDate(leave.date)}</div>
                                            {leave.reason && <div className={s.leaveReason}>"{leave.reason}"</div>}
                                            {leave.reject_reason && <div className={s.leaveRejectReason}>Rejection reason: {leave.reject_reason}</div>}
                                            {leave.approved_by_name && leave.status === 'approved' && (
                                                <div className={s.leaveApprover}>Approved by {leave.approved_by_name}</div>
                                            )}
                                        </div>
                                    </div>
                                    {canWithdraw && (
                                        <button className={s.withdrawBtn} onClick={() => onWithdraw(leave)} title="Withdraw this leave">
                                            Withdraw
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );
}
