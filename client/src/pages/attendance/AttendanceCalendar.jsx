import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';
import { getHistory, getLeaves, getHolidays, getLocalToday, getCurrentOrg, getStatus } from '../../api';
import { useLiveTimer } from '../../hooks/useLiveTimer';
import { STATUS_POLL_INTERVAL } from '../../constants';
import s from './AttendanceCalendar.module.css';

/* ---------- helpers ---------- */
const fmtYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function buildMonthMatrix(year, month /* 0-11 */) {
    const first = new Date(year, month, 1);
    const startWeekday = first.getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    // leading blanks
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    // pad to multiple of 7
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------- component ---------- */
export default function AttendanceCalendar({ refreshKey = 0 }) {
    const today = useMemo(() => new Date(getLocalToday() + 'T00:00:00'), []);
    const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

    const [history, setHistory] = useState([]);
    const [leaves, setLeaves] = useState([]);
    const [holidays, setHolidays] = useState([]);
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    /* Live session tracking — poll /tracker/status so today's cell flips to
       present as soon as the threshold is reached, without waiting for a page reload. */
    const [liveStatus, setLiveStatus] = useState(null);
    const { liveFloorSec } = useLiveTimer(liveStatus);

    useEffect(() => {
        let cancelled = false;
        const fetchLiveStatus = async () => {
            if (cancelled) return;
            try {
                const res = await getStatus();
                if (!cancelled) setLiveStatus(res.data || null);
            } catch { /* keep previous value */ }
        };
        fetchLiveStatus();
        const poll = setInterval(() => {
            if (!document.hidden && !cancelled) fetchLiveStatus();
        }, STATUS_POLL_INTERVAL);
        const onVisible = () => { if (!document.hidden && !cancelled) fetchLiveStatus(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            clearInterval(poll);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    /* Live floor minutes: ticks every second when on_floor, otherwise uses last
       stored value from the server. Mirrors the same formula in useFloatingTimer. */
    const liveFloorMinutes = useMemo(() => {
        const state = liveStatus?.state || 'logged_out';
        const sec = state === 'logged_out'
            ? (liveStatus?.floorMinutes || 0) * 60
            : liveFloorSec;
        return Math.floor(sec / 60);
    }, [liveStatus, liveFloorSec]);

    /* Minimum hours an employee must log to be considered Present.
       Sourced from organization settings (min_hours_present). Falls back to
       work_hours_per_day / 2, and finally to 4h if no org context exists. */
    const minHoursPresent = useMemo(() => {
        if (org?.min_hours_present != null && org.min_hours_present !== '') {
            const v = Number(org.min_hours_present);
            if (!isNaN(v) && v >= 0) return v;
        }
        if (org?.work_hours_per_day) {
            const v = Number(org.work_hours_per_day) / 2;
            if (!isNaN(v) && v > 0) return v;
        }
        return 4;
    }, [org]);

    const year = cursor.getFullYear();
    const month = cursor.getMonth();

    const firstDay = useMemo(() => fmtYMD(new Date(year, month, 1)), [year, month]);
    const lastDay = useMemo(() => fmtYMD(new Date(year, month + 1, 0)), [year, month]);

    const fetchAll = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [hRes, lRes, holRes, orgRes] = await Promise.allSettled([
                getHistory(firstDay, lastDay),
                getLeaves(firstDay, lastDay),
                getHolidays(year),
                getCurrentOrg(),
            ]);
            setHistory(hRes.status === 'fulfilled' ? (hRes.value.data || []) : []);
            setLeaves(lRes.status === 'fulfilled' ? (lRes.value.data || []) : []);
            setHolidays(holRes.status === 'fulfilled' ? (holRes.value.data || []) : []);
            // org may legitimately be null for users not in any organization
            setOrg(orgRes.status === 'fulfilled' ? (orgRes.value.data || null) : null);
        } catch {
            setError('Failed to load attendance data');
        } finally {
            setLoading(false);
        }
    }, [firstDay, lastDay, year]);

    useEffect(() => { fetchAll(); }, [fetchAll, refreshKey]);

    const cells = useMemo(() => buildMonthMatrix(year, month), [year, month]);
    const todayStr = fmtYMD(today);

    /* index by date for O(1) lookup — present means at least minHoursPresent worked */
    const presentMap = useMemo(() => {
        const minMinutes = minHoursPresent * 60;
        const m = new Map();
        history.forEach(d => {
            if ((d.floorMinutes || 0) >= minMinutes) m.set(d.date, d);
        });
        // Also check the live session: if today is in the current month view and the
        // user has already reached the threshold, mark today as present immediately
        // (history may not include the in-progress session yet).
        const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
        if (isCurrentMonth && liveFloorMinutes >= minHoursPresent * 60) {
            if (!m.has(todayStr)) {
                m.set(todayStr, { date: todayStr, floorMinutes: liveFloorMinutes });
            }
        }
        return m;
    }, [history, minHoursPresent, liveFloorMinutes, year, month, today, todayStr]);

    /* Normalize date values that may arrive as ISO strings, Date objects, or YYYY-MM-DD */
    const toYMD = (v) => {
        if (!v) return '';
        if (typeof v === 'string') {
            // ISO 'YYYY-MM-DDTHH:mm...' or already 'YYYY-MM-DD'
            return v.slice(0, 10);
        }
        const d = new Date(v);
        if (isNaN(d)) return '';
        return fmtYMD(d);
    };

    const leaveMap = useMemo(() => {
        const m = new Map();
        leaves.forEach(l => {
            const k = toYMD(l.date);
            if (k) m.set(k, l);
        });
        return m;
    }, [leaves]);

    const holidayMap = useMemo(() => {
        const m = new Map();
        holidays.forEach(h => {
            const k = toYMD(h.date);
            if (k) m.set(k, h);
        });
        return m;
    }, [holidays]);

    /* statistics */
    const stats = useMemo(() => {
        let present = 0, absent = 0, leaveCount = 0, holidayCount = 0;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
            const dt = new Date(year, month, d);
            const ymd = fmtYMD(dt);
            if (dt > today) continue; // future days don't count
            const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
            const leave = leaveMap.get(ymd);
            const isHoliday = holidayMap.has(ymd);
            const isPresent = presentMap.has(ymd);

            if (isPresent) { present++; continue; }
            if (leave && leave.status === 'approved') { leaveCount++; continue; }
            if (isHoliday || isWeekend) { holidayCount++; continue; }
            absent++;
        }
        return { present, absent, leave: leaveCount, holiday: holidayCount };
    }, [year, month, presentMap, leaveMap, holidayMap, today]);

    const goPrev = () => setCursor(new Date(year, month - 1, 1));
    const goNext = () => setCursor(new Date(year, month + 1, 1));
    const goToday = () => setCursor(new Date(today.getFullYear(), today.getMonth(), 1));

    const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    /* day-cell renderer */
    const renderCell = (dt, idx) => {
        if (!dt) return <div key={`b-${idx}`} className={s.cellBlank} />;
        const ymd = fmtYMD(dt);
        const isFuture = dt > today;
        const isToday = ymd === todayStr;
        const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
        const leave = leaveMap.get(ymd);
        const holiday = holidayMap.get(ymd);
        const present = presentMap.get(ymd);

        // priority: present > leave > holiday > weekend > absent
        let kind = 'none';
        let title = dt.toDateString();

        if (present) {
            kind = 'present';
            // For today's live entry the floorMinutes might be the live count;
            // use liveFloorMinutes for today so the tooltip stays current.
            const displayMin = isToday ? Math.max(present.floorMinutes, liveFloorMinutes) : present.floorMinutes;
            const hrs = (displayMin / 60).toFixed(1);
            title += ` • Present (${hrs}h, min ${minHoursPresent}h)`;
        } else if (leave) {
            kind = leave.status === 'approved' ? 'leave' : 'leave-pending';
            title += ` • ${leave.leave_type} leave (${leave.status})`;
        } else if (holiday) {
            kind = 'holiday';
            title += ` • ${holiday.name || 'Holiday'}`;
        } else if (isWeekend) {
            kind = 'weekend';
            title += ' • Weekend';
        } else if (!isFuture) {
            kind = 'absent';
            title += ' • Absent';
        } else {
            kind = 'future';
        }

        return (
            <div
                key={ymd}
                className={`${s.cell} ${s[`kind_${kind.replace('-', '_')}`]} ${isToday ? s.today : ''}`}
                title={title}
                data-tooltip={title}
            >
                <span className={s.dayNum}>{dt.getDate()}</span>
                {kind === 'present' && <span className={s.dot} aria-hidden />}
                {kind === 'leave' && <span className={`${s.dot} ${s.dotLeave}`} aria-hidden />}
                {kind === 'leave-pending' && <span className={`${s.dot} ${s.dotLeavePending}`} aria-hidden />}
                {kind === 'absent' && <span className={`${s.dot} ${s.dotAbsent}`} aria-hidden />}
                {kind === 'holiday' && <span className={`${s.dot} ${s.dotHoliday}`} aria-hidden />}
            </div>
        );
    };

    return (
        <section className={s.wrap}>
            <header className={s.header}>
                <div className={s.titleRow}>
                    <CalendarIcon size={18} />
                    <h3 className={s.title}>Attendance Calendar</h3>
                </div>
                <div className={s.nav}>
                    <button className={s.navBtn} onClick={goPrev} aria-label="Previous month"><ChevronLeft size={16} /></button>
                    <button className={s.todayBtn} onClick={goToday}>{monthLabel}</button>
                    <button className={s.navBtn} onClick={goNext} aria-label="Next month"><ChevronRight size={16} /></button>
                </div>
            </header>

            {/* legend */}
            <div className={s.legend}>
                <span className={s.legendItem}><span className={`${s.swatch} ${s.swPresent}`} /> Present (≥ {minHoursPresent}h)</span>
                <span className={s.legendItem}><span className={`${s.swatch} ${s.swAbsent}`} /> Absent</span>
                <span className={s.legendItem}><span className={`${s.swatch} ${s.swLeave}`} /> Leave</span>
                <span className={s.legendItem}><span className={`${s.swatch} ${s.swLeavePending}`} /> Leave (pending)</span>
                <span className={s.legendItem}><span className={`${s.swatch} ${s.swHoliday}`} /> Holiday / Weekend</span>
            </div>

            {error && <div className={s.errorBanner}>{error}</div>}

            <div className={s.grid}>
                {WEEKDAYS.map(w => (
                    <div key={w} className={s.weekday}>{w}</div>
                ))}
                {loading
                    ? Array.from({ length: 35 }).map((_, i) => <div key={`sk-${i}`} className={s.cellSkeleton} />)
                    : cells.map((dt, i) => renderCell(dt, i))}
            </div>

            <div className={s.statsRow}>
                <div className={s.statCard}>
                    <span className={`${s.statDot} ${s.swPresent}`} />
                    <div>
                        <div className={s.statNum}>{stats.present}</div>
                        <div className={s.statLabel}>Present days</div>
                    </div>
                </div>
                <div className={s.statCard}>
                    <span className={`${s.statDot} ${s.swAbsent}`} />
                    <div>
                        <div className={s.statNum}>{stats.absent}</div>
                        <div className={s.statLabel}>Absent days</div>
                    </div>
                </div>
                <div className={s.statCard}>
                    <span className={`${s.statDot} ${s.swLeave}`} />
                    <div>
                        <div className={s.statNum}>{stats.leave}</div>
                        <div className={s.statLabel}>Leave days</div>
                    </div>
                </div>
                <div className={s.statCard}>
                    <span className={`${s.statDot} ${s.swHoliday}`} />
                    <div>
                        <div className={s.statNum}>{stats.holiday}</div>
                        <div className={s.statLabel}>Holiday/Weekend</div>
                    </div>
                </div>
            </div>
        </section>
    );
}