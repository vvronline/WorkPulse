import React, { useState } from 'react';
import { addManualEntry, deleteEntries, getEntries, getLeaves, getStatus, getLocalToday } from '../api';
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

    setCheckingDate(true);
    try {
      const today = getLocalToday();
      const [entriesRes, leavesRes] = await Promise.all([
        getEntries(dateVal),
        getLeaves(dateVal, dateVal),
      ]);

      if (entriesRes.data.length > 0) {
        setExistingEntries(entriesRes.data);
      }
      if (leavesRes.data.length > 0) {
        setLeaveOnDate(leavesRes.data[0]);
      }

      // If today is selected, check if currently clocked in
      if (dateVal === today) {
        const statusRes = await getStatus();
        if (statusRes.data.state !== 'logged_out') {
          setCurrentlyClocked(true);
        }
      }
    } catch {
      // ignore
    } finally {
      setCheckingDate(false);
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
      // If editing, delete existing entries first then re-insert
      if (isEditMode) {
        await deleteEntries(date);
      }

      await addManualEntry({
        date,
        clock_in: clockIn,
        clock_out: skipClockOut ? undefined : clockOut,
        breaks: validBreaks.length > 0 ? validBreaks : undefined,
        work_mode: workMode,
        timezoneOffset: new Date().getTimezoneOffset(),
      });

      setSuccess(`${isEditMode ? 'Entry updated' : 'Manual entry added'} for ${date}!`);
      resetForm();
      setDate('');
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

        {/* Info Card */}
        <div className={`${s['manual-entry-card']} ${s['info-card']}`}>
          <h3>ℹ️ How It Works</h3>
          <div className={s['info-steps']}>
            <div className={s['info-step']}>
              <div className={s['step-number']}>1</div>
              <div>
                <strong>Select the date</strong>
                <p>Pick the date you forgot to track. Only past dates (or today after clock-out) are allowed.</p>
              </div>
            </div>
            <div className={s['info-step']}>
              <div className={s['step-number']}>2</div>
              <div>
                <strong>Enter login &amp; logout times</strong>
                <p>When did you arrive and leave? Check "Still working" if you haven't left yet.</p>
              </div>
            </div>
            <div className={s['info-step']}>
              <div className={s['step-number']}>3</div>
              <div>
                <strong>Add your breaks</strong>
                <p>Add one or more break periods. Leave empty if no breaks were taken.</p>
              </div>
            </div>
            <div className={s['info-step']}>
              <div className={s['step-number']}>4</div>
              <div>
                <strong>Save the entry</strong>
                <p>Your entry will appear in the dashboard and analytics.</p>
              </div>
            </div>
          </div>

          <div className={s['info-note']}>
            <strong>Tip:</strong> If entries already exist for a date, click <em>"Edit These Entries"</em> to modify them instead of starting from scratch.
          </div>
        </div>
      </div>
    </div>
  );
}
