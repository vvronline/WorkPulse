import React, { useState } from 'react';
import { submitOvertimeRequest, getOvertimeRequests } from '../../api';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import s from '../ManualEntry.module.css';

/**
 * Self-contained overtime request form.
 * Calls onSubmitted(updatedList) after a successful submission.
 */
export default function OvertimeRequestForm({ onSubmitted }) {
  const [otDate, setOtDate] = useState('');
  const [otHours, setOtHours] = useState('');
  const [otReason, setOtReason] = useState('');
  const [otLoading, setOtLoading] = useState(false);
  const [otError, setOtError] = useAutoDismiss('');
  const [otSuccess, setOtSuccess] = useAutoDismiss('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setOtError('');
    setOtSuccess('');
    if (!otDate || !otHours || !otReason.trim()) {
      setOtError('Please fill in all fields');
      return;
    }
    setOtLoading(true);
    try {
      const res = await submitOvertimeRequest({
        date: otDate,
        hours: parseFloat(otHours),
        reason: otReason.trim(),
      });
      setOtSuccess(res.data.message || 'Overtime request submitted');
      setOtDate('');
      setOtHours('');
      setOtReason('');
      const updated = await getOvertimeRequests();
      onSubmitted(Array.isArray(updated.data) ? updated.data : []);
    } catch (err) {
      setOtError(err.response?.data?.error || 'Failed to submit overtime request');
    } finally {
      setOtLoading(false);
    }
  };

  return (
    <>
      {otError && <div className="error-msg">{otError}</div>}
      {otSuccess && <div className="success-msg">{otSuccess}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Date</label>
          <input type="date" value={otDate} onChange={e => setOtDate(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>Extra Hours</label>
          <input
            type="number"
            step="0.5"
            min="0.5"
            max="24"
            value={otHours}
            onChange={e => setOtHours(e.target.value)}
            placeholder="e.g. 2"
            required
          />
        </div>
        <div className="form-group">
          <label>Reason</label>
          <textarea
            value={otReason}
            onChange={e => setOtReason(e.target.value)}
            placeholder="Why do you need overtime?"
            rows={3}
            required
            className={s['textarea-resize']}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-fullwidth" disabled={otLoading}>
          {otLoading ? 'Submitting...' : '✓ Submit Overtime Request'}
        </button>
      </form>
    </>
  );
}
