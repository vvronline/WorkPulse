import React, { useState, useEffect, useCallback } from "react";
import { getHolidays, addHoliday, deleteHoliday } from "../../api";
import HolidayCard from "./HolidayCard";
import s from "../LeavePolicy.module.css";

interface Holiday {
    id: number | string;
    name: string;
    date: string;
    is_optional?: number | boolean;
    [key: string]: any;
}

interface HolidaysTabProps {
    isHR?: boolean;
}

export default function HolidaysTab({ isHR }: HolidaysTabProps) {
    const [holidays, setHolidays] = useState<Holiday[]>([]);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState<{ name: string; date: string; is_optional: number }>({
        name: "",
        date: "",
        is_optional: 0,
    });
    const [year, setYear] = useState(new Date().getFullYear());
    const [saving, setSaving] = useState(false);

    const load = useCallback(() => {
        getHolidays(year)
            .then((r) => setHolidays(r.data as Holiday[]))
            .catch(console.error);
    }, [year]);

    useEffect(() => {
        load();
    }, [load]);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            await addHoliday(form);
            setForm({ name: "", date: "", is_optional: 0 });
            setShowForm(false);
            load();
        } catch {
            /* ignore */
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: number | string) => {
        if (!confirm("Delete this holiday?")) return;
        try {
            await deleteHoliday(id as any);
            load();
        } catch {
            /* ignore */
        }
    };

    const now = new Date();
    const upcoming = holidays
        .filter((h) => new Date(h.date + "T00:00:00") >= now)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const past = holidays
        .filter((h) => new Date(h.date + "T00:00:00") < now)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const years = [year - 1, year, year + 1];

    return (
        <div className={s.tabPanel}>
            <div className={s.panelHeader}>
                <div>
                    <h2 className={s.panelTitle}>Public Holidays</h2>
                    <p className={s.panelSubtitle}>
                        Organisation-wide holidays and optional observances
                    </p>
                </div>
                <div className={s.panelHeaderRight}>
                    <select
                        className={s.yearSelect}
                        value={year}
                        onChange={(e) => setYear(+e.target.value)}
                    >
                        {years.map((y) => (
                            <option key={y} value={y}>
                                {y}
                            </option>
                        ))}
                    </select>
                    {isHR && (
                        <button className={s.primaryBtn} onClick={() => setShowForm(true)}>
                            + Add Holiday
                        </button>
                    )}
                </div>
            </div>

            {holidays.length === 0 ? (
                <div className={s.emptyState}>
                    <div className={s.emptyIcon}>🗓️</div>
                    <p className={s.emptyTitle}>No holidays defined for {year}</p>
                    {isHR && (
                        <button className={s.primaryBtn} onClick={() => setShowForm(true)}>
                            Add First Holiday
                        </button>
                    )}
                </div>
            ) : (
                <>
                    {upcoming.length > 0 && (
                        <section className={s.holidaySection}>
                            <h3 className={s.holidaySectionTitle}>Upcoming</h3>
                            <div className={s.holidayGrid}>
                                {upcoming.map((h) => (
                                    <HolidayCard
                                        key={h.id}
                                        holiday={h}
                                        isHR={isHR}
                                        onDelete={handleDelete}
                                    />
                                ))}
                            </div>
                        </section>
                    )}
                    {past.length > 0 && (
                        <section className={s.holidaySection}>
                            <h3 className={`${s.holidaySectionTitle} ${s.holidaySectionMuted}`}>
                                Past
                            </h3>
                            <div className={`${s.holidayGrid} ${s.holidayGridPast}`}>
                                {past.map((h) => (
                                    <HolidayCard
                                        key={h.id}
                                        holiday={h}
                                        isHR={isHR}
                                        onDelete={handleDelete}
                                    />
                                ))}
                            </div>
                        </section>
                    )}
                </>
            )}

            {showForm && (
                <div className={s.modalBackdrop} onClick={() => setShowForm(false)}>
                    <div className={s.modalBox} onClick={(e) => e.stopPropagation()}>
                        <div className={s.modalHeader}>
                            <h3 className={s.modalTitle}>Add Holiday</h3>
                            <button className={s.modalClose} onClick={() => setShowForm(false)}>
                                ×
                            </button>
                        </div>
                        <form onSubmit={handleAdd} className={s.modalForm}>
                            <div className={s.formField}>
                                <label className={s.formLabel}>Holiday Name</label>
                                <input
                                    className={s.formInput}
                                    value={form.name}
                                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                                    required
                                    placeholder="e.g. Christmas Day"
                                />
                            </div>
                            <div className={s.formField}>
                                <label className={s.formLabel}>Date</label>
                                <input
                                    className={s.formInput}
                                    type="date"
                                    value={form.date}
                                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                                    required
                                />
                            </div>
                            <label className={s.checkItem}>
                                <input
                                    type="checkbox"
                                    checked={!!form.is_optional}
                                    onChange={(e) =>
                                        setForm({ ...form, is_optional: e.target.checked ? 1 : 0 })
                                    }
                                />
                                <span>Optional holiday (employees may choose to work)</span>
                            </label>
                            <div className={s.modalFooter}>
                                <button
                                    type="button"
                                    className={s.cancelBtn}
                                    onClick={() => setShowForm(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className={s.primaryBtn}
                                    disabled={saving}
                                >
                                    {saving ? "Adding…" : "Add Holiday"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}