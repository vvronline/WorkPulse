import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getLeaves, addLeave, addLeavesBatch, withdrawLeave, getLeaveSummary, getLeaveBalances, exportMyLeaves } from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import ExportButton from '../components/ExportButton';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './Leaves.module.css';

const LEAVE_TYPES = [
  { value: 'sick', label: 'Sick Leave', icon: '🤒', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  { value: 'holiday', label: 'Holiday', icon: '🎉', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  { value: 'planned', label: 'Planned Leave', icon: '📅', color: '#6366f1', bg: 'rgba(99,102,241,0.1)' },
  { value: 'personal', label: 'Personal', icon: '👤', color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  { value: 'other', label: 'Other', icon: '📝', color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
];

const STATUS_CONFIG = {
  pending:          { label: 'Pending',            color: '#f59e0b', bg: 'rgba(245,158,11,0.12)'    },
  approved:         { label: 'Approved',           color: '#10b981', bg: 'rgba(16,185,129,0.12)'   },
  rejected:         { label: 'Rejected',           color: '#ef4444', bg: 'rgba(239,68,68,0.12)'    },
  withdraw_pending: { label: 'Withdrawal Pending', color: '#6366f1', bg: 'rgba(99,102,241,0.12)'   },
  withdrawn:        { label: 'Withdrawn',          color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)'   },
};

// Generate all dates between from and to (inclusive), skipping weekends
function getDateRange(from, to, skipWeekends = true) {
  const dates = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (skipWeekends && (dow === 0 || dow === 6)) continue;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}

function fmtDate(str) {
  return new Date(str + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function Leaves() {
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRange, setIsRange] = useState(false);
  const [date, setDate] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [leaveType, setLeaveType] = useState('sick');
  const [duration, setDuration] = useState('full');
  const [reason, setReason] = useState('');
  const [balances, setBalances] = useState([]);
  const [error, setError] = useAutoDismiss('');
  const [success, setSuccess] = useAutoDismiss('');
  const [submitting, setSubmitting] = useState(false);
  const [leaveToDelete, setLeaveToDelete] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterMonth, setFilterMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  const rangeDays = useMemo(() => {
    if (!isRange || !dateFrom || !dateTo || dateTo < dateFrom) return [];
    return getDateRange(dateFrom, dateTo, skipWeekends);
  }, [isRange, dateFrom, dateTo, skipWeekends]);

  const fetchData = useCallback(async () => {
    try {
      const [y, m] = filterMonth.split('-');
      const from = `${filterMonth}-01`;
      const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
      const to = `${filterMonth}-${lastDay}`;
      const [leavesRes, balancesRes] = await Promise.all([
        getLeaves(from, to),
        getLeaveBalances(parseInt(y)).catch(() => ({ data: [] })),
      ]);
      setLeaves(leavesRes.data);
      setBalances(balancesRes.data || []);
    } catch {
      setError('Failed to load leave data');
    } finally {
      setLoading(false);
    }
  }, [filterMonth]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (isRange) {
      if (!dateFrom || !dateTo) return setError('Both start and end dates are required');
      if (dateTo < dateFrom) return setError('End date must be after start date');
      if (rangeDays.length === 0) return setError('No valid days in the selected range');
      setSubmitting(true);
      try {
        const res = await addLeavesBatch({ dates: rangeDays, leave_type: leaveType, reason: reason.trim() || undefined, duration });
        setSuccess(res.data?.message || `${rangeDays.length} leave(s) submitted`);
        setDateFrom(''); setDateTo(''); setReason(''); setDuration('full');
        fetchData();
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to add leaves');
      } finally { setSubmitting(false); }
    } else {
      if (!date) return setError('Date is required');
      setSubmitting(true);
      try {
        const res = await addLeave({ date, leave_type: leaveType, reason: reason.trim() || undefined, duration });
        setSuccess(res.data?.message || 'Leave request submitted');
        setDate(''); setReason(''); setDuration('full');
        fetchData();
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to add leave');
      } finally { setSubmitting(false); }
    }
  };

  const confirmDelete = async () => {
    if (!leaveToDelete) return;
    try {
      const res = await withdrawLeave(leaveToDelete.id);
      setSuccess(res.data?.message || 'Withdrawal request submitted');
      setLeaveToDelete(null);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to withdraw leave');
      setLeaveToDelete(null);
    }
  };

  const getType = (val) => LEAVE_TYPES.find(t => t.value === val) || LEAVE_TYPES[4];

  // Stats from filtered month leaves
  const totalDays = useMemo(() => {
    return leaves.reduce((acc, l) => acc + (l.duration === 'half' ? 0.5 : l.duration === 'quarter' ? 0.25 : 1), 0);
  }, [leaves]);

  const filteredLeaves = useMemo(() => {
    return leaves.filter(l =>
      (filterStatus === 'all' || l.status === filterStatus) &&
      (filterType === 'all' || l.leave_type === filterType)
    );
  }, [leaves, filterStatus, filterType]);

  return (
    <div className={s.page}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Leave Management</h1>
          <p className={s.subtitle}>Request time off, track approvals, and view your leave history</p>
        </div>
        <div className={s.headerRight}>
          <ExportButton
            fetchFn={exportMyLeaves}
            params={{ year: filterMonth.split('-')[0] }}
            label="Export Leaves"
          />
          <input
            type="month"
            value={filterMonth}
            onChange={(e) => setFilterMonth(e.target.value)}
            className={s.monthPicker}
          />
        </div>
      </div>

      {/* ── Balance Cards ── */}
      {balances.length > 0 && (
        <div className={s.balanceRow}>
          {balances.map(b => {
            const type = getType(b.leave_type);
            const total = (b.quota || 0) + (b.carried_forward || 0);
            const used = b.used || 0;
            const available = total - used;
            const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
            return (
              <div key={`${b.leave_type}-${b.year}`} className={s.balanceCard} style={{ '--lc': type.color, '--lb': type.bg }}>
                <div className={s.balanceIcon}>{type.icon}</div>
                <div className={s.balanceInfo}>
                  <div className={s.balanceType}>{type.label}</div>
                  <div className={s.balanceNumbers}>
                    <span className={s.balanceAvail}>{available}</span>
                    <span className={s.balanceOf}>of {total} available</span>
                  </div>
                  <div className={s.progressBar}>
                    <div
                      className={s.progressFill}
                      style={{
                        width: `${pct}%`,
                        background: pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : type.color,
                      }}
                    />
                  </div>
                  <div className={s.balanceMeta}>{used} used · {b.carried_forward || 0} carried forward</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className={s.layout}>
        {/* ── Request Form ── */}
        <aside className={s.sidebar}>
          <div className={s.card}>
            <div className={s.cardHeader}>
              <h2 className={s.cardTitle}>New Leave Request</h2>
            </div>

            {error && <div className={s.alertError}>{error}</div>}
            {success && <div className={s.alertSuccess}>{success}</div>}

            <form onSubmit={handleSubmit} className={s.form}>
              {/* Mode Toggle */}
              <div className={s.segmented}>
                <button type="button" className={`${s.segBtn} ${!isRange ? s.segActive : ''}`} onClick={() => setIsRange(false)}>Single Day</button>
                <button type="button" className={`${s.segBtn} ${isRange ? s.segActive : ''}`} onClick={() => setIsRange(true)}>Date Range</button>
              </div>

              {/* Date */}
              {!isRange ? (
                <div className={s.field}>
                  <label className={s.label}>Date</label>
                  <input type="date" className={s.input} value={date} onChange={e => setDate(e.target.value)} required />
                </div>
              ) : (
                <div className={s.dateRangeGroup}>
                  <div className={s.field}>
                    <label className={s.label}>From</label>
                    <input type="date" className={s.input} value={dateFrom} onChange={e => { setDateFrom(e.target.value); if (dateTo && e.target.value > dateTo) setDateTo(e.target.value); }} required />
                  </div>
                  <div className={s.rangeSep}>→</div>
                  <div className={s.field}>
                    <label className={s.label}>To</label>
                    <input type="date" className={s.input} value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} required />
                  </div>
                  <label className={s.checkRow}>
                    <input type="checkbox" checked={skipWeekends} onChange={e => setSkipWeekends(e.target.checked)} />
                    <span>Skip weekends</span>
                  </label>
                  {rangeDays.length > 0 && (
                    <div className={s.rangePreview}>
                      <span className={s.rangeCount}>{rangeDays.length}</span>
                      <span> working day{rangeDays.length !== 1 ? 's' : ''} selected</span>
                    </div>
                  )}
                </div>
              )}

              {/* Leave Type */}
              <div className={s.field}>
                <label className={s.label}>Leave Type</label>
                <div className={s.typeGrid}>
                  {LEAVE_TYPES.map(t => (
                    <button
                      key={t.value}
                      type="button"
                      className={`${s.typeChip} ${leaveType === t.value ? s.typeChipActive : ''}`}
                      style={{ '--lc': t.color, '--lb': t.bg }}
                      onClick={() => setLeaveType(t.value)}
                    >
                      <span className={s.typeEmoji}>{t.icon}</span>
                      <span className={s.typeLabel}>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration */}
              <div className={s.field}>
                <label className={s.label}>Duration</label>
                <div className={s.segmented}>
                  <button type="button" className={`${s.segBtn} ${duration === 'full' ? s.segActive : ''}`} onClick={() => setDuration('full')}>Full Day</button>
                  <button type="button" className={`${s.segBtn} ${duration === 'half' ? s.segActive : ''}`} onClick={() => setDuration('half')}>Half Day</button>
                  <button type="button" className={`${s.segBtn} ${duration === 'quarter' ? s.segActive : ''}`} onClick={() => setDuration('quarter')}>Quarter</button>
                </div>
              </div>

              {/* Reason */}
              <div className={s.field}>
                <label className={s.label}>Reason <span className={s.optional}>(optional)</span></label>
                <textarea
                  className={s.textarea}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="Briefly describe your reason…"
                  rows={3}
                />
              </div>

              <button type="submit" className={s.submitBtn} disabled={submitting}>
                {submitting ? 'Submitting…' : isRange ? `Submit ${rangeDays.length || ''} Request${rangeDays.length !== 1 ? 's' : ''}` : 'Submit Request'}
              </button>
            </form>
          </div>
        </aside>

        {/* ── History Panel ── */}
        <main className={s.main}>
          {/* Month Stats */}
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

          {/* Leave List */}
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
                  const type = getType(leave.leave_type);
                  const status = STATUS_CONFIG[leave.status] || STATUS_CONFIG.pending;
                  const durLabel = leave.duration === 'half' ? 'Half Day' : leave.duration === 'quarter' ? 'Quarter Day' : 'Full Day';
                  return (
                    <div key={leave.id} className={s.leaveItem}>
                      <div className={s.leaveItemLeft}>
                        <div className={s.leaveTypeIcon} style={{ background: type.bg, color: type.color }}>{type.icon}</div>
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
                        <button className={s.withdrawBtn} onClick={() => setLeaveToDelete(leave)} title="Withdraw this leave">
                          Withdraw
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      <ConfirmDialog
        isOpen={!!leaveToDelete}
        title="Withdraw Leave Request"
        message={`Withdraw your ${leaveToDelete?.leave_type || ''} leave for ${leaveToDelete ? fmtDate(leaveToDelete.date) : ''}?${leaveToDelete?.status === 'approved' ? ' This requires manager approval.' : ''}`}
        confirmText="Withdraw"
        onConfirm={confirmDelete}
        onCancel={() => setLeaveToDelete(null)}
      />
    </div>
  );
}
