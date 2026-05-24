import React, { useState } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { updateOrgSettings } from '../../api';
import TIMEZONES from '../../constants/timezones';
import s from '../../pages/Admin.module.css';
import sf from '../../pages/admin/AdminForms.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

/* Day-of-week catalog used by the work-days picker.
   `jsDow` matches what JavaScript's `Date#getDay()` / `getUTCDay()` returns
   (0=Sunday … 6=Saturday) — the same convention the server stores in
   `organizations.work_days` and the same one every attendance/tracker
   helper compares against. Ordered Mon-first for readability. */
const WEEK_DAYS = [
    { jsDow: 1, label: 'Monday',    short: 'Mon' },
    { jsDow: 2, label: 'Tuesday',   short: 'Tue' },
    { jsDow: 3, label: 'Wednesday', short: 'Wed' },
    { jsDow: 4, label: 'Thursday',  short: 'Thu' },
    { jsDow: 5, label: 'Friday',    short: 'Fri' },
    { jsDow: 6, label: 'Saturday',  short: 'Sat' },
    { jsDow: 0, label: 'Sunday',    short: 'Sun' },
];

/* Parse a stored "1,2,3,4,5" string into a Set<number> of JS DOW values.
   Falls back to Mon–Fri when the value is missing or malformed so legacy
   tenants get a sane default in the UI. */
function parseWorkDaysToSet(value) {
    const raw = (value && typeof value === 'string') ? value : '1,2,3,4,5';
    const nums = raw.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    return new Set(nums.length > 0 ? nums : [1, 2, 3, 4, 5]);
}

function setToCsv(set) {
    return Array.from(set).sort((a, b) => a - b).join(',');
}

export default function OrgSettings({ org, onUpdate, userRole }) {
    const [form, setForm] = useState({
        name: org.name,
        work_hours_per_day: org.work_hours_per_day,
        work_days: org.work_days || '1,2,3,4,5',
        timezone: org.timezone,
        fiscal_year_start: org.fiscal_year_start,
        // Minimum hours an employee must log on a working day to be marked Present.
        // Empty string = "use default" (server falls back to work_hours_per_day / 2).
        min_hours_present: org.min_hours_present ?? '',
        // Regular office start time (HH:MM, 24h). Empty string = no override
        // (manual-entry forms fall back to '09:00').
        office_start_time: org.office_start_time ?? '',
    });
    const [msg, setMsg] = useAutoDismiss('');
    const canEdit = ['hr_admin', 'super_admin', 'platform_admin'].includes(userRole);

    /* Live Set<number> derived from the comma-separated string in the form so
       the checkbox UI stays in sync with the underlying canonical format. */
    const workDaySet = parseWorkDaysToSet(form.work_days);

    const toggleWorkDay = (jsDow) => {
        const next = new Set(workDaySet);
        if (next.has(jsDow)) next.delete(jsDow);
        else next.add(jsDow);
        // Don't allow zero work days — that would lock everyone out of
        // clock-in forever. Block the toggle and surface a hint.
        if (next.size === 0) {
            setMsg('Pick at least one working day');
            return;
        }
        setForm({ ...form, work_days: setToCsv(next) });
    };

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            // Send min_hours_present and office_start_time as null when blank so
            // the server clears the override.
            const payload = {
                ...form,
                min_hours_present: form.min_hours_present === '' ? null : Number(form.min_hours_present),
                office_start_time: form.office_start_time === '' ? null : form.office_start_time,
            };
            await updateOrgSettings(payload);
            setMsg('Settings saved');
            onUpdate();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    // Default the calendar uses when no override is set (work_hours_per_day / 2)
    const defaultMinHours = (Number(form.work_hours_per_day) || 8) / 2;

    const isSuperAdmin = userRole === 'super_admin' || userRole === 'platform_admin';

    if (!canEdit) return null;

    return (
        <form onSubmit={handleSave} className={su['form-container-sm']}>
            {msg && <div className={s.success}>{msg}</div>}
            {isSuperAdmin && <>
                <div className={sf.formGroup}>
                    <label>Organization Name</label>
                    <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className={sf.formGroup}>
                    <label>Work Hours Per Day</label>
                    <input type="number" step="0.5" min="1" max="24" value={form.work_hours_per_day} onChange={e => setForm({ ...form, work_hours_per_day: e.target.value })} />
                </div>
            </>}
            <div className={sf.formGroup}>
                <label>Working Days</label>
                <div
                    style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginTop: 6,
                    }}
                >
                    {WEEK_DAYS.map(d => {
                        const checked = workDaySet.has(d.jsDow);
                        return (
                            <label
                                key={d.jsDow}
                                title={d.label}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '6px 10px',
                                    borderRadius: 6,
                                    border: '1px solid var(--border, #d0d7de)',
                                    background: checked ? 'var(--primary, #6366f1)' : 'transparent',
                                    color: checked ? '#fff' : 'inherit',
                                    cursor: 'pointer',
                                    userSelect: 'none',
                                    fontSize: 13,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleWorkDay(d.jsDow)}
                                    style={{ margin: 0 }}
                                />
                                {d.short}
                            </label>
                        );
                    })}
                </div>
                <small style={{ color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                    Days not selected here are treated as <strong>weekend holidays</strong>.
                    By default Saturday &amp; Sunday are off — toggle them on (or any other
                    day) to match your organisation's schedule. Affects clock-in, attendance
                    reports, the "Weekend Holiday" badge, and the analytics denominator.
                </small>
            </div>
            <div className={sf.formGroup}>
                <label>Timezone</label>
                <select value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })}>
                    {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
            </div>
            <div className={sf.formGroup}>
                <label>Fiscal Year Start Month (1-12)</label>
                <input type="number" min="1" max="12" value={form.fiscal_year_start} onChange={e => setForm({ ...form, fiscal_year_start: e.target.value })} />
            </div>
            <div className={sf.formGroup}>
                <label>
                    Minimum Hours to be Marked Present
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>(optional)</span>
                </label>
                <input
                    type="number"
                    step="0.25"
                    min="0"
                    max="24"
                    placeholder={`Default: ${defaultMinHours}h`}
                    value={form.min_hours_present}
                    onChange={e => setForm({ ...form, min_hours_present: e.target.value })}
                />
                <small style={{ color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                    Employees logging fewer than this many hours on a working day are considered absent
                    in attendance reports. Leave blank to use half the daily work hours ({defaultMinHours}h).
                </small>
            </div>
            <div className={sf.formGroup}>
                <label>
                    Regular Office Start Time
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>(optional)</span>
                </label>
                <input
                    type="time"
                    value={form.office_start_time}
                    onChange={e => setForm({ ...form, office_start_time: e.target.value })}
                />
                <small style={{ color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                    Used as the default clock-in time when employees add a manual time entry,
                    and as the reference point for attendance/presence checks (instead of midnight).
                    Leave blank to fall back to 09:00.
                </small>
            </div>
            <button type="submit" className={s.btnPrimary}>Save Settings</button>
        </form>
    );
}