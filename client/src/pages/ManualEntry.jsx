import React, { useState, useRef, useEffect } from 'react';
import { addManualEntry, updateManualEntry, deleteEntries, getEntries, getLeaves, getStatus, getLocalToday, getManualEntryRequests, submitOvertimeRequest, getOvertimeRequests } from '../api';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './ManualEntry.module.css';

// Convert a UTC timestamps string (SQLite format) to local HH:MM
function tsToLocalTime(ts) {
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Parse raw time_entries into form fields: clockIn, clockOut, breaks, workMode
function parseEntries(entries) {
  const clockInEntry = entries.find(e => e.entry_type === 'clock_in');
  const clockOutEntry = entries.find(e => e.entry_type === 'clock_out');
  const breakStarts = entries.filter(e => e.entry_type === 'break_start');
  const breakEnds = entries.filter(e => e.entry_type === 'break_end');

  // Pair breaks by index
  const parsedBreaks = breakStarts.map((bs, i) => ({
    start: tsToLocalTime(bs.timestamp),
    end: breakEnds[i] ? tsToLocalTime(breakEnds[i].timestamp) : '',
  }));

  return {
    clockIn: clockInEntry ? tsToLocalTime(clockInEntry.timestamp) : '09:00',
    clockOut: clockOutEntry ? tsToLocalTime(clockOutEntry.timestamp) : '',
    skipClockOut: !clockOutEntry,
    breaks: parsedBreaks.length > 0 ? parsedBreaks : [{ start: '', end: '' }],
    workMode: clockInEntry?.work_mode || 'office',
  };
}

export default function ManualEntry() {
  const [date, setDate] = useState('');
  const [clockIn, setClockIn] = useState('09:00');
  const [clockOut, setClockOut] = useState('');
  const [skipClockOut, setSkipClockOut] = useState(false);
  const [breaks, setBreaks] = useState([{ start: '', end: '' }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useAutoDismiss('');
  const [success, setSuccess] = useAutoDismiss('');
  const [existingEntries, setExistingEntries] = useState(null);
  const [leaveOnDate, setLeaveOnDate] = useState(null);
  const [checkingDate, setCheckingDate] = useState(false);
  const [workMode, setWorkMode] = useState('office');
  const [isEditMode, setIsEditMode] = useState(false);   // true when editing existing entries
  const [currentlyClocked, setCurrentlyClocked] = useState(false); // true if clocked in right now
  const [pendingRequests, setPendingRequests] = useState([]);
  const [overtimeRequests, setOvertimeRequests] = useState([]);
  const [otDate, setOtDate] = useState('');
  const [otHours, setOtHours] = useState('');
  const [otReason, setOtReason] = useState('');
  const [otLoading, setOtLoading] = useState(false);
  const [otError, setOtError] = useAutoDismiss('');
  const [otSuccess, setOtSuccess] = useAutoDismiss('');
  const checkDateReqId = useRef(0); // guard against race conditions

  // Fetch pending manual entry requests + overtime requests
  useEffect(() => {
    getManualEntryRequests()
      .then(r => setPendingRequests(Array.isArray(r.data) ? r.data : []))
      .catch(e => console.error(e));
    getOvertimeRequests()
      .then(r => setOvertimeRequests(Array.isArray(r.data) ? r.data : []))
      .catch(e => console.error(e));
  }, []);

  const addBreak = () => setBreaks([...breaks, { start: '', end: '' }]);
  const removeBreak = (index) => setBreaks(breaks.filter((_, i) => i !== index));
  const updateBreak = (index, field, value) => {
    const updated = [...breaks];
    updated[index] = { ...updated[index], [field]: value };
    setBreaks(updated);
  };

  const resetForm = () => {
    setClockIn('09:00');
    setClockOut('');
    setSkipClockOut(false);
    setBreaks([{ start: '', end: '' }]);
    setWorkMode('office');
    setIsEditMode(false);
    setExistingEntries(null);
  };

  const checkDate = async (dateVal) => {
    setDate(dateVal);
    setExistingEntries(null);
    setLeaveOnDate(null);
    setCurrentlyClocked(false);
    setIsEditMode(false);
    setError('');
    setSuccess('');
    if (!dateVal) return;

    const reqId = ++checkDateReqId.current;
    setCheckingDate(true);
    try {
      const today = getLocalToday();
      const [entriesRes, leavesRes] = await Promise.all([
        getEntries(dateVal),
        getLeaves(dateVal, dateVal),
      ]);

      // Discard stale responses if user changed the date in the meantime
      if (reqId !== checkDateReqId.current) return;

      if (entriesRes.data.length > 0) {
        setExistingEntries(entriesRes.data);
      }
      if (leavesRes.data.length > 0) {
        setLeaveOnDate(leavesRes.data[0]);
      }

      // If today is selected, check if currently clocked in
      if (dateVal === today) {
        const statusRes = await getStatus();
        if (reqId !== checkDateReqId.current) return;
        if (statusRes.data.state !== 'logged_out') {
          setCurrentlyClocked(true);
        }
      }
    } catch {
      // ignore
    } finally {
      if (reqId === checkDateReqId.current) {
        setCheckingDate(false);
      }
    }
  };

  // Enter edit mode: pre-fill form from existing entries
  const handleEditExisting = () => {
    if (!existingEntries) return;
    const parsed = parseEntries(existingEntries);
    setClockIn(parsed.clockIn);
    setClockOut(parsed.clockOut);
    setSkipClockOut(parsed.skipClockOut);
    setBreaks(parsed.breaks);
    setWorkMode(parsed.workMode);
    setIsEditMode(true);
    setError('');
    setSuccess('');
  };

  const handleCancelEdit = () => {
    resetForm();
    setDate('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!date || !clockIn) {
      setError('Please fill in date and clock-in time');
      return;
    }
    if (!skipClockOut && !clockOut) {
      setError('Please fill in clock-out time, or check "Still working" to skip it');
      return;
    }

    const validBreaks = breaks.filter(b => b.start && b.end);
    setLoading(true);

    try {
      const entryData = {
        clock_in: clockIn,
        clock_out: skipClockOut ? undefined : clockOut,
        breaks: validBreaks.length > 0 ? validBreaks : undefined,
        work_mode: workMode,
        timezoneOffset: new Date().getTimezoneOffset(),
      };

      // If editing, use atomic PUT to delete and re-insert in one transaction
      if (isEditMode) {
        await updateManualEntry(date, entryData);
      } else {
        await addManualEntry({ date, ...entryData });
      }

      setSuccess(`${isEditMode ? 'Entry updated' : 'Manual entry submitted'} for ${date}!`);
      resetForm();
      setDate('');
      // Re-fetch pending requests
      getManualEntryRequests().then(r => setPendingRequests(r.data)).catch(e => console.error(e));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save entry');
    } finally {
      setLoading(false);
    }
  };

  const entryTypeLabels = {
    clock_in: 'Logged In',
    break_start: 'Break Started',
    break_end: 'Break Ended',
    clock_out: 'Logged Out',
  };

  const entryTypeIcons = {
    clock_in: '🟢',
    break_start: '🟡',
    break_end: '🔵',
    clock_out: '🔴',
  };

  // The form should be hidden when:
  // - There are existing entries and we're NOT in edit mode
  // - There's a leave on the date
  // - Currently clocked in today
  const showForm = !leaveOnDate && !currentlyClocked && (!existingEntries || isEditMode);
  const formDisabled = loading;

  const handleOvertimeSubmit = async (e) => {
    e.preventDefault();
    setOtError('');
    setOtSuccess('');
    if (!otDate || !otHours || !otReason.trim()) {
      setOtError('Please fill in all fields');
      return;
    }
    setOtLoading(true);
    try {
      const res = await submitOvertimeRequest({ date: otDate, hours: parseFloat(otHours), reason: otReason.trim() });
      setOtSuccess(res.data.message || 'Overtime request submitted');
      setOtDate('');
      setOtHours('');
      setOtReason('');
      const updated = await getOvertimeRequests();
      setOvertimeRequests(Array.isArray(updated.data) ? updated.data : []);
    } catch (err) {
      setOtError(err.response?.data?.error || 'Failed to submit overtime request');
    } finally {
      setOtLoading(false);
    }
  };

  return (
    <div className={s['manual-entry-page']}>
      <div className={s['manual-entry-header']}>
        <h2><span className="page-icon">📝</span> Manual Time Entry</h2>
        <p>Add or edit time entries for days when you forgot to use the tracker</p>
      </div>

      <div className={s['manual-entry-grid']}>
        {/* Form Card */}
        <div className={s['manual-entry-card']}>
          <h3>{isEditMode ? '✏️ Edit Entry' : '➕ Add Entry'}</h3>

          {error && <div className="error-msg">{error}</div>}
          {success && <div className="success-msg">{success}</div>}

          <form onSubmit={handleSubmit}>
            {/* Date */}
            {!isEditMode && (
              <div className="form-group">
                <label>Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => checkDate(e.target.value)}
                  max={getLocalToday()}
                  required
                />
              </div>
            )}

            {isEditMode && (
              <div className={s['edit-mode-banner']}>
                <span>✏️ Editing entry for <strong>{date}</strong></span>
                <button type="button" className={s['cancel-edit-btn']} onClick={handleCancelEdit}>
                  ✕ Cancel
                </button>
              </div>
            )}

            {/* Date check indicator */}
            {checkingDate && (
              <div className="info-msg">Checking for existing entries...</div>
            )}

            {/* Leave warning */}
            {leaveOnDate && (
              <div className={`${s['existing-entries-warning']} ${s['leave-warning']}`}>
                <div className={s['warning-header']}>🚫 Leave recorded on this date</div>
                <p className={s['warning-helper-text']}>
                  You have a <strong>{leaveOnDate.leave_type}</strong> leave on {date}.
                  Remove the leave from the Leaves page first to add a manual entry.
                </p>
              </div>
            )}

            {/* Clocked-in-today warning */}
            {currentlyClocked && (
              <div className={`${s['existing-entries-warning']} ${s['clocked-in-warning']}`}>
                <div className={s['warning-header']}>🔴 You're currently clocked in</div>
                <p className={s['warning-helper-text']}>
                  Manual entry for today is only allowed after you've clocked out.
                  Please clock out from the Dashboard first.
                </p>
              </div>
            )}

            {/* Existing entries panel (only shown when NOT in edit mode) */}
            {existingEntries && existingEntries.length > 0 && !isEditMode && !currentlyClocked && (
              <div className={s['existing-entries-warning']}>
                <div className={s['warning-header']}>⚠️ Entries already exist for this date</div>
                <div className={s['existing-list']}>
                  {existingEntries.map((entry, i) => (
                    <div key={i} className={s['existing-item']}>
                      <span>{entryTypeIcons[entry.entry_type]}</span>
                      <span>{entryTypeLabels[entry.entry_type]}</span>
                      <span className={s['existing-time']}>
                        {new Date(entry.timestamp.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className={s['edit-existing-btn']}
                  onClick={handleEditExisting}
                  disabled={loading}
                >
                  ✏️ Edit These Entries
                </button>
              </div>
            )}

            {/* Main form fields — only shown when allowed */}
            {showForm && (
              <>
                {/* Work Mode */}
                <div className={s['work-mode-section']}>
                  <label>Work Mode</label>
                  <div className={s['work-mode-toggle']}>
                    <button
                      type="button"
                      className={`${s['mode-btn']} ${workMode === 'office' ? s.active : ''}`}
                      onClick={() => setWorkMode('office')}
                    >
                      🏢 Office
                    </button>
                    <button
                      type="button"
                      className={`${s['mode-btn']} ${workMode === 'remote' ? s.active : ''}`}
                      onClick={() => setWorkMode('remote')}
                    >
                      🏠 Remote
                    </button>
                  </div>
                </div>

                {/* Login / Logout Row */}
                <div className={s['time-row']}>
                  <div className="form-group">
                    <label>Login Time</label>
                    <input
                      type="time"
                      value={clockIn}
                      onChange={(e) => setClockIn(e.target.value)}
                      required
                    />
                  </div>
                  <div className={s['time-arrow']}>→</div>
                  <div className="form-group">
                    <label>Logout Time</label>
                    <input
                      type="time"
                      value={clockOut}
                      onChange={(e) => setClockOut(e.target.value)}
                      disabled={skipClockOut}
                      required={!skipClockOut}
                    />
                  </div>
                  <label className={`checkbox-label ${s['still-working-check']}`}>
                    <input
                      type="checkbox"
                      checked={skipClockOut}
                      onChange={(e) => {
                        setSkipClockOut(e.target.checked);
                        if (e.target.checked) setClockOut('');
                      }}
                    />
                    Still working
                  </label>
                </div>

                {/* Breaks */}
                <div className={s['breaks-section']}>
                  <div className={s['breaks-header']}>
                    <label>Breaks</label>
                    <button type="button" className={s['btn-add-break']} onClick={addBreak}>
                      + Add Break
                    </button>
                  </div>
                  {breaks.map((brk, i) => (
                    <div key={i} className={s['break-row']}>
                      <div className={s['break-inputs']}>
                        <input
                          type="time"
                          value={brk.start}
                          onChange={(e) => updateBreak(i, 'start', e.target.value)}
                          placeholder="Start"
                        />
                        <span className={s['break-dash']}>→</span>
                        <input
                          type="time"
                          value={brk.end}
                          onChange={(e) => updateBreak(i, 'end', e.target.value)}
                          placeholder="End"
                        />
                      </div>
                      <button
                        type="button"
                        className="btn-remove-break"
                        onClick={() => removeBreak(i)}
                        title="Remove break"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={formDisabled}
                >
                  {loading
                    ? (isEditMode ? 'Updating...' : 'Saving...')
                    : (isEditMode ? '✓ Update Entry' : '✓ Save Manual Entry')}
                </button>
              </>
            )}
          </form>
        </div>

        {/* Requests Card */}
        <div className={`${s['manual-entry-card']} ${s['info-card']}`}>
          <h3>📋 Your Requests</h3>

          {/* Pending Requests */}
          {pendingRequests.length > 0 ? (
            <div className={s['pending-requests']}>
              {pendingRequests.map(r => {
                const meta = r.metadata || {};
                const statusColors = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)' };
                return (
                  <div key={r.request_id} className={s['pending-item']}>
                    <div className={s['pending-item-date']}>
                      {meta.date ? new Date(meta.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'}
                    </div>
                    <div className={s['pending-item-time']}>
                      {meta.clock_in || ''}{meta.clock_out ? ` → ${meta.clock_out}` : ''}
                    </div>
                    <span
                      className={s['pending-item-status']}
                      style={{
                        background: `${statusColors[r.approval_status] || 'var(--text-muted)'}22`,
                        color: statusColors[r.approval_status] || 'var(--text-muted)'
                      }}
                    >
                      {r.approval_status}
                    </span>
                    {r.reject_reason && (
                      <div className={s['pending-item-reason']}>Reason: {r.reject_reason}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={s['empty-state']}>No requests yet.</p>
          )}
        </div>
      </div>

      {/* Overtime Request Section */}
      <div className={s['overtime-section']}>
        <h2><span className="page-icon">⏱️</span> Overtime Request</h2>
        <div className={s['manual-entry-grid']}>
          <div className={s['manual-entry-card']}>
            <h3>➕ Request Overtime</h3>
            {otError && <div className="error-msg">{otError}</div>}
            {otSuccess && <div className="success-msg">{otSuccess}</div>}
            <form onSubmit={handleOvertimeSubmit}>
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={otDate} onChange={e => setOtDate(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Extra Hours</label>
                <input type="number" step="0.5" min="0.5" max="24" value={otHours} onChange={e => setOtHours(e.target.value)} placeholder="e.g. 2" required />
              </div>
              <div className="form-group">
                <label>Reason</label>
                <textarea value={otReason} onChange={e => setOtReason(e.target.value)} placeholder="Why do you need overtime?" rows={3} required className={s['textarea-resize']} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={otLoading}>
                {otLoading ? 'Submitting...' : '✓ Submit Overtime Request'}
              </button>
            </form>
          </div>

          <div className={`${s['manual-entry-card']} ${s['info-card']}`}>
            <h3>📋 Overtime Requests</h3>
            {overtimeRequests.length > 0 ? (
              <div className={s['pending-requests']}>
                {overtimeRequests.map(r => {
                  const meta = r.metadata || {};
                  const statusColors = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)' };
                  return (
                    <div key={r.id} className={s['pending-item']}>
                      <div className={s['pending-item-date']}>
                        {meta.date ? new Date(meta.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'}
                      </div>
                      <div className={s['pending-item-time']}>
                        {meta.hours ? `${meta.hours}h overtime` : ''}
                      </div>
                      <span
                        className={s['pending-item-status']}
                        style={{
                          background: `${statusColors[r.status] || 'var(--text-muted)'}22`,
                          color: statusColors[r.status] || 'var(--text-muted)'
                        }}
                      >
                        {r.status}
                      </span>
                      {r.reason && <div className={s['pending-item-reason']}>{r.reason}</div>}
                      {r.reject_reason && <div className={`${s['pending-item-reason']} ${s['text-danger']}`}>Rejected: {r.reject_reason}</div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={s['empty-state']}>No overtime requests yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
