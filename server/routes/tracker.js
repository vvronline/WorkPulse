const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, ROLE_LEVEL } = require('../middleware/rbac');
const { findApprover } = require('../utils/approver');
const { logAction } = require('../utils/audit');
const { getLocalToday, getLocalDow, getTzModifier, getLocalDateFromTs } = require('../utils/timezone');
const { computeStatus, computeDaySummary } = require('../utils/timeCalc');

const router = express.Router();

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
router.post('/clock-in', auth, loadUserContext, (req, res) => {
    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const dow = getLocalDow(req);

    // Check org work_days if user belongs to an org, otherwise default to Mon-Fri
    let workDays = [1, 2, 3, 4, 5]; // Mon-Fri default
    if (req.userOrgId) {
        const org = db.prepare('SELECT work_days FROM organizations WHERE id = ?').get(req.userOrgId);
        if (org?.work_days) {
            workDays = org.work_days.split(',').map(Number).filter(n => !isNaN(n));
        }
    }
    if (!workDays.includes(dow)) {
        return res.status(400).json({ error: 'It\'s a day off! Enjoy your rest. 🎉' });
    }

    // Wrap in transaction to prevent race conditions
    const validWorkModes = ['office', 'remote', 'hybrid'];
    const selectedWorkMode = validWorkModes.includes(req.body.work_mode) ? req.body.work_mode : 'office';

    const txResult = db.transaction(() => {
        const lastEntry = db.prepare(`
            SELECT * FROM time_entries 
            WHERE user_id = ? AND date(timestamp, ?) = date(?)
            ORDER BY timestamp DESC LIMIT 1
        `).get(req.userId, tzMod, today);

        if (lastEntry && lastEntry.entry_type !== 'clock_out') {
            return { error: 'Already logged in. Logout first.' };
        }

        db.prepare('INSERT INTO time_entries (user_id, entry_type, work_mode) VALUES (?, ?, ?)').run(req.userId, 'clock_in', selectedWorkMode);
        return { ok: true };
    })();

    if (txResult.error) {
        return res.status(400).json({ error: txResult.error });
    }
    // Save user's timezone offset for autoClockOut
    const tzOffset = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(tzOffset)) {
        const clampedTz = Math.max(-720, Math.min(840, tzOffset));
        db.prepare('UPDATE users SET timezone_offset = ? WHERE id = ?').run(clampedTz, req.userId);
    }
    logAction(req, 'clock_in', 'time_entry', null, { work_mode: selectedWorkMode });
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
    logAction(req, 'break_start', 'time_entry', null, {});
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
    logAction(req, 'break_end', 'time_entry', null, {});
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
    logAction(req, 'clock_out', 'time_entry', null, {});
    res.json({ message: 'Clocked out. See you tomorrow!' });
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
    const numDays = Math.min(Math.max(parseInt(days) || 7, 1), 365);
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

// Get pending manual entries for current user
router.get('/manual-entries', auth, loadUserContext, (req, res) => {
    const entries = db.prepare(`
        SELECT ar.id as request_id, ar.status as approval_status, ar.metadata, ar.created_at, ar.reviewed_at,
               ar.reject_reason, u.full_name as approver_name
        FROM approval_requests ar
        LEFT JOIN users u ON u.id = ar.approver_id
        WHERE ar.requester_id = ? AND ar.type = 'manual_entry'
        ORDER BY ar.created_at DESC
        LIMIT 50
    `).all(req.userId);

    res.json(entries.map(e => ({
        ...e,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
    })));
});

// Add a complete manual day entry (login, optional breaks, logout)
router.post('/manual-entry', auth, loadUserContext, (req, res) => {
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
        if (breaks.length > 20) {
            return res.status(400).json({ error: 'Maximum 20 breaks allowed per day' });
        }
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

    // Determine if approval is needed
    let approvalStatus = 'approved';
    let needsApproval = false;

    // Needs approval if: user has a manager assigned, OR is in an org with role < hr_admin
    const hasManager = req.userManagerId != null;
    const isOrgSubordinate = req.userOrgId && (ROLE_LEVEL[req.userRole] || 1) < ROLE_LEVEL.hr_admin;
    if (hasManager || isOrgSubordinate) {
        approvalStatus = 'pending';
        needsApproval = true;
    }

    // Insert entries in a transaction
    const insertEntry = db.prepare('INSERT INTO time_entries (user_id, entry_type, timestamp, work_mode, is_manual, approval_status) VALUES (?, ?, ?, ?, 1, ?)');

    const transaction = db.transaction(() => {
        insertEntry.run(req.userId, 'clock_in', clockInTs, work_mode || 'office', approvalStatus);

        if (breaks && Array.isArray(breaks)) {
            // Sort breaks by start time
            const sorted = [...breaks].sort((a, b) => a.start.localeCompare(b.start));
            for (const brk of sorted) {
                insertEntry.run(req.userId, 'break_start', toUTC(date, brk.start), null, approvalStatus);
                insertEntry.run(req.userId, 'break_end', toUTC(date, brk.end), null, approvalStatus);
            }
        }

        if (clockOutTs) {
            insertEntry.run(req.userId, 'clock_out', clockOutTs, null, approvalStatus);
        }

        // Create approval request if needed
        if (needsApproval) {
            const approver = findApprover(req.userId, req.userOrgId);
            db.prepare(`
                INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                VALUES (?, ?, ?, 'manual_entry', NULL, ?, ?)
            `).run(
                req.userOrgId || null, req.userId, approver?.id || null,
                'Manual time entry',
                JSON.stringify({ date, clock_in, clock_out: clock_out || null, work_mode: work_mode || 'office' })
            );
        }
    });

    try {
        transaction();
        logAction(req, 'create', 'manual_entry', null, { date, clock_in, clock_out: clock_out || null, status: approvalStatus });
        res.json({
            message: needsApproval ? 'Manual entry submitted for approval' : 'Manual entry added successfully',
            status: approvalStatus,
            needsApproval
        });
    } catch (err) {
        console.error('Manual entry error:', err);
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
    // Use org's work_hours_per_day if available, otherwise default to 8
    let orgWhpd = 8;
    if (req.userOrgId) {
        const org = db.prepare('SELECT work_hours_per_day FROM organizations WHERE id = ?').get(req.userOrgId);
        if (org?.work_hours_per_day) orgWhpd = org.work_hours_per_day;
    }
    const TARGET = orgWhpd * 60; // target in minutes

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
    const inReview = tasks.filter(t => t.status === 'in_review').length;

    // Sort active tasks: in_progress first, then by priority (already sorted by DB)
    const activeTasks = tasks
        .filter(t => t.status === 'in_progress' || t.status === 'in_review' || t.status === 'pending')
        .map(t => ({ title: t.title, priority: t.priority, status: t.status }));

    res.json({
        total, done, pending, inProgress, inReview,
        activeTasks
    });
});

// ============= OVERTIME REQUEST =============
router.post('/overtime-request', auth, loadUserContext, (req, res) => {
    const { date, hours, reason } = req.body;
    if (!date || !hours || !reason) {
        return res.status(400).json({ error: 'Date, hours, and reason are required' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format' });
    }
    const numHours = parseFloat(hours);
    if (isNaN(numHours) || numHours <= 0 || numHours > 24) {
        return res.status(400).json({ error: 'Hours must be between 0 and 24' });
    }
    // Check for duplicate
    const existing = db.prepare(`
        SELECT id FROM approval_requests
        WHERE requester_id = ? AND type = 'overtime' AND status = 'pending'
          AND json_extract(metadata, '$.date') = ?
    `).get(req.userId, date);
    if (existing) {
        return res.status(400).json({ error: 'You already have a pending overtime request for this date' });
    }

    const approver = findApprover(req.userId, req.userOrgId);
    db.prepare(`
        INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
        VALUES (?, ?, ?, 'overtime', NULL, ?, ?)
    `).run(
        req.userOrgId || null, req.userId, approver?.id || null,
        reason,
        JSON.stringify({ date, hours: numHours })
    );
    logAction(req, 'create', 'overtime_request', null, { date, hours: numHours });
    res.json({ message: 'Overtime request submitted for approval' });
});

router.get('/overtime-requests', auth, (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT ar.id, ar.status, ar.reason, ar.metadata, ar.created_at, ar.reject_reason,
                   u.full_name as approver_name
            FROM approval_requests ar
            LEFT JOIN users u ON u.id = ar.approver_id
            WHERE ar.requester_id = ? AND ar.type = 'overtime'
            ORDER BY ar.created_at DESC
            LIMIT 50
        `).all(req.userId);

        const requests = rows.map(r => {
            let meta = {};
            try { meta = JSON.parse(r.metadata); } catch { }
            return { ...r, metadata: meta };
        });
        res.json(requests);
    } catch (err) {
        console.error('Overtime requests error:', err);
        res.status(500).json({ error: 'Failed to fetch overtime requests' });
    }
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

module.exports = router;
