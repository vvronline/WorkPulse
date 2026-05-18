import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video } from 'lucide-react';
import { getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, createMeeting, cancelMeeting } from '../../api';
import { useAuth } from '../../AuthContext';
import { useBranding } from '../../BrandingContext';
import useWebSocket from '../../hooks/useWebSocket';
import EventFormModal from './EventFormModal';
import s from './Calendar.module.css';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function pad(n) { return String(n).padStart(2, '0'); }
function formatHour(h) { return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`; }
function toLocalISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function isBeforeToday(d, now = new Date()) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return day < today;
}
function getMondayStart(d) {
    const date = new Date(d);
    const day = (date.getDay() + 6) % 7; // Mon=0...Sun=6
    date.setDate(date.getDate() - day);
    date.setHours(0, 0, 0, 0);
    return date;
}
function toMonDayIndex(date) {
    return (date.getDay() + 6) % 7; // Mon=0...Sun=6
}

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
    const navigate = useNavigate();
    const { user } = useAuth();
    const { branding } = useBranding();
    const accentColor = branding.accent_color || '#2383e2';
    const [events, setEvents] = useState([]);
    const [view, setView] = useState('week');
    const [baseDate, setBaseDate] = useState(() => new Date());
    const [modal, setModal] = useState(null);
    const [form, setForm] = useState({
        title: '',
        description: '',
        start_time: '',
        end_time: '',
        all_day: false,
        color: '',
        task_id: '',
        schedule_mode: 'single',
        weekdays: [],
    });
    const [editingMeetingCode, setEditingMeetingCode] = useState(null);
    const [editingMeetingCreatedBy, setEditingMeetingCreatedBy] = useState(null);
    const gridRef = useRef(null);
    const today = new Date();

    const weekDays = getWeekDays(baseDate);
    const monthDays = getMonthDays(baseDate);
    const rangeStart = view === 'day' ? new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
        : view === 'week' ? new Date(weekDays[0].getFullYear(), weekDays[0].getMonth(), weekDays[0].getDate())
        : monthDays[0];
    const rangeEnd = view === 'day' ? new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1)
        : view === 'week' ? new Date(weekDays[6].getFullYear(), weekDays[6].getMonth(), weekDays[6].getDate() + 1)
        : new Date(monthDays[41].getTime() + 86400000);

    const fetchEvents = useCallback(() => {
        getCalendarEvents(rangeStart.toISOString(), rangeEnd.toISOString())
            .then(r => setEvents(r.data || []))
            .catch(() => {});
    }, [rangeStart.toISOString(), rangeEnd.toISOString()]);

    useEffect(() => { fetchEvents(); }, [fetchEvents]);

    // Listen for real-time calendar refresh events (e.g. edits from another window/device)
    useWebSocket(useCallback((msg) => {
        if (msg.type === 'calendar_refresh' || msg.type === 'meeting_updated' || msg.type === 'meeting_cancelled') {
            fetchEvents();
        }
    }, [fetchEvents]));

    useEffect(() => {
        if (gridRef.current && (view === 'week' || view === 'day')) {
            const now = new Date();
            const scrollTo = Math.max(0, (now.getHours() - 1) * 60);
            gridRef.current.scrollTop = scrollTo;
        }
    }, [view, baseDate]);

    const navigateDate = (dir) => {
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

        // Do not allow opening the create modal for a past day.
        if (hour == null && isBeforeToday(start, now)) return;

        if (hour == null) {
            // Button path: default to current time on selected day.
            start.setHours(now.getHours(), now.getMinutes(), 0, 0);
        } else {
            start.setHours(hour, 0, 0, 0);
        }

        // Do not allow selecting past times in the calendar grid.
        if (hour != null && start < now) return;

        const rem = start.getMinutes() % 15;
        if (rem > 0) start.setMinutes(start.getMinutes() + (15 - rem), 0, 0);
        const end = new Date(start); end.setHours(start.getHours() + 1);
        setForm({
            title: '',
            description: '',
            start_time: toLocalISO(start),
            end_time: toLocalISO(end),
            all_day: false,
            color: accentColor,
            task_id: '',
            schedule_mode: 'single',
            weekdays: [toMonDayIndex(start)],
        });
        setModal('create');
    };

    const openEdit = (evt) => {
        setForm({
            title: evt.title, description: evt.description || '', color: evt.color || accentColor, task_id: evt.task_id || '',
            start_time: toLocalISO(new Date(evt.start_time)), end_time: toLocalISO(new Date(evt.end_time)), all_day: evt.all_day,
            schedule_mode: 'single', weekdays: [],
        });
        setEditingMeetingCode(evt.meeting_code || null);
        setEditingMeetingCreatedBy(evt.meeting_created_by || null);
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

    const handleSave = async (meetingOptions) => {
        if (!form.title.trim() || !form.start_time || !form.end_time) return;
        if (modal === 'create') {
            const now = new Date();
            const start = new Date(form.start_time);
            if (form.all_day) {
                const todayLocal = toLocalISO(now).slice(0, 10);
                const startLocal = form.start_time.slice(0, 10);
                if (startLocal < todayLocal) return;
            } else if (start < now) {
                return;
            }
        }
        const baseStart = new Date(form.start_time);
        const baseEnd = new Date(form.end_time);
        const durationMs = baseEnd.getTime() - baseStart.getTime();
        const makePayload = (startDate, endDate, meetingId = null) => ({
            title: form.title,
            description: form.description,
            all_day: form.all_day,
            color: form.color,
            task_id: form.task_id || null,
            meeting_id: meetingId,
            start_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
        });

        try {
            if (modal === 'create') {
                const now = new Date();
                const todayLocal = toLocalISO(now).slice(0, 10);
                const datesToCreate = (() => {
                    if (form.schedule_mode !== 'multi' || !Array.isArray(form.weekdays) || form.weekdays.length === 0) {
                        return [new Date(baseStart)];
                    }
                    const weekStart = getMondayStart(baseStart);
                    const unique = [...new Set(form.weekdays.filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b);
                    return unique.map(dayIdx => {
                        const d = new Date(weekStart);
                        d.setDate(weekStart.getDate() + dayIdx);
                        d.setHours(baseStart.getHours(), baseStart.getMinutes(), 0, 0);
                        return d;
                    });
                })();
                if (!datesToCreate.length) return;

                for (const eventStart of datesToCreate) {
                    const eventEnd = new Date(eventStart.getTime() + durationMs);
                    if (form.all_day) {
                        const dateLocal = toLocalISO(eventStart).slice(0, 10);
                        if (dateLocal < todayLocal) continue;
                    } else if (eventStart < now) {
                        continue;
                    }

                    let meetingId = null;
                    if (meetingOptions) {
                        // Create a corresponding meeting for each generated event occurrence.
                        const mtgRes = await createMeeting({
                            title: form.title.trim(),
                            description: form.description || undefined,
                            required_participant_ids: meetingOptions.required.map(p => p.id),
                            optional_participant_ids: meetingOptions.optional.map(p => p.id),
                            settings: meetingOptions.settings,
                            start_time: eventStart.toISOString(),
                            end_time: eventEnd.toISOString(),
                        });
                        meetingId = mtgRes.data.id;
                    }
                    await createCalendarEvent(makePayload(eventStart, eventEnd, meetingId));
                }
            } else {
                await updateCalendarEvent(modal, makePayload(baseStart, baseEnd));
            }
            setModal(null);
            setEditingMeetingCode(null);
            setEditingMeetingCreatedBy(null);
            fetchEvents();
        } catch (e) { console.error(e); }
    };

    const handleDelete = async () => {
        if (modal === 'create') return;
        try {
            await deleteCalendarEvent(modal);
            setModal(null);
            setEditingMeetingCode(null);
            setEditingMeetingCreatedBy(null);
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

    const layoutEvents = (evts, day) => {
        const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
        const items = evts.map(ev => {
            const s = Math.max(0, (new Date(ev.start_time) - dayStart) / 60000);
            const e = Math.min(1440, (new Date(ev.end_time) - dayStart) / 60000);
            return { ev, startMin: s, endMin: e };
        }).sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));

        const columns = [];
        const placed = [];
        for (const item of items) {
            let col = 0;
            while (columns[col] && columns[col] > item.startMin) col++;
            columns[col] = item.endMin;
            placed.push({ ...item, col });
        }

        return placed.map(p => {
            let maxCol = p.col;
            for (const o of placed) {
                if (o.startMin < p.endMin && o.endMin > p.startMin) {
                    maxCol = Math.max(maxCol, o.col);
                }
            }
            return { ...p, total: maxCol + 1 };
        });
    };

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
                                    <div
                                        key={h}
                                        className={`${s.hourSlot} ${(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0) < new Date()) ? s.hourSlotDisabled : ''}`}
                                        onClick={() => {
                                            const slotStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0);
                                            if (slotStart < new Date()) return;
                                            openCreate(day, h);
                                        }}
                                    />
                                ))}
                                {layoutEvents(dayEvents, day).map(({ ev, startMin, endMin, col, total }) => {
                                    const evStart = new Date(ev.start_time);
                                    const evEnd = new Date(ev.end_time);
                                    const top = startMin;
                                    const height = Math.max(20, endMin - startMin);
                                    const gap = 2;
                                    const colW = total === 1 ? undefined : `calc((100% - ${gap * (total + 1)}px) / ${total})`;
                                    const colL = total === 1 ? '2px' : `calc(${col} * ((100% - ${gap * (total + 1)}px) / ${total}) + ${gap * (col + 1)}px)`;
                                    const evColor = ev.meeting_code ? accentColor : (ev.color || accentColor);
                                    const evStyle = total === 1
                                        ? { top: `${top}px`, height: `${height}px`, left: '2px', right: '2px', '--ev-color': evColor }
                                        : { top: `${top}px`, height: `${height}px`, left: colL, width: colW, '--ev-color': evColor };
                                    return (
                                        <div key={ev.id} className={s.event}
                                            style={evStyle}
                                            onClick={(e) => { e.stopPropagation(); openEdit(ev); }}>
                                            <span className={s.eventTitle}>
                                                {ev.meeting_code && <span className={s.eventMeetingBadge}><Video size={11} /></span>}
                                                {ev.title}
                                            </span>
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
                                        <div key={ev.id} className={s.allDayEvent} style={{ '--ev-color': ev.meeting_code ? accentColor : (ev.color || accentColor) }}
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
                            <div key={ev.id} className={s.monthEvent} style={{ '--ev-color': ev.meeting_code ? accentColor : (ev.color || accentColor) }}
                                onClick={(e) => { e.stopPropagation(); openEdit(ev); }}>
                                {ev.meeting_code && <span className={s.eventMeetingBadge}><Video size={9} /></span>}
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
                    <button className={s.navBtn} onClick={() => navigateDate(-1)}>‹</button>
                    <button className={s.todayBtn} onClick={goToday}>Today</button>
                    <button className={s.navBtn} onClick={() => navigateDate(1)}>›</button>
                    <h2 className={s.title}>{getTitle()}</h2>
                </div>
                <div className={s.toolbarRight}>
                    <button
                        className={s.addBtn}
                        onClick={() => openCreate(isBeforeToday(baseDate) ? new Date() : baseDate)}
                    >
                        New Event
                    </button>
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
                <div className={s.timeGridWrapper} style={{ '--day-count': view === 'day' ? 1 : 7 }}>
                    {renderTimeGrid(view === 'week' ? weekDays : [baseDate])}
                </div>
            )}
            {view === 'month' && renderMonthGrid()}

            <EventFormModal
                modal={modal}
                form={form}
                setForm={setForm}
                nowMin={nowMin}
                tasks={tasks}
                onSave={handleSave}
                onDelete={handleDelete}
                onClose={() => { setModal(null); setEditingMeetingCode(null); setEditingMeetingCreatedBy(null); }}
                onStartChange={handleStartChange}
                existingMeetingCode={editingMeetingCode}
                isOrganizer={!editingMeetingCode || (editingMeetingCreatedBy === user?.id)}
            />
        </div>
    );
}
