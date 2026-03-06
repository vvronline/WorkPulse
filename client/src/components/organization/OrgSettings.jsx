import React, { useState } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { updateOrgSettings } from '../../api';
import s from '../../pages/Admin.module.css';
import sf from '../../pages/admin/AdminForms.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

export default function OrgSettings({ org, onUpdate, userRole }) {
    const [form, setForm] = useState({
        name: org.name,
        work_hours_per_day: org.work_hours_per_day,
        work_days: org.work_days,
        timezone: org.timezone,
        fiscal_year_start: org.fiscal_year_start
    });
    const [msg, setMsg] = useAutoDismiss('');
    const canEdit = ['hr_admin', 'super_admin'].includes(userRole);

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            await updateOrgSettings(form);
            setMsg('Settings saved');
            onUpdate();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    return (
        <form onSubmit={handleSave} className={su['form-container-sm']}>
            {msg && <div className={s.success}>{msg}</div>}
            <div className={sf.formGroup}>
                <label>Organization Name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} disabled={!canEdit} />
            </div>
            <div className={sf.formGroup}>
                <label>Work Hours Per Day</label>
                <input type="number" step="0.5" min="1" max="24" value={form.work_hours_per_day} onChange={e => setForm({ ...form, work_hours_per_day: e.target.value })} disabled={!canEdit} />
            </div>
            <div className={sf.formGroup}>
                <label>Work Days (comma-separated: 1=Mon, 7=Sun)</label>
                <input value={form.work_days} onChange={e => setForm({ ...form, work_days: e.target.value })} placeholder="1,2,3,4,5" disabled={!canEdit} />
            </div>
            <div className={sf.formGroup}>
                <label>Timezone</label>
                <input value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} disabled={!canEdit} />
            </div>
            <div className={sf.formGroup}>
                <label>Fiscal Year Start Month (1-12)</label>
                <input type="number" min="1" max="12" value={form.fiscal_year_start} onChange={e => setForm({ ...form, fiscal_year_start: e.target.value })} disabled={!canEdit} />
            </div>
            {canEdit && <button type="submit" className={s.btnPrimary}>Save Settings</button>}
        </form>
    );
}
