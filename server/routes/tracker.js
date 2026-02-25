const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// Helper: get "today" in the client's local timezone using x-timezone-offset header
// The header value is Date.getTimezoneOffset() in minutes (e.g. -330 for IST)
function getLocalToday(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000);
        return now.toISOString().slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
}

function getLocalDow(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000);
        return now.getUTCDay(); // 0=Sun, 6=Sat
    }
    return new Date().getUTCDay();
}

// SQLite modifier to convert UTC timestamps to client local time
// e.g. for IST (offset=-330): returns '+330 minutes'
function getTzModifier(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const shift = -offsetMin;
        return `${shift >= 0 ? '+' : ''}${shift} minutes`;
    }
    return '+0 minutes';
}

// Convert a UTC timestamp string to local date string using client offset
function getLocalDateFromTs(timestamp, req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const utcMs = new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
        return new Date(utcMs - offsetMin * 60000).toISOString().slice(0, 10);
    }
    return timestamp.slice(0, 10);
}

// Get current status for today
router.get('/status', auth, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const dow = getLocalDow(req);
    const isWeekend = dow === 0 || dow === 6;
    const entries = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) = date(?)
    ORDER BY timestamp ASC
  `).all(req.userId, tzMod, today);

    const status = computeStatus(entries);
    status.isWeekend = isWeekend;
    // Determine work mode from today's clock_in entry
    const clockInEntry = entries.find(e => e.entry_type === 'clock_in');
    status.workMode = clockInEntry?.work_mode || 'office';
    res.json(status);
});

// Login
router.post('/clock-in', auth, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const dow = getLocalDow(req);
    if (dow === 0 || dow === 6) {
        return res.status(400).json({ error: 'It\'s a weekend holiday! Enjoy your day off. 🎉' });
    }

    const lastEntry = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) = date(?)
    ORDER BY timestamp DESC LIMIT 1
  `).get(req.userId, tzMod, today);

    if (lastEntry && lastEntry.entry_type !== 'clock_out') {
        return res.status(400).json({ error: 'Already logged in. Logout first.' });
    }

    db.prepare('INSERT INTO time_entries (user_id, entry_type, work_mode) VALUES (?, ?, ?)').run(req.userId, 'clock_in', req.body.work_mode || 'office');
    // Save user's timezone offset for autoClockOut
    const tzOffset = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(tzOffset)) {
        db.prepare('UPDATE users SET timezone_offset = ? WHERE id = ?').run(tzOffset, req.userId);
    }
    res.json({ message: 'Logged in successfully' });
});

// Start break
router.post('/break-start', auth, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const lastEntry = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) = date(?)
    ORDER BY timestamp DESC LIMIT 1
  `).get(req.userId, tzMod, today);

    if (!lastEntry || lastEntry.entry_type === 'clock_out') {
        return res.status(400).json({ error: 'You must login first' });
    }
    if (lastEntry.entry_type === 'break_start') {
        return res.status(400).json({ error: 'Already on break' });
    }

    db.prepare('INSERT INTO time_entries (user_id, entry_type) VALUES (?, ?)').run(req.userId, 'break_start');
    res.json({ message: 'Break started' });
});

// End break
router.post('/break-end', auth, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const lastEntry = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) = date(?)
    ORDER BY timestamp DESC LIMIT 1
  `).get(req.userId, tzMod, today);

    if (!lastEntry || lastEntry.entry_type !== 'break_start') {
        return res.status(400).json({ error: 'You are not on break' });
    }

    db.prepare('INSERT INTO time_entries (user_id, entry_type) VALUES (?, ?)').run(req.userId, 'break_end');
    res.json({ message: 'Break ended, back to work!' });
});

