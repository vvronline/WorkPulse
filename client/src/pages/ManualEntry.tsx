import React, { useState, useRef, useEffect } from "react";
import { FileEdit, Ban, AlertCircle, Building2, House, ArrowRight, ClipboardList, Timer } from "lucide-react";
import { addManualEntry, updateManualEntry, getEntries, getLeaves, getStatus, getLocalToday, getManualEntryRequests, getOvertimeRequests, getCurrentOrg } from "../api";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
// NOTE (status v2): tracker no longer writes status — see useFloatingTimer.js
import { tsToLocalTime, parseEntries, entryTypeLabels, entryTypeIcons } from "./manualEntry/manualEntryUtils";
import PendingRequestsList from "./manualEntry/PendingRequestsList";
import OvertimeRequestForm from "./manualEntry/OvertimeRequestForm";
import s from "./ManualEntry.module.css";

const DEFAULT_OFFICE_START = "09:00";

/** Validate an HH:MM 24-hour time string. */
const isValidHHMM = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Check if the user has a live (non-manual) active session */
const isLiveActiveSession = (statusData: any): boolean => {
  if (!statusData || statusData.state === "logged_out") return false;
  // If the last entry that makes it "active" is a manual entry, it's not a live session
  const entries = statusData.entries || [];
  if (entries.length === 0) return false;
  const last = entries[entries.length - 1];
  return !last.is_manual;
};

interface BreakItem {
  start: string;
  end: string;
}

interface ManualEntryProps {
  isActive?: boolean;
  onEntryChanged?: () => void;
}

