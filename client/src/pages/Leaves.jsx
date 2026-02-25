import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getLeaves, addLeave, addLeavesBatch, deleteLeave, getLeaveSummary } from '../api';
import s from './Leaves.module.css';

const LEAVE_TYPES = [
  { value: 'sick', label: 'Sick Leave', icon: '🤒', color: '#ef4444' },
  { value: 'holiday', label: 'Holiday', icon: '🎉', color: '#f59e0b' },
  { value: 'planned', label: 'Planned Leave', icon: '📅', color: '#6366f1' },
  { value: 'personal', label: 'Personal', icon: '👤', color: '#8b5cf6' },
  { value: 'other', label: 'Other', icon: '📝', color: '#64748b' },
];

// Generate all dates between from and to (inclusive), skipping weekends
function getDateRange(from, to, skipWeekends = true) {
  const dates = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (skipWeekends && (dow === 0 || dow === 6)) continue;
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export default function Leaves() {
  const [leaves, setLeaves] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isRange, setIsRange] = useState(false);
  const [date, setDate] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [leaveType, setLeaveType] = useState('sick');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [filterMonth, setFilterMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  // Preview how many days are in the selected range
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

      const [leavesRes, summaryRes] = await Promise.all([
        getLeaves(from, to),
        getLeaveSummary(parseInt(m), parseInt(y)),
      ]);
      setLeaves(leavesRes.data);
      setSummary(summaryRes.data);
    } catch {
      setError('Failed to load leave data');
    } finally {
      setLoading(false);
    }
  }, [filterMonth]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!leaveType) {
      setError('Leave type is required');
      return;
    }

    if (isRange) {
      if (!dateFrom || !dateTo) {
        setError('Both start and end dates are required');
        return;
      }
      if (dateTo < dateFrom) {
        setError('End date must be after start date');
        return;
      }
      if (rangeDays.length === 0) {
        setError('No valid days in the selected range (all weekends?)');
        return;
      }

      setSubmitting(true);
      try {
        const res = await addLeavesBatch({ dates: rangeDays, leave_type: leaveType, reason: reason.trim() || undefined });
        setSuccess(res.data.message || `${rangeDays.length} leave(s) added!`);
        setDateFrom('');
        setDateTo('');
        setReason('');
        fetchData();
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to add leaves');
      } finally {
        setSubmitting(false);
      }
    } else {
      if (!date) {
        setError('Date is required');
        return;
      }

      setSubmitting(true);
      try {
        await addLeave({ date, leave_type: leaveType, reason: reason.trim() || undefined });
        setSuccess('Leave added successfully!');
        setDate('');
        setReason('');
        fetchData();
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to add leave');
      } finally {
        setSubmitting(false);
      }
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteLeave(id);
      fetchData();
    } catch {
      setError('Failed to delete leave');
    }
  };

  const getType = (val) => LEAVE_TYPES.find(t => t.value === val) || LEAVE_TYPES[4];

  return (
    <div className={s['leaves-page']}>
      <div className={s['leaves-header']}>
        <h2><span className="page-icon">🗓</span> Leave Management</h2>
        <p>Track sick days, holidays, and planned leaves</p>
      </div>

      <div className={s['leaves-grid']}>
        {/* Add Leave Form */}
        <div className={s['leaves-card']}>
          <h3>➕ Add Leave</h3>

          {error && <div className="error-msg">{error}</div>}
          {success && <div className="success-msg">{success}</div>}

          <form onSubmit={handleSubmit}>
            {/* Single / Range Toggle */}
            <div className={s['leave-mode-toggle']}>
              <button
                type="button"
                className={`${s['mode-btn']} ${!isRange ? s.active : ''}`}
                onClick={() => setIsRange(false)}
              >
                📅 Single Day
              </button>
              <button
                type="button"
                className={`${s['mode-btn']} ${isRange ? s.active : ''}`}
                onClick={() => setIsRange(true)}
              >
                📆 Date Range
              </button>
            </div>

            {/* Date Inputs */}
            {!isRange ? (
              <div className="form-group">
                <label>Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
            ) : (
              <>
                <div className={s['leave-date-range-row']}>
                  <div className="form-group">
                    <label>From</label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => {
                        setDateFrom(e.target.value);
                        if (dateTo && e.target.value > dateTo) setDateTo(e.target.value);
                      }}
                      required
                    />
                  </div>
                  <span className={s['leave-range-arrow']}>→</span>
                  <div className="form-group">
                    <label>To</label>
                    <input
                      type="date"
                      value={dateTo}
                      min={dateFrom || undefined}
                      onChange={(e) => setDateTo(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="checkbox-label checkbox-label-mb">
                  <input
                    id="skipWeekends"
                    type="checkbox"
                    checked={skipWeekends}
                    onChange={(e) => setSkipWeekends(e.target.checked)}
                  />
                  <label htmlFor="skipWeekends">Skip weekends (Sat & Sun)</label>
                </div>
                {rangeDays.length > 0 && (
                  <div className={s['leave-range-preview']}>
                    <span className={s['leave-range-count']}>{rangeDays.length}</span>
                    <span>day{rangeDays.length !== 1 ? 's' : ''} will be added</span>
                  </div>
                )}
              </>
            )}

            <div className="form-group">
              <label>Leave Type</label>
              <div className={s['leave-type-grid']}>
                {LEAVE_TYPES.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    className={`${s['leave-type-btn']} ${leaveType === t.value ? s.active : ''}`}
                    onClick={() => setLeaveType(t.value)}
                    style={{ '--type-color': t.color }}
                  >
                    <span className={s['leave-type-icon']}>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label>Reason (optional)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are you taking leave?"
                rows={2}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving...' : isRange ? `✓ Add ${rangeDays.length} Leave${rangeDays.length !== 1 ? 's' : ''}` : '✓ Add Leave'}
            </button>
          </form>
        </div>

        {/* Stats + History */}
        <div className={s['leaves-right']}>
          {/* Monthly Summary */}
          <div className={s['leaves-card']}>
            <div className={s['leaves-summary-header']}>
              <h3>📊 Monthly Summary</h3>
              <input
                type="month"
                value={filterMonth}
                onChange={(e) => setFilterMonth(e.target.value)}
                className={s['month-picker']}
              />
            </div>

            {summary && (
              <div className={s['leave-stats']}>
                <div className={s['leave-stat-total']}>
                  <span className={s['leave-stat-num']}>{summary.total}</span>
                  <span className={s['leave-stat-label']}>Total Leaves</span>
                </div>
                <div className={s['leave-breakdown']}>
                  {summary.weekendDays > 0 && (
                    <div className={s['leave-breakdown-item']}>
                      <span>🏖</span>
                      <span>Weekend Holidays</span>
                      <span className={s['leave-breakdown-count']} style={{ '--type-color': '#22d3ee' }}>{summary.weekendDays}</span>
                    </div>
                  )}
                  {summary.breakdown.map(b => {
                    const type = getType(b.leave_type);
                    return (
                      <div key={b.leave_type} className={s['leave-breakdown-item']}>
                        <span>{type.icon}</span>
                        <span>{type.label}</span>
                        <span className={s['leave-breakdown-count']} style={{ '--type-color': type.color }}>{b.count}</span>
                      </div>
                    );
                  })}
                  {summary.breakdown.length === 0 && summary.weekendDays === 0 && (
                    <p className={s['leave-empty']}>No leaves this month 🎯</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Leave History */}
          <div className={s['leaves-card']}>
            <h3>📋 Leave History</h3>
            {loading ? (
              <div className="loading-spinner"><div className="spinner"></div></div>
            ) : leaves.length === 0 ? (
              <p className={s['leave-empty']}>No leaves recorded for this month</p>
            ) : (
              <div className={s['leave-list']}>
                {leaves.map(leave => {
                  const type = getType(leave.leave_type);
                  return (
                    <div key={leave.id} className={s['leave-item']}>
                      <div className={s['leave-item-icon']} style={{ '--type-bg': type.color + '20', '--type-color': type.color }}>
                        {type.icon}
                      </div>
                      <div className={s['leave-item-info']}>
                        <div className={s['leave-item-type']}>{type.label}</div>
                        <div className={s['leave-item-date']}>
                          {new Date(leave.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </div>
                        {leave.reason && <div className={s['leave-item-reason']}>{leave.reason}</div>}
                      </div>
                      <button className="btn-remove-break" onClick={() => handleDelete(leave.id)} title="Delete">
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