// Logout
router.post('/clock-out', auth, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const lastEntry = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) = date(?)
    ORDER BY timestamp DESC LIMIT 1
  `).get(req.userId, tzMod, today);

    if (!lastEntry || lastEntry.entry_type === 'clock_out') {
        return res.status(400).json({ error: 'You are not logged in' });
    }

    // If on break, end the break first
    if (lastEntry.entry_type === 'break_start') {
        db.prepare('INSERT INTO time_entries (user_id, entry_type) VALUES (?, ?)').run(req.userId, 'break_end');
    }

    db.prepare('INSERT INTO time_entries (user_id, entry_type) VALUES (?, ?)').run(req.userId, 'clock_out');
    res.json({ message: 'Logged out. See you tomorrow!' });
});

// Get history for a date range
router.get('/history', auth, (req, res) => {
    const { from, to } = req.query;
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);
    const toDate = to || getLocalToday(req);
    const tzMod = getTzModifier(req);

    const entries = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) BETWEEN date(?) AND date(?)
    ORDER BY timestamp ASC
  `).all(req.userId, tzMod, fromDate, toDate);

    // Group by local date
    const grouped = {};
    entries.forEach(e => {
        const date = getLocalDateFromTs(e.timestamp, req);
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });

    const dailySummaries = Object.keys(grouped).sort().map(date => {
        const dayEntries = grouped[date];
        const today = getLocalToday(req);
        const summary = computeDaySummary(dayEntries, date === today);
        return { date, ...summary };
    });

    res.json(dailySummaries);
});

// Get weekly summary for charts
router.get('/analytics', auth, (req, res) => {
    const { days } = req.query;
    const numDays = parseInt(days) || 7;
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const fromDate = new Date(Date.now() - offsetMin * 60000 - numDays * 86400000).toISOString().slice(0, 10);
    const toDate = getLocalToday(req);
    const tzMod = getTzModifier(req);

    const entries = db.prepare(`
    SELECT * FROM time_entries 
    WHERE user_id = ? AND date(timestamp, ?) BETWEEN date(?) AND date(?)
    ORDER BY timestamp ASC
  `).all(req.userId, tzMod, fromDate, toDate);

    const grouped = {};
    entries.forEach(e => {
        const date = getLocalDateFromTs(e.timestamp, req);
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });

    const today = getLocalToday(req);
    const analytics = [];
    for (let i = 0; i < numDays; i++) {
        const d = new Date(Date.now() - offsetMin * 60000 - (numDays - 1 - i) * 86400000);
        const dateStr = d.toISOString().slice(0, 10);
        const dayEntries = grouped[dateStr] || [];
        const summary = computeDaySummary(dayEntries, dateStr === today);
        analytics.push({ date: dateStr, ...summary });
    }

    res.json(analytics);
});

// ============= MANUAL ENTRY =============

