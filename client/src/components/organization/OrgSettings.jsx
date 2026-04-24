import React, { useState } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { updateOrgSettings } from '../../api';
import TIMEZONES from '../../constants/timezones';
import s from '../../pages/Admin.module.css';
import sf from '../../pages/admin/AdminForms.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

export default function OrgSettings({ org, onUpdate, userRole }) {
    const [form, setForm] = useState({
        name: org.name,
        work_hours_per_day: org.work_hours_per_day,
        work_days: org.work_days,
        timezone: org.timezone,
        fiscal_year_start: org.fiscal_year_start,
        // Minimum hours an employee must log on a working day to be marked Present.
        // Empty string = "use default" (server falls back to work_hours_per_day / 2).
        min_hours_present: org.min_hours_present ?? '',
    });
    const [msg, setMsg] = useAutoDismiss('');
    const canEdit = ['hr_admin', 'super_admin', 'platform_admin'].includes(userRole);

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            // Send min_hours_present as null when blank so the server clears the override
            const payload = {
                ...form,
                min_hours_present: form.min_hours_present === '' ? null : Number(form.min_hours_present),
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
                <div className={sf.formGroup}>
                    <label>Work Days (comma-separated: 1=Mon, 7=Sun)</label>
                    <input value={form.work_days} onChange={e => setForm({ ...form, work_days: e.target.value })} placeholder="1,2,3,4,5" />
                </div>
            </>}
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
            <button type="submit" className={s.btnPrimary}>Save Settings</button>
        </form>
    );
}
