import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from '../../api';
import s from './Calendar.module.css';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6'];

function pad(n) { return String(n).padStart(2, '0'); }
function formatHour(h) { return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`; }
function toLocalISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

function getWeekDays(baseDate) {
    const d = new Date(baseDate);
    const day = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => {
        const dd = new Date(mon); dd.setDate(mon.getDate() + i); return dd;
    });
}

function getMonthDays(baseDate) {
    const y = baseDate.getFullYear(), m = baseDate.getMonth();
    const first = new Date(y, m, 1);
    const startDay = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(1 - startDay);
    const days = [];
    for (let i = 0; i < 42; i++) {
        const dd = new Date(start); dd.setDate(start.getDate() + i); days.push(dd);
    }
    return days;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function Calendar({ tasks = [] }) {
    const [events, setEvents] = useState([]);
    const [view, setView] = useState('week');
    const [baseDate, setBaseDate] = useState(() => new Date());
    const [modal, setModal] = useState(null);
    const [form, setForm] = useState({ title: '', description: '', start_time: '', end_time: '', all_day: false, color: '#6366f1', task_id: '' });
    const gridRef = useRef(null);
    const today = new Date();

    const weekDays = getWeekDays(baseDate);
    const monthDays = getMonthDays(baseDate);
    const rangeStart = view === 'day' ? new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
        : view === 'week' ? weekDays[0] : monthDays[0];
    const rangeEnd = view === 'day' ? new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1)
        : view === 'week' ? new Date(weekDays[6].getTime() + 86400000) : new Date(monthDays[41].getTime() + 86400000);

    const fetchEvents = useCallback(() => {
        getCalendarEvents(rangeStart.toISOString(), rangeEnd.toISOString())
            .then(r => setEvents(r.data || []))
            .catch(() => {});
    }, [rangeStart.toISOString(), rangeEnd.toISOString()]);

    useEffect(() => { fetchEvents(); }, [fetchEvents]);

    useEffect(() => {
        if (gridRef.current && (view === 'week' || view === 'day')) {
            const now = new Date();
            const scrollTo = Math.max(0, (now.getHours() - 1) * 60);
            gridRef.current.scrollTop = scrollTo;
        }
    }, [view, baseDate]);

    const navigate = (dir) => {
        const d = new Date(baseDate);
        if (view === 'week') d.setDate(d.getDate() + dir * 7);
        else if (view === 'day') d.setDate(d.getDate() + dir);
        else d.setMonth(d.getMonth() + dir);
        setBaseDate(d);
    };

    const goToday = () => setBaseDate(new Date());

    const nowMin = toLocalISO(new Date());

    const openCreate = (startDate, hour) => {
        const now = new Date();
        let start = new Date(startDate);
        start.setHours(hour ?? now.getHours(), hour != null ? 0 : now.getMinutes(), 0, 0);
        if (start < now) { start = new Date(now); start.setMinutes(now.getMinutes() + 1, 0, 0); }
        const end = new Date(start); end.setHours(start.getHours() + 1);
        setForm({ title: '', description: '', start_time: toLocalISO(start), end_time: toLocalISO(end), all_day: false, color: '#6366f1', task_id: '' });
        setModal('create');
    };

    const openEdit = (evt) => {
        setForm({
            title: evt.title, description: evt.description || '', color: evt.color || '#6366f1', task_id: evt.task_id || '',
            start_time: toLocalISO(new Date(evt.start_time)), end_time: toLocalISO(new Date(evt.end_time)), all_day: evt.all_day,
        });
        setModal(evt.id);
    };

    const handleStartChange = (val) => {
        const newStart = new Date(val);
        const oldEnd = new Date(form.end_time);
        if (oldEnd <= newStart) {
            const newEnd = new Date(newStart); newEnd.setHours(newStart.getHours() + 1);
            setForm({ ...form, start_time: val, end_time: toLocalISO(newEnd) });
        } else {
            setForm({ ...form, start_time: val });
        }
    };

    const handleSave = async () => {
        if (!form.title.trim() || !form.start_time || !form.end_time) return;
        if (modal === 'create' && new Date(form.start_time) < new Date()) return;
        const payload = { ...form, task_id: form.task_id || null,
            start_time: new Date(form.start_time).toISOString(),
            end_time: new Date(form.end_time).toISOString(),
        };
        try {
            if (modal === 'create') await createCalendarEvent(payload);
            else await updateCalendarEvent(modal, payload);
            setModal(null);
            fetchEvents();
        } catch (e) { console.error(e); }
    };

    const handleDelete = async () => {
        if (modal === 'create') return;
        try {
            await deleteCalendarEvent(modal);
            setModal(null);
            fetchEvents();
        } catch (e) { console.error(e); }
    };

    const getTitle = () => {
        if (view === 'day') return baseDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        if (view === 'month') return `${MONTH_NAMES[baseDate.getMonth()]} ${baseDate.getFullYear()}`;
        const s = weekDays[0], e = weekDays[6];
        if (s.getMonth() === e.getMonth()) return `${MONTH_NAMES[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${s.getFullYear()}`;
        return `${MONTH_NAMES[s.getMonth()]} ${s.getDate()} – ${MONTH_NAMES[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
    };

    const getEventsForDay = (day) => events.filter(ev => {
        const evStart = new Date(ev.start_time), evEnd = new Date(ev.end_time);
        const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
        return evStart <= dayEnd && evEnd >= dayStart;
    });

    const renderTimeGrid = (days) => {
        const isMulti = days.length > 1;
        return (
            <div className={s.timeGrid} ref={gridRef}>
                <div className={s.timeGridInner}>
                    <div className={s.timeGutter}>
                        {HOURS.map(h => (
                            <div key={h} className={s.timeLabel}>{formatHour(h)}</div>
                        ))}
                    </div>
                    {days.map((day, di) => {
                        const dayEvents = getEventsForDay(day).filter(e => !e.all_day);
                        const isToday = isSameDay(day, today);
                        return (
                            <div key={di} className={`${s.dayColumn} ${isToday ? s.todayCol : ''}`}>
                                {HOURS.map(h => (
                                    <div key={h} className={s.hourSlot} onClick={() => openCreate(day, h)} />
                                ))}
                                {dayEvents.map(ev => {
                                    const evStart = new Date(ev.start_time);
                                    const evEnd = new Date(ev.end_time);
                                    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
                                    const startMin = Math.max(0, (evStart - dayStart) / 60000);
                                    const endMin = Math.min(1440, (evEnd - dayStart) / 60000);
                                    const top = startMin;
                                    const height = Math.max(20, endMin - startMin);
                                    return (
                                        <div key={ev.id} className={s.event} style={{ top: `${top}px`, height: `${height}px`, '--ev-color': ev.color || '#6366f1' }}
                                            onClick={(e) => { e.stopPropagation(); openEdit(ev); }}>
                                            <span className={s.eventTitle}>{ev.title}</span>
                                            {height >= 40 && <span className={s.eventTime}>
                                                {pad(evStart.getHours())}:{pad(evStart.getMinutes())} – {pad(evEnd.getHours())}:{pad(evEnd.getMinutes())}
                                            </span>}
                                        </div>
                                    );
                                })}
                                {isToday && (() => {
                                    const now = new Date();
                                    const mins = now.getHours() * 60 + now.getMinutes();
                                    return <div className={s.nowLine} style={{ top: `${mins}px` }} />;
                                })()}
                            </div>
                        );
                    })}
                </div>
                {/* All-day row */}
                {events.some(e => e.all_day) && (
                    <div className={s.allDayRow}>
                        <div className={s.timeGutterLabel}>All day</div>
                        {days.map((day, di) => {
                            const allDayEvts = getEventsForDay(day).filter(e => e.all_day);
                            return (
                                <div key={di} className={s.allDayCell}>
                                    {allDayEvts.map(ev => (
                                        <div key={ev.id} className={s.allDayEvent} style={{ '--ev-color': ev.color || '#6366f1' }}
                                            onClick={() => openEdit(ev)}>
                                            {ev.title}
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    const renderMonthGrid = () => (
        <div className={s.monthGrid}>
            {DAY_NAMES.map(d => <div key={d} className={s.monthHeader}>{d}</div>)}
            {monthDays.map((day, i) => {
                const isCurrentMonth = day.getMonth() === baseDate.getMonth();
                const isToday = isSameDay(day, today);
                const dayEvts = getEventsForDay(day);
                return (
                    <div key={i} className={`${s.monthCell} ${!isCurrentMonth ? s.otherMonth : ''} ${isToday ? s.todayCell : ''}`}
                        onClick={() => { setBaseDate(new Date(day)); setView('day'); }}>
                        <span className={s.monthDate}>{day.getDate()}</span>
                        {dayEvts.slice(0, 3).map(ev => (
                            <div key={ev.id} className={s.monthEvent} style={{ '--ev-color': ev.color || '#6366f1' }}
                                onClick={(e) => { e.stopPropagation(); openEdit(ev); }}>
                                {ev.title}
                            </div>
                        ))}
                        {dayEvts.length > 3 && <span className={s.monthMore}>+{dayEvts.length - 3} more</span>}
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className={s.calendar}>
            <div className={s.toolbar}>
                <div className={s.toolbarLeft}>
                    <button className={s.navBtn} onClick={() => navigate(-1)}>‹</button>
                    <button className={s.todayBtn} onClick={goToday}>Today</button>
                    <button className={s.navBtn} onClick={() => navigate(1)}>›</button>
                    <h2 className={s.title}>{getTitle()}</h2>
                </div>
                <div className={s.toolbarRight}>
                    <button className={s.addBtn} onClick={() => openCreate(baseDate)}>+ Event</button>
                    <div className={s.viewToggle}>
                        {['day', 'week', 'month'].map(v => (
                            <button key={v} className={`${s.viewBtn} ${view === v ? s.activeView : ''}`} onClick={() => setView(v)}>
                                {v.charAt(0).toUpperCase() + v.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {view === 'week' && (
                <div className={s.weekHeader} style={{ '--day-count': 7 }}>
                    <div className={s.weekGutter} />
                    {weekDays.map((d, i) => (
                        <div key={i} className={`${s.weekDay} ${isSameDay(d, today) ? s.weekDayToday : ''}`}
                            onClick={() => { setBaseDate(new Date(d)); setView('day'); }}>
                            <span className={s.weekDayName}>{DAY_NAMES[i]}</span>
                            <span className={s.weekDayNum}>{d.getDate()}</span>
                        </div>
                    ))}
                </div>
            )}
            {view === 'day' && (
                <div className={s.weekHeader} style={{ '--day-count': 1 }}>
                    <div className={s.weekGutter} />
                    <div className={`${s.weekDay} ${s.weekDayToday}`}>
                        <span className={s.weekDayName}>{DAY_NAMES[(baseDate.getDay() + 6) % 7]}</span>
                        <span className={s.weekDayNum}>{baseDate.getDate()}</span>
                    </div>
                </div>
            )}

            {(view === 'week' || view === 'day') && (
                <div style={{ '--day-count': view === 'day' ? 1 : 7, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {renderTimeGrid(view === 'week' ? weekDays : [baseDate])}
                </div>
            )}
            {view === 'month' && renderMonthGrid()}

            {modal !== null && (
                <div className={s.modalOverlay} onClick={() => setModal(null)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h3>{modal === 'create' ? 'New Event' : 'Edit Event'}</h3>
                        <div className={s.formGroup}>
                            <label>Title</label>
                            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Event title" autoFocus />
                        </div>
                        <div className={s.formGroup}>
                            <label>Description</label>
                            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Optional description" rows={2} />
                        </div>
                        <div className={s.formRow}>
                            <div className={s.formGroup}>
                                <label>Start</label>
                                <input type="datetime-local" value={form.start_time} min={modal === 'create' ? nowMin : undefined}
                                    onChange={e => handleStartChange(e.target.value)} />
                            </div>
                            <div className={s.formGroup}>
                                <label>End</label>
                                <input type="datetime-local" value={form.end_time} min={form.start_time}
                                    onChange={e => setForm({ ...form, end_time: e.target.value })} />
                            </div>
                        </div>
                        <div className={s.formRow}>
                            <div className={s.formGroup}>
                                <label>Color</label>
                                <div className={s.colorPicker}>
                                    {COLORS.map(c => (
                                        <button key={c} className={`${s.colorDot} ${form.color === c ? s.colorDotActive : ''}`}
                                            style={{ background: c }} onClick={() => setForm({ ...form, color: c })} />
                                    ))}
                                </div>
                            </div>
                            <label className={s.checkbox}>
                                <input type="checkbox" checked={form.all_day} onChange={e => setForm({ ...form, all_day: e.target.checked })} />
                                All day
                            </label>
                        </div>
                        {tasks.length > 0 && (
                            <div className={s.formGroup}>
                                <label>Link to Task</label>
                                <select value={form.task_id} onChange={e => setForm({ ...form, task_id: e.target.value })}>
                                    <option value="">None</option>
                                    {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                                </select>
                            </div>
                        )}
                        <div className={s.formActions}>
                            {modal !== 'create' && <button className={s.deleteBtn} onClick={handleDelete}>Delete</button>}
                            <div className={s.formActionsRight}>
                                <button className={s.cancelBtn} onClick={() => setModal(null)}>Cancel</button>
                                <button className={s.saveBtn} onClick={handleSave}>Save</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