// Add a complete manual day entry (login, optional breaks, logout)
router.post('/manual-entry', auth, (req, res) => {
    const { date, clock_in, clock_out, breaks, timezoneOffset, work_mode } = req.body;

    if (!date || !clock_in) {
        return res.status(400).json({ error: 'Date and login time are required' });
    }

    // Convert local time string to UTC timestamp
    // timezoneOffset is in minutes (from Date.getTimezoneOffset()), e.g. -330 for IST
    // UTC = localTime + timezoneOffset
    const offsetMs = (typeof timezoneOffset === 'number') ? timezoneOffset * 60000 : 0;
    function toUTC(dateStr, timeStr) {
        const [year, month, day] = dateStr.split('-').map(Number);
        const [hours, minutes] = timeStr.split(':').map(Number);
        // Build epoch treating the values as-is (in UTC), then shift by client offset
        const baseMs = Date.UTC(year, month - 1, day, hours, minutes, 0);
        const utcMs = baseMs + offsetMs;
        return new Date(utcMs).toISOString().slice(0, 19).replace('T', ' ');
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Validate time format
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(clock_in) || (clock_out && !timeRegex.test(clock_out))) {
        return res.status(400).json({ error: 'Invalid time format. Use HH:MM' });
    }

    // Check if there are already entries for this date
    const tzMod = getTzModifier(req);
    const existing = db.prepare(`
        SELECT COUNT(*) as count FROM time_entries 
        WHERE user_id = ? AND date(timestamp, ?) = date(?)
    `).get(req.userId, tzMod, date);

    if (existing.count > 0) {
        return res.status(400).json({ error: 'Entries already exist for this date. Delete them first to add manual entries.' });
    }

    // Check if there is a leave on this date
    const leave = db.prepare(
        'SELECT id, leave_type FROM leaves WHERE user_id = ? AND date = ?'
    ).get(req.userId, date);
    if (leave) {
        return res.status(400).json({ error: `You have a ${leave.leave_type} leave on this date. Remove the leave first to add a manual entry.` });
    }

    const clockInTs = toUTC(date, clock_in);
    const clockOutTs = clock_out ? toUTC(date, clock_out) : null;

    // Validate logout is after login (compare local times for ordering)
    if (clock_out && clock_out <= clock_in) {
        return res.status(400).json({ error: 'Logout time must be after login time' });
    }

    // Validate breaks (compare local times for ordering)
    if (breaks && Array.isArray(breaks)) {
        for (const brk of breaks) {
            if (!brk.start || !brk.end || !timeRegex.test(brk.start) || !timeRegex.test(brk.end)) {
                return res.status(400).json({ error: 'Each break must have valid start and end times (HH:MM)' });
            }
            if (brk.end <= brk.start) {
                return res.status(400).json({ error: 'Break end time must be after break start time' });
            }
            if (brk.start < clock_in || (clock_out && brk.end > clock_out)) {
                return res.status(400).json({ error: 'Break times must be within clock-in and clock-out times' });
            }
        }
    }

    // Insert entries in a transaction
    const insertEntry = db.prepare('INSERT INTO time_entries (user_id, entry_type, timestamp, work_mode) VALUES (?, ?, ?, ?)');

    const transaction = db.transaction(() => {
        insertEntry.run(req.userId, 'clock_in', clockInTs, work_mode || 'office');

        if (breaks && Array.isArray(breaks)) {
            // Sort breaks by start time
            const sorted = [...breaks].sort((a, b) => a.start.localeCompare(b.start));
            for (const brk of sorted) {
                insertEntry.run(req.userId, 'break_start', toUTC(date, brk.start), null);
                insertEntry.run(req.userId, 'break_end', toUTC(date, brk.end), null);
            }
        }

        if (clockOutTs) {
            insertEntry.run(req.userId, 'clock_out', clockOutTs, null);
        }
    });

    try {
        transaction();
        res.json({ message: 'Manual entry added successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add manual entry' });
    }
});

// Delete all entries for a specific date (to allow re-entry)
router.delete('/entries/:date', auth, (req, res) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format' });
    }

    const tzMod = getTzModifier(req);
    const result = db.prepare(`
        DELETE FROM time_entries 
        WHERE user_id = ? AND date(timestamp, ?) = date(?)
    `).run(req.userId, tzMod, date);

    res.json({ message: `Deleted ${result.changes} entries for ${date}` });
});

// Get entries for a specific date
router.get('/entries/:date', auth, (req, res) => {
    const { date } = req.params;
    const tzMod = getTzModifier(req);
    const entries = db.prepare(`
        SELECT * FROM time_entries 
        WHERE user_id = ? AND date(timestamp, ?) = date(?)
        ORDER BY timestamp ASC
    `).all(req.userId, tzMod, date);

    res.json(entries);
});

