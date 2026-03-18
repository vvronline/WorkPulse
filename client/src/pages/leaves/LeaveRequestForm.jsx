import { useState, useMemo } from 'react';
import { addLeave, addLeavesBatch } from '../../api';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { LEAVE_TYPES } from '../../constants/leaves';
import { getDateRange } from '../../utils/date';
import s from '../Leaves.module.css';

/**
 * Self-contained leave request form.
 * Manages its own form state and calls the API directly.
 * Calls onSuccess() after a successful submission so the parent can refetch.
 */
export default function LeaveRequestForm({ onSuccess }) {
    const [isRange, setIsRange] = useState(false);
    const [date, setDate] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [skipWeekends, setSkipWeekends] = useState(true);
    const [leaveType, setLeaveType] = useState('sick');
    const [duration, setDuration] = useState('full');
    const [reason, setReason] = useState('');
    const [error, setError] = useAutoDismiss('');
    const [success, setSuccess] = useAutoDismiss('');
    const [submitting, setSubmitting] = useState(false);

    const rangeDays = useMemo(() => {
        if (!isRange || !dateFrom || !dateTo || dateTo < dateFrom) return [];
        return getDateRange(dateFrom, dateTo, skipWeekends);
    }, [isRange, dateFrom, dateTo, skipWeekends]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        setSubmitting(true);
        try {
            if (isRange) {
                if (!dateFrom || !dateTo) { setError('Both start and end dates are required'); return; }
                if (dateTo < dateFrom) { setError('End date must be after start date'); return; }
                if (rangeDays.length === 0) { setError('No valid days in the selected range'); return; }
                const res = await addLeavesBatch({ dates: rangeDays, leave_type: leaveType, reason: reason.trim() || undefined, duration });
                setSuccess(res.data?.message || `${rangeDays.length} leave(s) submitted`);
                setDateFrom(''); setDateTo(''); setReason(''); setDuration('full');
            } else {
                if (!date) { setError('Date is required'); return; }
                const res = await addLeave({ date, leave_type: leaveType, reason: reason.trim() || undefined, duration });
                setSuccess(res.data?.message || 'Leave request submitted');
                setDate(''); setReason(''); setDuration('full');
            }
            onSuccess();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to submit leave');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className={s.card}>
            <div className={s.cardHeader}>
                <h2 className={s.cardTitle}>New Leave Request</h2>
            </div>

            {error && <div className={s.alertError}>{error}</div>}
            {success && <div className={s.alertSuccess}>{success}</div>}

            <form onSubmit={handleSubmit} className={s.form}>
                {/* Single day / date range toggle */}
                <div className={s.segmented}>
                    <button type="button" className={`${s.segBtn} ${!isRange ? s.segActive : ''}`} onClick={() => setIsRange(false)}>Single Day</button>
                    <button type="button" className={`${s.segBtn} ${isRange ? s.segActive : ''}`} onClick={() => setIsRange(true)}>Date Range</button>
                </div>

                {/* Date picker(s) */}
                {!isRange ? (
                    <div className={s.field}>
                        <label className={s.label}>Date</label>
                        <input type="date" className={s.input} value={date} onChange={e => setDate(e.target.value)} required />
                    </div>
                ) : (
                    <div className={s.dateRangeGroup}>
                        <div className={s.field}>
                            <label className={s.label}>From</label>
                            <input
                                type="date" className={s.input} value={dateFrom}
                                onChange={e => { setDateFrom(e.target.value); if (dateTo && e.target.value > dateTo) setDateTo(e.target.value); }}
                                required
                            />
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

                {/* Leave type chips */}
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
                    {submitting ? 'Submitting…' : isRange
                        ? `Submit ${rangeDays.length || ''} Request${rangeDays.length !== 1 ? 's' : ''}`
                        : 'Submit Request'}
                </button>
            </form>
        </div>
    );
}
