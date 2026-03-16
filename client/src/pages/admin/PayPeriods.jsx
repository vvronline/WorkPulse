import { useState, useEffect, useCallback } from 'react';
import {
    getPayPeriods, createPayPeriod, deletePayPeriod,
    exportPayrollHours,
} from '../../api';
import s from './AdminPages.module.css';

const today = new Date().toISOString().slice(0, 10);

function getMonthRange(offset = 0) {
    const d = new Date();
    d.setMonth(d.getMonth() + offset, 1);
    const start = d.toISOString().slice(0, 10);
    d.setMonth(d.getMonth() + 1, 0);
    const end = d.toISOString().slice(0, 10);
    return { start, end };
}

export default function PayPeriods() {
    const [periods, setPeriods] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // New period form
    const [form, setForm] = useState({
        label: '',
        start_date: getMonthRange().start,
        end_date: getMonthRange().end,
    });
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState('');

    // Payroll export state
    const [exportFrom, setExportFrom] = useState(getMonthRange().start);
    const [exportTo, setExportTo] = useState(today);
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState('');

    const loadPeriods = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await getPayPeriods();
            setPeriods(res.data);
        } catch {
            setError('Failed to load pay periods.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadPeriods(); }, [loadPeriods]);

    const handleCreate = async (e) => {
        e.preventDefault();
        setFormError('');
        if (!form.label.trim()) { setFormError('Label is required'); return; }
        if (!form.start_date || !form.end_date) { setFormError('Start and end dates are required'); return; }
        if (form.end_date < form.start_date) { setFormError('End date must be on or after start date'); return; }
        setSubmitting(true);
        try {
            await createPayPeriod(form);
            setForm({ label: '', start_date: getMonthRange(-1).start, end_date: getMonthRange(-1).end });
            loadPeriods();
        } catch (err) {
            setFormError(err.response?.data?.error || 'Failed to create pay period');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id, label) => {
        if (!window.confirm(`Delete pay period "${label}"? This will unlock time entries in that range.`)) return;
        try {
            await deletePayPeriod(id);
            setPeriods(ps => ps.filter(p => p.id !== id));
        } catch (err) {
            alert(err.response?.data?.error || 'Failed to delete pay period');
        }
    };

    const handleExport = async (format) => {
        if (!exportFrom || !exportTo) { setExportError('Please set a date range'); return; }
        setExportError('');
        setExporting(true);
        try {
            const res = await exportPayrollHours(exportFrom, exportTo, format);
            const mime = format === 'pdf' ? 'application/pdf' : 'text/csv';
            const ext = format === 'pdf' ? 'pdf' : 'csv';
            const blob = new Blob([res.data], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `payroll_${exportFrom}_${exportTo}.${ext}`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            setExportError(err.response?.data?.error || 'Export failed');
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className={s.section}>
            <h3 className={s.sectionTitle}>Pay Periods &amp; Payroll Export</h3>
            <p className={s.sectionDesc}>
                Lock a date range to prevent employees from modifying manual time entries.
                Export payroll-ready CSVs for accountants or QuickBooks imports.
            </p>

            {/* ── Payroll Export ── */}
            <div className={s.card}>
                <h4 className={s.cardTitle}>Export Payroll Hours</h4>
                <div className={s.row}>
                    <div className={s.formGroup}>
                        <label className={s.label}>From</label>
                        <input type="date" value={exportFrom} max={today}
                            onChange={e => setExportFrom(e.target.value)} className={s.input} />
                    </div>
                    <div className={s.formGroup}>
                        <label className={s.label}>To</label>
                        <input type="date" value={exportTo} max={today}
                            onChange={e => setExportTo(e.target.value)} className={s.input} />
                    </div>
                    <div className={s.formGroup} style={{ justifyContent: 'flex-end' }}>
                        <label className={s.label}>&nbsp;</label>
                        <div className={s.btnRow}>
                            <button className={s.secondaryBtn} onClick={() => handleExport('csv')} disabled={exporting}>
                                {exporting ? 'Exporting…' : '⬇ CSV'}
                            </button>
                            <button className={s.secondaryBtn} onClick={() => handleExport('pdf')} disabled={exporting}>
                                {exporting ? '…' : '⬇ PDF'}
                            </button>
                        </div>
                    </div>
                </div>
                {exportError && <p className={s.errorMsg}>{exportError}</p>}
                <p className={s.hint}>
                    Exports per-employee daily hours (regular + overtime + break) for all team members visible to you.
                    Compatible with most payroll/accounting systems.
                </p>
            </div>

            {/* ── Create Pay Period ── */}
            <div className={s.card}>
                <h4 className={s.cardTitle}>Lock Pay Period</h4>
                <form onSubmit={handleCreate}>
                    <div className={s.row}>
                        <div className={s.formGroup} style={{ flex: 2 }}>
                            <label className={s.label}>Label</label>
                            <input
                                type="text"
                                value={form.label}
                                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                                placeholder="e.g. June 2025"
                                className={s.input}
                                maxLength={100}
                            />
                        </div>
                        <div className={s.formGroup}>
                            <label className={s.label}>Start</label>
                            <input type="date" value={form.start_date}
                                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                                className={s.input} />
                        </div>
                        <div className={s.formGroup}>
                            <label className={s.label}>End</label>
                            <input type="date" value={form.end_date}
                                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                                className={s.input} />
                        </div>
                    </div>
                    {formError && <p className={s.errorMsg}>{formError}</p>}
                    <button type="submit" className={s.primaryBtn} disabled={submitting}>
                        {submitting ? 'Locking…' : '🔒 Lock Period'}
                    </button>
                </form>
                <p className={s.hint}>
                    Once locked, employees cannot add or edit manual time entries in this date range.
                    Managers can still approve or reject existing pending entries.
                </p>
            </div>

            {/* ── Locked Periods List ── */}
            <div className={s.card}>
                <h4 className={s.cardTitle}>Locked Periods</h4>
                {error && <p className={s.errorMsg}>{error}</p>}
                {loading ? (
                    <p className={s.hint}>Loading…</p>
                ) : periods.length === 0 ? (
                    <p className={s.hint}>No pay periods locked yet.</p>
                ) : (
                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th>Label</th>
                                <th>Start</th>
                                <th>End</th>
                                <th>Locked By</th>
                                <th>Locked At</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {periods.map(p => (
                                <tr key={p.id}>
                                    <td>{p.label}</td>
                                    <td>{p.start_date}</td>
                                    <td>{p.end_date}</td>
                                    <td>{p.locked_by_name || '—'}</td>
                                    <td>{new Date(p.locked_at).toLocaleDateString()}</td>
                                    <td>
                                        <button
                                            className={s.dangerBtn}
                                            onClick={() => handleDelete(p.id, p.label)}
                                            title="Unlock this period"
                                        >
                                            🔓 Unlock
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