// ============= DASHBOARD WIDGETS =============
router.get('/widgets', auth, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;

    // Get last 30 days of entries grouped by date
    const entries = db.prepare(`
        SELECT * FROM time_entries
        WHERE user_id = ? AND date(timestamp, ?) >= date(?, '-30 days')
        ORDER BY timestamp ASC
    `).all(req.userId, tzMod, today);

    const grouped = {};
    entries.forEach(e => {
        const date = getLocalDateFromTs(e.timestamp, req);
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });

    // Get leaves for the month
    const monthStart = today.slice(0, 7) + '-01';
    let leaveCount = 0;
    let leaveDatesSet = new Set();
    try {
        const leaveRows = db.prepare(`
            SELECT date FROM leaves
            WHERE user_id = ? AND date >= date(?, '-60 days') AND date <= ?
        `).all(req.userId, today, today);
        leaveRows.forEach(r => leaveDatesSet.add(r.date));
        // Count only current month leaves
        leaveRows.forEach(r => { if (r.date >= monthStart) leaveCount++; });
    } catch (e) { /* leaves table might not exist yet */ }

    // Average floor time (last 30 days, only days with entries)
    let totalFloorMin = 0;
    let workDays = 0;
    let targetMetDays = 0;
    let officeDays = 0;
    let remoteDays = 0;
    const TARGET = 480; // 8 hours mandatory target

    Object.keys(grouped).forEach(date => {
        const dayEntries = grouped[date];
        if (!dayEntries.some(e => e.entry_type === 'clock_in')) return;
        workDays++;
        const summary = computeDaySummary(dayEntries, date === today);
        totalFloorMin += summary.floorMinutes;
        if (summary.floorMinutes >= TARGET) targetMetDays++;
        if (summary.workMode === 'remote') remoteDays++;
        else officeDays++;
    });

    const avgFloorMinutes = workDays > 0 ? Math.round(totalFloorMin / workDays) : 0;

    // Punctuality: % of days clock-in was before 10:00 local time
    let earlyDays = 0;
    Object.values(grouped).forEach(dayEntries => {
        const ci = dayEntries.find(e => e.entry_type === 'clock_in');
        if (ci) {
            const utcMs = new Date(ci.timestamp.replace(' ', 'T') + 'Z').getTime();
            const localDate = new Date(utcMs - offsetMin * 60000);
            const h = localDate.getUTCHours();
            const m = localDate.getUTCMinutes();
            if (h < 10 || (h === 10 && m === 0)) earlyDays++;
        }
    });
    const punctualityPercent = workDays > 0 ? Math.round((earlyDays / workDays) * 100) : 0;

    // Attendance % for current month (scope workDays to current month only)
    let monthWorkDays = 0;
    Object.keys(grouped).forEach(date => {
        if (date >= monthStart && date <= today) {
            const dayEntries = grouped[date];
            if (dayEntries.some(e => e.entry_type === 'clock_in')) monthWorkDays++;
        }
    });
    const monthStartDate = new Date(monthStart + 'T00:00:00Z');
    const todayDate = new Date(today + 'T00:00:00Z');
    let totalWeekdays = 0;
    for (let d = new Date(monthStartDate); d <= todayDate; d.setDate(d.getDate() + 1)) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) totalWeekdays++;
    }
    const presentDays = monthWorkDays + leaveCount;
    const attendancePercent = totalWeekdays > 0 ? Math.min(100, Math.round((presentDays / totalWeekdays) * 100)) : 0;

    res.json({
        avgFloorMinutes, punctualityPercent, attendancePercent,
        targetMetDays, workDays, totalWeekdays, leaveCount,
        officeDays, remoteDays
    });
});

// ============= WEEKLY CHART DATA =============
router.get('/weekly', auth, (req, res) => {
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const now = new Date(Date.now() - offsetMin * 60000);
    const todayStr = getLocalToday(req);
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon...
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7)); // go back to Monday

    const mondayStr = monday.toISOString().slice(0, 10);
    const sundayDate = new Date(monday);
    sundayDate.setUTCDate(monday.getUTCDate() + 6);
    const sundayStr = sundayDate.toISOString().slice(0, 10);

    // Single batch query for the entire week
    const tzMod = getTzModifier(req);
    const allEntries = db.prepare(`
        SELECT * FROM time_entries 
        WHERE user_id = ? AND date(timestamp, ?) BETWEEN ? AND ?
        ORDER BY timestamp ASC
    `).all(req.userId, tzMod, mondayStr, sundayStr);

    // Group by local date
    const grouped = {};
    allEntries.forEach(e => {
        const date = getLocalDateFromTs(e.timestamp, req);
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });

    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setUTCDate(monday.getUTCDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        const dayName = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

        let hours = 0;
        const dayEntries = grouped[dateStr];
        if (dayEntries && dayEntries.length > 0) {
            const summary = computeDaySummary(dayEntries, dateStr === todayStr);
            hours = Math.round(summary.floorMinutes / 6) / 10; // round to 1 decimal
        }

        const isToday = dateStr === todayStr;
        days.push({ date: dateStr, day: dayName, hours, isToday });
    }

    res.json({ days });
});

