import React, { useState } from "react";
import { useAutoDismiss } from "../../hooks/useAutoDismiss";
import TIMEZONES from "../../constants/timezones";
import s from "../Admin.module.css";
import sf from "./AdminForms.module.css";

interface OrgModalProps {
    org?: any;
    onClose: () => void;
    onSave: (data: any) => void | Promise<void>;
}

export default function OrgModal({ org, onClose, onSave }: OrgModalProps) {
    const [form, setForm] = useState<any>({
        name: org?.name || "",
        work_hours_per_day: org?.work_hours_per_day ?? 8,
        work_days: org?.work_days || "1,2,3,4,5",
        timezone: org?.timezone || "UTC",
        fiscal_year_start: org?.fiscal_year_start ?? 1
    });
    const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        try {
            await onSave(form);
        } catch (e: any) { setError(e.response?.data?.error || "Failed"); }
    };

    return (
        <div className={sf.modalOverlay} onClick={onClose}>
            <div className={sf.modal} onClick={e => e.stopPropagation()}>
                <h2>{org ? "Edit Organization" : "Create Organization"}</h2>
                {error && <div className={s.error}>{error}</div>}
                <form onSubmit={handleSubmit}>
                    <div className={sf.formGroup}>
                        <label>Organization Name</label>
                        <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Acme Corp" />
                    </div>
                    <div className={sf.formGroup}>
                        <label>Work Hours Per Day</label>
                        <input type="number" min="1" max="24" step="0.5" value={form.work_hours_per_day} onChange={e => setForm({ ...form, work_hours_per_day: e.target.value })} />
                    </div>
                    <div className={sf.formGroup}>
                        <label>Work Days (comma-separated, 0=Sun, 6=Sat)</label>
                        <input value={form.work_days} onChange={e => setForm({ ...form, work_days: e.target.value })} placeholder="1,2,3,4,5" />
                        <small className={sf.hint}>Example: 1,2,3,4,5 for Mon-Fri</small>
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
                    <div className={sf.formActions}>
                        <button type="button" className={sf.btnCancel} onClick={onClose}>Cancel</button>
                        <button type="submit" className={s.btnPrimary}>{org ? "Update" : "Create"}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}