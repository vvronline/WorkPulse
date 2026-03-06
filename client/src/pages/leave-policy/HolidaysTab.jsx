import React, { useState, useEffect, useCallback } from 'react';
import { getHolidays, addHoliday, deleteHoliday } from '../../api';
import HolidayCard from './HolidayCard';
import s from '../LeavePolicy.module.css';

export default function HolidaysTab({ isHR }) {
    const [holidays, setHolidays] = useState([]);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ name: '', date: '', is_optional: 0 });
    const [year, setYear] = useState(new Date().getFullYear());

    const fetch = useCallback(() => {
        getHolidays(year).then(r => setHolidays(r.data)).catch(e => console.error(e));
    }, [year]);

    useEffect(() => { fetch(); }, [fetch]);

    const handleAdd = async (e) => {
        e.preventDefault();
        try {
            await addHoliday(form);
            setForm({ name: '', date: '', is_optional: 0 });
            setShowForm(false);
            fetch();
        } catch { }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this holiday?')) return;
        try { await deleteHoliday(id); fetch(); } catch { }
    };

    const now = new Date();
    const upcoming = holidays.filter(h => new Date(h.date) >= now).sort((a, b) => new Date(a.date) - new Date(b.date));
    const past = holidays.filter(h => new Date(h.date) < now).sort((a, b) => new Date(b.date) - new Date(a.date));

    return (
        <>
            <div className={s.toolbar}>
                <select value={year} onChange={e => setYear(+e.target.value)} className={s['select-input']}>
                    {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                {isHR && <button className={s.btnPrimary} onClick={() => setShowForm(true)}>+ Add Holiday</button>}
            </div>

            {upcoming.length > 0 && (
                <>
                    <h3 className={s['section-heading']}>📅 Upcoming</h3>
                    <div className={s['grid-holidays']}>
                        {upcoming.map(h => <HolidayCard key={h.id} holiday={h} isHR={isHR} onDelete={handleDelete} />)}
                    </div>
                </>
            )}

            {past.length > 0 && (
                <>
                    <h3 className={s['section-heading-muted']}>Past</h3>
                    <div className={s['grid-holidays-past']}>
                        {past.map(h => <HolidayCard key={h.id} holiday={h} isHR={isHR} onDelete={handleDelete} />)}
                    </div>
                </>
            )}

            {holidays.length === 0 && <div className={s['empty-state']}>No holidays defined for {year}.</div>}

            {showForm && (
                <div className={s.modalOverlay} onClick={() => setShowForm(false)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h3>Add Holiday</h3>
                        <form onSubmit={handleAdd}>
                            <div className={s.formGroup}>
                                <label>Holiday Name</label>
                                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Christmas Day" />
                            </div>
                            <div className={s.formGroup}>
                                <label>Date</label>
                                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required />
                            </div>
                            <label className={s['checkbox-label-block']}>
                                <input type="checkbox" checked={!!form.is_optional} onChange={e => setForm({ ...form, is_optional: e.target.checked ? 1 : 0 })} /> Optional holiday
                            </label>
                            <div className={s.formActions}>
                                <button type="button" className={s.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
                                <button type="submit" className={s.btnPrimary}>Add</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