// ============= TODAY'S TASK SUMMARY =============
router.get('/task-summary', auth, (req, res) => {
    const today = getLocalToday(req);

    let tasks = [];
    try {
        tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY priority DESC, created_at ASC')
            .all(req.userId, today);
    } catch (e) { /* tasks table might not exist */ }

    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'done').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;

    // Sort active tasks: in_progress first, then by priority (already sorted by DB)
    const activeTasks = tasks
        .filter(t => t.status === 'in_progress' || t.status === 'pending')
        .map(t => ({ title: t.title, priority: t.priority, status: t.status }));

    res.json({
        total, done, pending, inProgress,
        activeTasks
    });
});

// ============= THEME =============
router.get('/theme', auth, (req, res) => {
    const user = db.prepare('SELECT theme FROM users WHERE id = ?').get(req.userId);
    res.json({ theme: user?.theme || 'dark' });
});

router.put('/theme', auth, (req, res) => {
    const { theme } = req.body;
    if (!['dark', 'light'].includes(theme)) {
        return res.status(400).json({ error: 'Invalid theme' });
    }
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.userId);
    res.json({ theme, message: 'Theme updated' });
});

function computeStatus(entries) {
    if (entries.length === 0) {
        return { state: 'logged_out', floorMinutes: 0, breakMinutes: 0, entries: [] };
    }

    const last = entries[entries.length - 1];
    let state = 'logged_out';
    if (last.entry_type === 'clock_in' || last.entry_type === 'break_end') state = 'on_floor';
    else if (last.entry_type === 'break_start') state = 'on_break';
    else state = 'logged_out';

    const summary = computeDaySummary(entries, true);
    return { state, ...summary, entries };
}

function computeDaySummary(entries, isLive = false) {
    let floorMs = 0;
    let breakMs = 0;
    let clockInTime = null;
    let breakStartTime = null;
    let workMode = null;

    for (const e of entries) {
        const t = new Date(e.timestamp.replace(' ', 'T') + 'Z').getTime();
        switch (e.entry_type) {
            case 'clock_in':
                clockInTime = t;
                if (!workMode && e.work_mode) workMode = e.work_mode;
                break;
            case 'break_start':
                if (clockInTime) {
                    floorMs += t - clockInTime;
                    clockInTime = null;
                }
                breakStartTime = t;
                break;
            case 'break_end':
                if (breakStartTime) {
                    breakMs += t - breakStartTime;
                    breakStartTime = null;
                }
                clockInTime = t;
                break;
            case 'clock_out':
                if (breakStartTime) {
                    breakMs += t - breakStartTime;
                    breakStartTime = null;
                }
                if (clockInTime) {
                    floorMs += t - clockInTime;
                    clockInTime = null;
                }
                break;
        }
    }

    // If still logged in or on break, compute up to now (only for live/today's data)
    if (isLive) {
        const now = Date.now();
        if (clockInTime) floorMs += now - clockInTime;
        if (breakStartTime) breakMs += now - breakStartTime;
    }

    return {
        floorMinutes: Math.round(floorMs / 60000),
        breakMinutes: Math.round(breakMs / 60000),
        totalMinutes: Math.round((floorMs + breakMs) / 60000),
        workMode: workMode || 'office',
        entries
    };
}

module.exports = router;
