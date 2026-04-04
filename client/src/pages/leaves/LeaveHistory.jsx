import { useState, useMemo } from 'react';
import { LEAVE_TYPES, STATUS_CONFIG, getLeaveType } from '../../constants/leaves';
import { fmtDate } from '../../utils/date';
import s from '../Leaves.module.css';

/**
 * Leave history panel with inline status/type filters.
 * Receives the full leaves array from the parent (already fetched for the
 * selected month) and applies UI-only filters internally.
 */
export default function LeaveHistory({ leaves, loading, onWithdraw }) {
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterType, setFilterType] = useState('all');

    const totalDays = useMemo(() =>
        leaves.reduce((acc, l) => acc + (l.duration === 'half' ? 0.5 : l.duration === 'quarter' ? 0.25 : 1), 0),
        [leaves]
    );

    const filteredLeaves = useMemo(() =>
        leaves.filter(l =>
            (filterStatus === 'all' || l.status === filterStatus) &&
            (filterType === 'all' || l.leave_type === filterType)
        ),
        [leaves, filterStatus, filterType]
    );

    return (
        <>
            {/* Summary stats strip */}
            <div className={s.statsStrip}>
                <div className={s.statItem}>
                    <span className={s.statNum}>{leaves.length}</span>
                    <span className={s.statLabel}>Requests</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum}>{totalDays}</span>
                    <span className={s.statLabel}>Total Days</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum} style={{ color: '#10b981' }}>{leaves.filter(l => l.status === 'approved').length}</span>
                    <span className={s.statLabel}>Approved</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum} style={{ color: '#f59e0b' }}>{leaves.filter(l => l.status === 'pending').length}</span>
                    <span className={s.statLabel}>Pending</span>
                </div>
                <div className={s.statDivider} />
                <div className={s.statItem}>
                    <span className={s.statNum} style={{ color: '#ef4444' }}>{leaves.filter(l => l.status === 'rejected').length}</span>
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
                        {LEAVE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
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
                            const type = getLeaveType(leave.leave_type);
                            const status = STATUS_CONFIG[leave.status] ?? STATUS_CONFIG.pending;
                            const durLabel = leave.duration === 'half' ? 'Half Day' : leave.duration === 'quarter' ? 'Quarter Day' : 'Full Day';
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
                                    {(leave.status === 'pending' || leave.status === 'approved') && (
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