export default function ManualEntry({ isActive, onEntryChanged }: ManualEntryProps) {
  const [date, setDate] = useState("");
  // Default clock-in time pulls from the organization's "Regular Office Start Time"
  // (org.office_start_time) so admins can match local working hours instead of
  // a hard-coded 09:00. Falls back to 09:00 when not configured.
  const [officeStart, setOfficeStart] = useState(DEFAULT_OFFICE_START);
  const [clockIn, setClockIn] = useState(DEFAULT_OFFICE_START);
  const [clockOut, setClockOut] = useState("");
  const [skipClockOut, setSkipClockOut] = useState(false);
  const [breaks, setBreaks] = useState<BreakItem[]>([{ start: "", end: "" }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
  const [success, setSuccess] = useAutoDismiss("") as [string, (v: string) => void];
  const [existingEntries, setExistingEntries] = useState<any[] | null>(null);
  const [leaveOnDate, setLeaveOnDate] = useState<any>(null);
  const [checkingDate, setCheckingDate] = useState(false);
  const [workMode, setWorkMode] = useState("office");
  const [isEditMode, setIsEditMode] = useState(false);   // true when editing existing entries
  const [currentlyClocked, setCurrentlyClocked] = useState(false); // true if clocked in right now
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [overtimeRequests, setOvertimeRequests] = useState<any[]>([]);
  const checkDateReqId = useRef(0); // guard against race conditions
  const checkDateAbortRef = useRef<AbortController | null>(null); // AbortController for date-check requests

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (checkDateAbortRef.current) checkDateAbortRef.current.abort();
    };
  }, []);

  // Fetch pending manual entry requests + overtime requests
  useEffect(() => {
    Promise.all([
      getManualEntryRequests().then(r => setPendingRequests(Array.isArray(r.data) ? r.data : [])),
      getOvertimeRequests().then(r => setOvertimeRequests(Array.isArray(r.data) ? r.data : [])),
    ]).catch(() => setError("Failed to load pending requests"));
  }, []);

  // Pull the org's regular office start time once and use it as the default
  // clock-in. We only seed the form value when it's still on the previous
  // default, so we never overwrite a value the user has already typed.
  useEffect(() => {
    let cancelled = false;
    getCurrentOrg()
      .then((res) => {
        if (cancelled) return;
        const t = (res?.data as any)?.office_start_time;
        if (isValidHHMM(t)) {
          setOfficeStart(t);
          setClockIn((prev) => (prev === DEFAULT_OFFICE_START ? t : prev));
        }
      })
      .catch(() => { /* silent — fall back to default */ });
    return () => { cancelled = true; };
  }, []);

  // Re-check the current status when this tab becomes active (handles stale state
  // after the user clocks out on the Dashboard and switches back here)
  useEffect(() => {
    if (!isActive || !date) return;
    const today = getLocalToday();
    if (date !== today) return;
    let cancelled = false;
    getStatus().then((statusRes) => {
      if (cancelled) return;
      setCurrentlyClocked(isLiveActiveSession(statusRes.data));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isActive, date]);

  const addBreak = () => setBreaks([...breaks, { start: "", end: "" }]);
  const removeBreak = (index: number) => setBreaks(breaks.filter((_, i) => i !== index));
  const updateBreak = (index: number, field: keyof BreakItem, value: string) => {
    const updated = [...breaks];
    updated[index] = { ...updated[index], [field]: value };
    setBreaks(updated);
  };

  const resetForm = () => {
    setClockIn(officeStart);
    setClockOut("");
    setSkipClockOut(false);
    setBreaks([{ start: "", end: "" }]);
    setWorkMode("office");
    setIsEditMode(false);
    setExistingEntries(null);
  };

  const checkDate = async (dateVal: string) => {
    setDate(dateVal);
    setExistingEntries(null);
    setLeaveOnDate(null);
    setCurrentlyClocked(false);
    setIsEditMode(false);
    setError("");
    setSuccess("");
    if (!dateVal) return;

    // Cancel any in-flight request for a previous date
    if (checkDateAbortRef.current) checkDateAbortRef.current.abort();
    const controller = new AbortController();
    checkDateAbortRef.current = controller;

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

      // If today is selected, check if currently clocked in (live session only)
      if (dateVal === today) {
        const statusRes = await getStatus();
        if (reqId !== checkDateReqId.current) return;
        if (isLiveActiveSession(statusRes.data)) {
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
    setError("");
    setSuccess("");
  };

  const handleCancelEdit = () => {
    resetForm();
    setDate("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!date || !clockIn) {
      setError("Please fill in date and login time");
      return;
    }
    if (!skipClockOut && !clockOut) {
      setError('Please fill in logout time, or check "Still working" to skip it');
      return;
    }

    const validBreaks = breaks.filter(b => b.start && b.end);
    setLoading(true);

    try {
      const entryData: any = {
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

      setSuccess(`${isEditMode ? "Entry updated" : "Manual entry submitted"} for ${date}!`);

      // If the manual entry is for today and is still open ("Still working" /
      // no clock-out), reflect that in the user's profile status so the
      // navbar/profile dot shows them as working instead of offline. If a
      // clock-out time was provided, mark them as offline since their day
      // is done.
      const today = getLocalToday();

      resetForm();
      setDate("");
      // Re-fetch pending requests
      getManualEntryRequests().then(r => setPendingRequests(r.data as any[])).catch(e => console.error(e));
      // Notify parent (Attendance) to refresh calendar/overview
      if (onEntryChanged) onEntryChanged();
      // Notify other parts of the app (e.g. Dashboard's WorkTimerCard) so they
      // re-fetch /tracker/status immediately instead of waiting for the next poll.
      window.dispatchEvent(new CustomEvent("workpulse:entry-changed", { detail: { date } }));
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to save entry");
    } finally {
      setLoading(false);
    }
  };

  // The form should be hidden when:
  // - There are existing entries and we're NOT in edit mode
  // - There's a leave on the date
  // - Currently clocked in today
  const showForm = !leaveOnDate && !currentlyClocked && (!existingEntries || isEditMode);
  const formDisabled = loading;

  return (
    <div className={s["manual-entry-page"]}>
      <div className={s["manual-entry-header"]}>
        <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><FileEdit size={22} /> Manual Time Entry</h2>
        <p>Add or edit time entries for days when you forgot to use the tracker</p>
      </div>

      <div className={s["manual-entry-grid"]}>
        {/* Form Card */}
        <div className={s["manual-entry-card"]}>
          <h3>{isEditMode ? "✏️ Edit Entry" : "➕ Add Entry"}</h3>

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
              <div className={s["edit-mode-banner"]}>
                <span>✏️ Editing entry for <strong>{date}</strong></span>
                <button type="button" className={s["cancel-edit-btn"]} onClick={handleCancelEdit}>
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
              <div className={`${s["existing-entries-warning"]} ${s["leave-warning"]}`}>
                <div className={s["warning-header"]} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><Ban size={15} /> Leave recorded on this date</div>
                <p className={s["warning-helper-text"]}>
                  You have a <strong>{leaveOnDate.leave_type}</strong> leave on {date}.
                  Remove the leave from the Leaves page first to add a manual entry.
                </p>
              </div>
            )}

            {/* Clocked-in-today warning */}
            {currentlyClocked && (
              <div className={`${s["existing-entries-warning"]} ${s["clocked-in-warning"]}`}>
                <div className={s["warning-header"]} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><AlertCircle size={15} /> You're currently clocked in</div>
                <p className={s["warning-helper-text"]}>
                  Manual entry for today is only allowed after you've clocked out.
                  Please logout from the Dashboard first.
                </p>
              </div>
            )}

            {/* Existing entries panel (only shown when NOT in edit mode) */}
            {existingEntries && existingEntries.length > 0 && !isEditMode && !currentlyClocked && (
              <div className={s["existing-entries-warning"]}>
                <div className={s["warning-header"]}><AlertCircle size={14} style={{ marginRight: 4, verticalAlign: "middle" }} />Entries already exist for this date</div>
                <div className={s["existing-list"]}>
                  {existingEntries.map((entry, i) => (
                    <div key={i} className={s["existing-item"]}>
                      <span>{entryTypeIcons[entry.entry_type]}</span>
                      <span>{entryTypeLabels[entry.entry_type]}</span>
                      <span className={s["existing-time"]}>
                        {tsToLocalTime(entry.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className={s["edit-existing-btn"]}
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
                <div className={s["work-mode-section"]}>
                  <label>Work Mode</label>
                  <div className={s["work-mode-toggle"]}>
                    <button
                      type="button"
                      className={`${s["mode-btn"]} ${workMode === "office" ? s.active : ""}`}
                      onClick={() => setWorkMode("office")}
                    >
                      <Building2 size={14} /> Office
                    </button>
                    <button
                      type="button"
                      className={`${s["mode-btn"]} ${workMode === "remote" ? s.active : ""}`}
                      onClick={() => setWorkMode("remote")}
                    >
                      <House size={14} /> Remote
                    </button>
                  </div>
                </div>

                {/* Login / Logout Row */}
                <div className={s["time-row"]}>
                  <div className="form-group">
                    <label>Login Time</label>
                    <input
                      type="time"
                      value={clockIn}
                      onChange={(e) => setClockIn(e.target.value)}
                      required
                    />
                  </div>
                  <div className={s["time-arrow"]}><ArrowRight size={16} /></div>
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
                  <label className={`checkbox-label ${s["still-working-check"]}`}>
                    <input
                      type="checkbox"
                      checked={skipClockOut}
                      onChange={(e) => {
                        setSkipClockOut(e.target.checked);
                        if (e.target.checked) setClockOut("");
                      }}
                    />
                    Still working
                  </label>
                </div>

                {/* Breaks */}
                <div className={s["breaks-section"]}>
                  <div className={s["breaks-header"]}>
                    <label>Breaks</label>
                    <button type="button" className={s["btn-add-break"]} onClick={addBreak}>
                      + Add Break
                    </button>
                  </div>
                  {breaks.map((brk, i) => (
                    <div key={i} className={s["break-row"]}>
                      <div className={s["break-inputs"]}>
                        <input
                          type="time"
                          value={brk.start}
                          onChange={(e) => updateBreak(i, "start", e.target.value)}
                          placeholder="Start"
                        />
                        <span className={s["break-dash"]}><ArrowRight size={12} /></span>
                        <input
                          type="time"
                          value={brk.end}
                          onChange={(e) => updateBreak(i, "end", e.target.value)}
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
                  className="btn btn-primary btn-fullwidth"
                  disabled={formDisabled}
                >
                  {loading
                    ? (isEditMode ? "Updating..." : "Saving...")
                    : (isEditMode ? "✓ Update Entry" : "✓ Save Manual Entry")}
                </button>
              </>
            )}
          </form>
        </div>

        {/* Requests Card */}
        <div className={`${s["manual-entry-card"]} ${s["info-card"]}`}>
          <h3 style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><ClipboardList size={17} /> Your Requests</h3>
          <PendingRequestsList
            requests={pendingRequests}
            keyField="request_id"
            statusField="approval_status"
            renderTime={(meta: any) => `${meta.clock_in || ""}${meta.clock_out ? ` → ${meta.clock_out}` : ""}`}
            rejectLabel="Reason: "
          />
        </div>
      </div>

      {/* Overtime Request Section */}
      <div className={s["overtime-section"]}>
        <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Timer size={22} /> Overtime Request</h2>
        <div className={s["manual-entry-grid"]}>
          <div className={s["manual-entry-card"]}>
            <h3>➕ Request Overtime</h3>
            <OvertimeRequestForm onSubmitted={setOvertimeRequests} />
          </div>

          <div className={`${s["manual-entry-card"]} ${s["info-card"]}`}>
            <h3 style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><ClipboardList size={17} /> Overtime Requests</h3>
            <PendingRequestsList
              requests={overtimeRequests}
              keyField="id"
              statusField="status"
              renderTime={(meta: any) => meta.hours ? `${meta.hours}h overtime` : ""}
              showReason
              emptyText="No overtime requests yet."
            />
          </div>
        </div>
      </div>
    </div>
  );
}