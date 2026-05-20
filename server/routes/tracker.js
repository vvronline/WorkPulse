const express = require('express');
const auth = require('../middleware/auth');
const { loadUserContext, ROLE_LEVEL } = require('../middleware/rbac');
const { findApprover } = require('../utils/approver');
const { logAction } = require('../utils/audit');
const { getLocalToday, getLocalDow, getTzModifier, getLocalDateFromTs, getOffsetMin } = require('../utils/timezone');
const { computeStatus, computeDaySummary } = require('../utils/timeCalc');
const { logger } = require('../utils/logger');
const { notifyByEmail } = require('../utils/mailer');
const { sendToUser } = require('../utils/ws');
const redis = require('../redis');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();
router.use(requireTenant);

const VALID_WORK_MODES = ['office', 'remote', 'hybrid'];

// Helper: fetch org config with Redis cache
async function getOrgWorkConfig(orgId, db, tenantId) {
    if (!orgId) return { work_hours_per_day: 8, work_days: '1,2,3,4,5' };
    const cached = await redis.getOrgConfig(tenantId, orgId);
    if (cached) return cached;
    const result = await db.query('SELECT work_hours_per_day, work_days FROM organizations WHERE id = $1', [orgId]);
    const config = result.rows[0] || { work_hours_per_day: 8, work_days: '1,2,3,4,5' };
    await redis.setOrgConfig(tenantId, orgId, config);
    return config;
}

// Helper: validate HH:MM time string (range-checked, not just format)
function isValidTime(str) {
    if (!/^\d{2}:\d{2}$/.test(str)) return false;
    const [h, m] = str.split(':').map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// Helper: convert timezone offset to a pg date expression.
// tzMod comes from getTzModifier() which is validated via clampOffset(),
// and we defensively extract and clamp the integer to prevent any injection.
function pgDateInTz(col, tzMod) {
    const minutes = parseInt(tzMod, 10) || 0;
    // Clamp to valid timezone range: UTC-12 (720) to UTC+14 (-840)
    const safe = Math.max(-840, Math.min(720, minutes));
    return `(${col} + INTERVAL '${safe} minutes')::date`;
}

// Get current status for today
router.get('/status', auth, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const dow = getLocalDow(req);
        const isWeekend = dow === 0 || dow === 6;

        // Load this user's org work hours target
        const orgRow = (await req.db.query(
            `SELECT u.org_id FROM users u WHERE u.id = $1`, [req.userId],
        )).rows[0];
        const orgConfig = await getOrgWorkConfig(orgRow?.org_id, req.db, req.tenantId);
        const targetMinutes = (orgConfig.work_hours_per_day || 8) * 60;

        const result = await req.db.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
               AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC, id ASC`,
            [req.userId, today],
        );
        let entries = result.rows;

        const status = computeStatus(entries);

        // Auto clock-out when daily target is met and user is still active
        // Only auto-clock-out for live sessions (non-manual entries)
        let autoLoggedOut = false;
        const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
        const isLiveSession = lastEntry && !lastEntry.is_manual;
        if (isLiveSession && status.state !== 'logged_out' && status.floorMinutes >= targetMinutes) {
            // Use transaction with row lock to prevent duplicate clock-outs from concurrent requests
            const didClockOut = await req.db.transaction(async (client) => {
                const latest = (await client.query(
                    `SELECT entry_type FROM time_entries WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date ORDER BY timestamp DESC, id DESC LIMIT 1 FOR UPDATE`,
                    [req.userId, today]
                )).rows[0];
                if (!latest || latest.entry_type === 'clock_out') return false;
                await client.query(
                    'INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)',
                    [req.userId, 'clock_out']
                );
                return true;
            });
            if (didClockOut) {
                logAction(req, 'auto_clock_out', 'time_entry', null, {
                    floorMinutes: status.floorMinutes, targetMinutes,
                });
                const refreshed = await req.db.query(
                    `SELECT * FROM time_entries
                     WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
                       AND (approval_status IS NULL OR approval_status != 'rejected')
                     ORDER BY timestamp ASC, id ASC`,
                    [req.userId, today],
                );
                entries = refreshed.rows;
                Object.assign(status, computeStatus(entries));
                autoLoggedOut = true;
            }
        }

        status.isWeekend = isWeekend;
        const clockInEntry = entries.find(e => e.entry_type === 'clock_in');
        status.workMode = clockInEntry?.work_mode || 'office';
        status.targetMinutes = targetMinutes;
        status.dailyTargetMet = status.floorMinutes >= targetMinutes;
        status.autoLoggedOut = autoLoggedOut;
        res.json(status);
    } catch (err) {
        req.log.error({ err }, 'Status error');
        res.status(500).json({ error: 'Failed to get status' });
    }
});

// Clock-in
router.post('/clock-in', auth, loadUserContext, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const dow = getLocalDow(req);

        let workDays = [1, 2, 3, 4, 5];
        if (req.userOrgId) {
            const orgConfig = await getOrgWorkConfig(req.userOrgId, req.db, req.tenantId);
            const wd = orgConfig.work_days;
            if (wd) workDays = wd.split(',').map(Number).filter(n => !isNaN(n));
        }
        if (!workDays.includes(dow)) {
            return res.status(400).json({ error: "It's a day off! Enjoy your rest. 🎉" });
        }

        // Block re-login if daily target already met without approved overtime
        if (req.userOrgId) {
            const orgConfig = await getOrgWorkConfig(req.userOrgId, req.db, req.tenantId);
            const targetMin = (orgConfig.work_hours_per_day || 8) * 60;
            const todayEntries = (await req.db.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp ASC, id ASC`,
                [req.userId, today],
            )).rows;
            const todayStatus = computeStatus(todayEntries);
            if (todayStatus.state === 'logged_out' && todayStatus.floorMinutes >= targetMin) {
                const approvedOT = (await req.db.query(
                    `SELECT id FROM approval_requests
                     WHERE requester_id = $1
                       AND type = 'overtime'
                       AND status = 'approved'
                       AND (metadata->>'date') = $2`,
                    [req.userId, today],
                )).rows[0];
                if (!approvedOT) {
                    return res.status(403).json({
                        error: 'Daily target reached. Apply for overtime approval to continue working.',
                        code: 'DAILY_TARGET_MET',
                    });
                }
            }
        }

        const validWorkModes = ['office', 'remote', 'hybrid'];
        const selectedWorkMode = validWorkModes.includes(req.body.work_mode) ? req.body.work_mode : 'office';

        // Validate timezone offset before any DB writes
        const tzOffset = getOffsetMin(req);
        if (tzOffset < -840 || tzOffset > 720) {
            return res.status(400).json({ error: 'Invalid timezone offset' });
        }

        const txResult = await req.db.transaction(async (client) => {
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
                   AND (is_manual IS NOT TRUE)
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (lastEntry && lastEntry.entry_type !== 'clock_out') {
                return { error: 'Already logged in. Logout first.' };
            }
            await client.query(
                'INSERT INTO time_entries (user_id, entry_type, work_mode) VALUES ($1, $2, $3)',
                [req.userId, 'clock_in', selectedWorkMode],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });

        await req.db.query('UPDATE users SET timezone_offset = $1 WHERE id = $2', [tzOffset, req.userId]);
        logAction(req, 'clock_in', 'time_entry', null, { work_mode: selectedWorkMode });
        res.json({ message: 'Logged in successfully' });
    } catch (err) {
        req.log.error({ err }, 'Clock-in error');
        res.status(500).json({ error: 'Clock-in failed' });
    }
});

// Break start
router.post('/break-start', auth, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);

        const txResult = await req.db.transaction(async (client) => {
            // Consider both live and manual entries so that a user with a
            // "still working" manual entry can still take a break / clock
            // out from the dashboard.
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (!lastEntry || lastEntry.entry_type === 'clock_out') return { error: 'You must login first' };
            if (lastEntry.entry_type === 'break_start') return { error: 'Already on break' };
            await client.query(
                'INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)',
                [req.userId, 'break_start'],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });
        logAction(req, 'break_start', 'time_entry', null, {});
        res.json({ message: 'Break started' });
    } catch (err) {
        req.log.error({ err }, 'Break-start error');
        res.status(500).json({ error: 'Failed to start break' });
    }
});

// Break end
router.post('/break-end', auth, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);

        const txResult = await req.db.transaction(async (client) => {
            // Consider both live and manual entries so manual sessions
            // remain operable from the dashboard.
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (!lastEntry || lastEntry.entry_type !== 'break_start') return { error: 'You are not on break' };
            await client.query(
                'INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)',
                [req.userId, 'break_end'],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });
        logAction(req, 'break_end', 'time_entry', null, {});
        res.json({ message: 'Break ended, back to work!' });
    } catch (err) {
        req.log.error({ err }, 'Break-end error');
        res.status(500).json({ error: 'Failed to end break' });
    }
});

// Clock-out
router.post('/clock-out', auth, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);

        const txResult = await req.db.transaction(async (client) => {
            // Consider both live and manual entries so a user with a
            // "still working" manual entry can clock out from the dashboard.
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (!lastEntry || lastEntry.entry_type === 'clock_out') return { error: 'You are not logged in' };
            // Auto-end break if user is on break, then clock out
            if (lastEntry.entry_type === 'break_start') {
                await client.query(
                    'INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)',
                    [req.userId, 'break_end'],
                );
            }
            await client.query(
                'INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)',
                [req.userId, 'clock_out'],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });
        // Set user status to offline on clock-out
        await req.db.query('UPDATE users SET user_status = $1, user_status_text = NULL WHERE id = $2', ['offline', req.userId]);
        await redis.setUserStatus(req.tenantId, req.userId, 'offline');
        logAction(req, 'clock_out', 'time_entry', null, {});
        res.json({ message: 'Logged out. See you tomorrow!' });
    } catch (err) {
        req.log.error({ err }, 'Clock-out error');
        res.status(500).json({ error: 'Clock-out failed' });
    }
});

// Get history for a date range
router.get('/history', auth, async (req, res) => {
    try {
        const { from, to } = req.query;
        const offsetMin = getOffsetMin(req);
        const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);
        const toDate = to || getLocalToday(req);
        const tzMod = getTzModifier(req);

        const result = await req.db.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1
               AND ${pgDateInTz('timestamp', tzMod)} BETWEEN $2::date AND $3::date
               AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC`,
            [req.userId, fromDate, toDate],
        );

        const grouped = {};
        result.rows.forEach(e => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const today = getLocalToday(req);
        const dailySummaries = Object.keys(grouped).sort().map(date => {
            const summary = computeDaySummary(grouped[date], date === today);
            return { date, ...summary };
        });

        res.json(dailySummaries);
    } catch (err) {
        req.log.error({ err }, 'History error');
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// Analytics (weekly chart)
router.get('/analytics', auth, async (req, res) => {
    try {
        const { days, from, to } = req.query;
        const offsetMin = getOffsetMin(req);
        let fromDate, toDate, numDays;

        if (from && to) {
            fromDate = from;
            toDate = to;
            numDays = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
            numDays = Math.min(Math.max(numDays, 1), 365);
        } else {
            numDays = Math.min(Math.max(parseInt(days) || 7, 1), 365);
            fromDate = new Date(Date.now() - offsetMin * 60000 - numDays * 86400000).toISOString().slice(0, 10);
            toDate = getLocalToday(req);
        }

        const tzMod = getTzModifier(req);

        const result = await req.db.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1
               AND ${pgDateInTz('timestamp', tzMod)} BETWEEN $2::date AND $3::date
               AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC`,
            [req.userId, fromDate, toDate],
        );

        const grouped = {};
        result.rows.forEach(e => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const today = getLocalToday(req);
        const analytics = [];
        const startMs = new Date(fromDate + 'T00:00:00Z').getTime();
        for (let i = 0; i < numDays; i++) {
            const d = new Date(startMs + i * 86400000);
            const dateStr = d.toISOString().slice(0, 10);
            const summary = computeDaySummary(grouped[dateStr] || [], dateStr === today);
            analytics.push({ date: dateStr, ...summary });
        }

        res.json(analytics);
    } catch (err) {
        req.log.error({ err }, 'Analytics error');
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Get pending manual entries for current user
router.get('/manual-entries', auth, loadUserContext, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT ar.id as request_id, ar.status as approval_status, ar.metadata, ar.created_at,
                    ar.reviewed_at, ar.reject_reason, u.full_name as approver_name
             FROM approval_requests ar
             LEFT JOIN users u ON u.id = ar.approver_id
             WHERE ar.requester_id = $1 AND ar.type = 'manual_entry'
             ORDER BY ar.created_at DESC
             LIMIT 50`,
            [req.userId],
        );
        res.json(result.rows.map(e => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })));
    } catch (err) {
        req.log.error({ err }, 'Manual entries error');
        res.status(500).json({ error: 'Failed to fetch manual entries' });
    }
});

// Add a complete manual day entry
router.post('/manual-entry', auth, loadUserContext, async (req, res) => {
    try {
        const { date, clock_in, clock_out, breaks, timezoneOffset, work_mode } = req.body;

        if (!date || !clock_in) return res.status(400).json({ error: 'Date and login time are required' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });

        if (!isValidTime(clock_in) || (clock_out && !isValidTime(clock_out))) {
            return res.status(400).json({ error: 'Invalid time format. Use HH:MM (00:00–23:59)' });
        }
        if (clock_out && clock_out <= clock_in) {
            return res.status(400).json({ error: 'Logout time must be after login time' });
        }

        if (typeof timezoneOffset === 'number' && (timezoneOffset < -840 || timezoneOffset > 720)) {
            return res.status(400).json({ error: 'Invalid timezone offset' });
        }
        const offsetMs = (typeof timezoneOffset === 'number') ? timezoneOffset * 60000 : 0;
        function toUTC(dateStr, timeStr) {
            const [year, month, day] = dateStr.split('-').map(Number);
            const [hours, minutes] = timeStr.split(':').map(Number);
            return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0) + offsetMs).toISOString();
        }

        if (breaks && Array.isArray(breaks)) {
            if (breaks.length > 20) return res.status(400).json({ error: 'Maximum 20 breaks allowed per day' });
            const sorted = [...breaks].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
            for (let i = 0; i < sorted.length; i++) {
                const brk = sorted[i];
                if (!brk.start || !brk.end || !isValidTime(brk.start) || !isValidTime(brk.end)) {
                    return res.status(400).json({ error: 'Each break must have valid start and end times (HH:MM, 00:00–23:59)' });
                }
                if (brk.end <= brk.start) return res.status(400).json({ error: 'Break end time must be after break start time' });
                if (brk.start < clock_in || (clock_out && brk.end > clock_out)) {
                    return res.status(400).json({ error: 'Break times must be within clock-in and clock-out times' });
                }
                if (i < sorted.length - 1 && brk.end > sorted[i + 1].start) {
                    return res.status(400).json({ error: 'Break times must not overlap' });
                }
            }
            // Validate total break duration doesn't exceed work duration
            if (clock_out) {
                let totalBreakMin = 0;
                for (const brk of sorted) {
                    const [sh, sm] = brk.start.split(':').map(Number);
                    const [eh, em] = brk.end.split(':').map(Number);
                    totalBreakMin += (eh * 60 + em) - (sh * 60 + sm);
                }
                const [cih, cim] = clock_in.split(':').map(Number);
                const [coh, com] = clock_out.split(':').map(Number);
                const workMin = (coh * 60 + com) - (cih * 60 + cim);
                if (totalBreakMin >= workMin) {
                    return res.status(400).json({ error: 'Total break duration cannot exceed work duration' });
                }
            }
        }

        const tzMod = getTzModifier(req);
        const existingRes = await req.db.query(
            `SELECT COUNT(*) AS count FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date`,
            [req.userId, date],
        );
        if (parseInt(existingRes.rows[0].count, 10) > 0) {
            return res.status(400).json({ error: 'Entries already exist for this date. Delete them first to add manual entries.' });
        }

        const leaveRes = await req.db.query(
            'SELECT id, leave_type FROM leaves WHERE user_id = $1 AND date = $2',
            [req.userId, date],
        );
        if (leaveRes.rows[0]) {
            return res.status(400).json({ error: `You have a ${leaveRes.rows[0].leave_type} leave on this date. Remove the leave first to add a manual entry.` });
        }

        // Reject if the date falls within a locked pay period for this org
        if (req.userOrgId) {
            const lockedPeriod = (await req.db.query(
                `SELECT label FROM pay_periods WHERE org_id = $1 AND start_date <= $2 AND end_date >= $2`,
                [req.userOrgId, date]
            )).rows[0];
            if (lockedPeriod) {
                return res.status(400).json({ error: `This date is in a locked pay period (${lockedPeriod.label}). Time entries cannot be modified.` });
            }
        }

        const isSuperAdmin = req.userRole === 'super_admin';
        let approvalStatus = isSuperAdmin ? 'approved' : 'pending';
        let needsApproval = !isSuperAdmin;

        const clockInTs = toUTC(date, clock_in);
        const clockOutTs = clock_out ? toUTC(date, clock_out) : null;
        let txApprover = null;

        await req.db.transaction(async (client) => {
            const ins = (uid, type, ts, wm) => client.query(
                'INSERT INTO time_entries (user_id, entry_type, timestamp, work_mode, is_manual, approval_status) VALUES ($1,$2,$3,$4,TRUE,$5)',
                [uid, type, ts, wm || null, approvalStatus],
            );
            await ins(req.userId, 'clock_in', clockInTs, VALID_WORK_MODES.includes(work_mode) ? work_mode : 'office');
            if (breaks && Array.isArray(breaks)) {
                const sorted = [...breaks].sort((a, b) => a.start.localeCompare(b.start));
                for (const brk of sorted) {
                    await ins(req.userId, 'break_start', toUTC(date, brk.start), null);
                    await ins(req.userId, 'break_end', toUTC(date, brk.end), null);
                }
            }
            if (clockOutTs) await ins(req.userId, 'clock_out', clockOutTs, null);

            if (needsApproval) {
                const approver = await findApprover(req.db, req.userId, req.userOrgId);
                txApprover = approver;
                await client.query(
                    `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                     VALUES ($1,$2,$3,'manual_entry',NULL,$4,$5)`,
                    [req.userOrgId || null, req.userId, approver?.id || null, 'Manual time entry',
                    JSON.stringify({ date, clock_in, clock_out: clock_out || null, work_mode: VALID_WORK_MODES.includes(work_mode) ? work_mode : 'office' })],
                );
            }
        });

        // Notify the manager/approver about the new manual entry (reuse approver from transaction)
        if (needsApproval && txApprover?.id) {
            try {
                const requesterName = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0]?.full_name || 'A team member';
                await req.db.query(
                    'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                    [txApprover.id, 'approval', 'New Manual Entry Request', `${requesterName} submitted a manual time entry for ${date}.`]
                );
                sendToUser(req.tenantId, txApprover.id, 'approval_update', { type: 'manual_entry', status: 'pending' });
            } catch (notifErr) {
                req.log.error({ err: notifErr }, 'Manager notification error (manual entry)');
            }
        }

        logAction(req, 'create', 'manual_entry', null, { date, clock_in, clock_out: clock_out || null, status: approvalStatus });
        res.json({
            message: needsApproval ? 'Manual entry submitted for approval' : 'Manual entry added successfully',
            status: approvalStatus,
            needsApproval,
        });
    } catch (err) {
        req.log.error({ err }, 'Manual entry error');
        res.status(500).json({ error: 'Failed to add manual entry' });
    }
});

// Edit a manual day entry
router.put('/manual-entry/:date', auth, loadUserContext, async (req, res) => {
    try {
        const { date } = req.params;
        const { clock_in, clock_out, breaks, timezoneOffset, work_mode } = req.body;

        if (!date || !clock_in) return res.status(400).json({ error: 'Date and login time are required' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });

        if (!isValidTime(clock_in) || (clock_out && !isValidTime(clock_out))) {
            return res.status(400).json({ error: 'Invalid time format. Use HH:MM (00:00–23:59)' });
        }
        if (clock_out && clock_out <= clock_in) return res.status(400).json({ error: 'Logout time must be after login time' });

        if (breaks && Array.isArray(breaks)) {
            if (breaks.length > 20) return res.status(400).json({ error: 'Maximum 20 breaks allowed' });
            const sorted = [...breaks].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
            for (let i = 0; i < sorted.length; i++) {
                const brk = sorted[i];
                if (!brk.start || !brk.end || !isValidTime(brk.start) || !isValidTime(brk.end)) {
                    return res.status(400).json({ error: 'Each break must have valid start and end times (HH:MM, 00:00–23:59)' });
                }
                if (brk.end <= brk.start) return res.status(400).json({ error: 'Break end must be after start' });
                if (brk.start < clock_in || (clock_out && brk.end > clock_out)) {
                    return res.status(400).json({ error: 'Break times must be within clock-in/out' });
                }
                if (i < sorted.length - 1 && brk.end > sorted[i + 1].start) {
                    return res.status(400).json({ error: 'Break times must not overlap' });
                }
            }
            // Validate total break duration doesn't exceed work duration
            if (clock_out) {
                let totalBreakMin = 0;
                for (const brk of sorted) {
                    const [sh, sm] = brk.start.split(':').map(Number);
                    const [eh, em] = brk.end.split(':').map(Number);
                    totalBreakMin += (eh * 60 + em) - (sh * 60 + sm);
                }
                const [cih, cim] = clock_in.split(':').map(Number);
                const [coh, com] = clock_out.split(':').map(Number);
                const workMin = (coh * 60 + com) - (cih * 60 + cim);
                if (totalBreakMin >= workMin) {
                    return res.status(400).json({ error: 'Total break duration cannot exceed work duration' });
                }
            }
        }

        if (typeof timezoneOffset === 'number' && (timezoneOffset < -840 || timezoneOffset > 720)) {
            return res.status(400).json({ error: 'Invalid timezone offset' });
        }
        const offsetMs = (typeof timezoneOffset === 'number') ? timezoneOffset * 60000 : 0;
        function toUTC(dateStr, timeStr) {
            const [year, month, day] = dateStr.split('-').map(Number);
            const [hours, minutes] = timeStr.split(':').map(Number);
            return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0) + offsetMs).toISOString();
        }

        // Reject if the date falls within a locked pay period for this org
        if (req.userOrgId) {
            const lockedPeriod = (await req.db.query(
                `SELECT label FROM pay_periods WHERE org_id = $1 AND start_date <= $2 AND end_date >= $2`,
                [req.userOrgId, date]
            )).rows[0];
            if (lockedPeriod) {
                return res.status(400).json({ error: `This date is in a locked pay period (${lockedPeriod.label}). Time entries cannot be modified.` });
            }
        }

        const isSuperAdmin = req.userRole === 'super_admin';
        let approvalStatus = isSuperAdmin ? 'approved' : 'pending';
        let needsApproval = !isSuperAdmin;

        const tzMod = getTzModifier(req);
        const clockInTs = toUTC(date, clock_in);
        const clockOutTs = clock_out ? toUTC(date, clock_out) : null;
        let txApproverEdit = null;

        await req.db.transaction(async (client) => {
            // Cancel existing pending approval for this date
            await client.query(
                `UPDATE approval_requests
                 SET status = 'rejected', reject_reason = 'Superseded by edit'
                 WHERE requester_id = $1 AND type = 'manual_entry' AND status = 'pending'
                   AND metadata::jsonb->>'date' = $2`,
                [req.userId, date],
            );

            // Delete existing entries
            await client.query(
                `DELETE FROM time_entries WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date`,
                [req.userId, date],
            );

            const ins = (uid, type, ts, wm) => client.query(
                'INSERT INTO time_entries (user_id, entry_type, timestamp, work_mode, is_manual, approval_status) VALUES ($1,$2,$3,$4,TRUE,$5)',
                [uid, type, ts, wm || null, approvalStatus],
            );
            await ins(req.userId, 'clock_in', clockInTs, VALID_WORK_MODES.includes(work_mode) ? work_mode : 'office');
            if (breaks && Array.isArray(breaks)) {
                const sorted = [...breaks].sort((a, b) => a.start.localeCompare(b.start));
                for (const brk of sorted) {
                    await ins(req.userId, 'break_start', toUTC(date, brk.start), null);
                    await ins(req.userId, 'break_end', toUTC(date, brk.end), null);
                }
            }
            if (clockOutTs) await ins(req.userId, 'clock_out', clockOutTs, null);

            if (needsApproval) {
                const approver = await findApprover(req.db, req.userId, req.userOrgId);
                txApproverEdit = approver;
                await client.query(
                    `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                     VALUES ($1,$2,$3,'manual_entry',NULL,$4,$5)`,
                    [req.userOrgId || null, req.userId, approver?.id || null, 'Manual time entry (edited)',
                    JSON.stringify({ date, clock_in, clock_out: clock_out || null, work_mode: VALID_WORK_MODES.includes(work_mode) ? work_mode : 'office' })],
                );
            }
        });

        // Notify the manager/approver about the edited manual entry (reuse approver from transaction)
        if (needsApproval && txApproverEdit?.id) {
            try {
                const requesterName = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0]?.full_name || 'A team member';
                await req.db.query(
                    'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                    [txApproverEdit.id, 'approval', 'Manual Entry Updated', `${requesterName} updated a manual time entry for ${date}.`]
                );
                sendToUser(req.tenantId, txApproverEdit.id, 'approval_update', { type: 'manual_entry', status: 'pending' });
            } catch (notifErr) {
                req.log.error({ err: notifErr }, 'Manager notification error (manual entry edit)');
            }
        }

        logAction(req, 'update', 'manual_entry', null, { date, clock_in, clock_out: clock_out || null, status: approvalStatus });
        res.json({
            message: needsApproval ? 'Entry updated and submitted for approval' : 'Entry updated successfully',
            status: approvalStatus,
            needsApproval,
        });
    } catch (err) {
        req.log.error({ err }, 'Manual entry edit error');
        res.status(500).json({ error: 'Failed to update entry' });
    }
});

// Delete all entries for a date
router.delete('/entries/:date', auth, loadUserContext, async (req, res) => {
    try {
        const { date } = req.params;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

        // Reject if the date falls within a locked pay period
        if (req.userOrgId) {
            const lockedPeriod = (await req.db.query(
                `SELECT label FROM pay_periods WHERE org_id = $1 AND start_date <= $2 AND end_date >= $2`,
                [req.userOrgId, date]
            )).rows[0];
            if (lockedPeriod) {
                return res.status(400).json({ error: `This date is in a locked pay period (${lockedPeriod.label}). Time entries cannot be deleted.` });
            }
        }

        const tzMod = getTzModifier(req);
        const protectedRes = await req.db.query(
            `SELECT 1 FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
               AND approval_status IN ('pending','approved')
             LIMIT 1`,
            [req.userId, date],
        );
        if (protectedRes.rowCount > 0) {
            return res.status(403).json({ error: 'Cannot delete entries that are pending approval or already approved. Contact your manager.' });
        }

        const result = await req.db.query(
            `DELETE FROM time_entries WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date`,
            [req.userId, date],
        );
        res.json({ message: `Deleted ${result.rowCount} entries for ${date}` });
    } catch (err) {
        req.log.error({ err }, 'Delete entries error');
        res.status(500).json({ error: 'Failed to delete entries' });
    }
});

// Get entries for a specific date
router.get('/entries/:date', auth, async (req, res) => {
    try {
        const { date } = req.params;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
        const tzMod = getTzModifier(req);
        const result = await req.db.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} = $2::date
             ORDER BY timestamp ASC`,
            [req.userId, date],
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'Get entries error');
        res.status(500).json({ error: 'Failed to fetch entries' });
    }
});

// Dashboard widgets
router.get('/widgets', auth, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const offsetMin = getOffsetMin(req);

        const entriesRes = await req.db.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} >= ($2::date - INTERVAL '30 days')
             ORDER BY timestamp ASC`,
            [req.userId, today],
        );

        const grouped = {};
        entriesRes.rows.forEach(e => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const monthStart = today.slice(0, 7) + '-01';
        let leaveCount = 0;
        let leaveDatesSet = new Set();
        try {
            const leaveRes = await req.db.query(
                `SELECT date FROM leaves WHERE user_id = $1 AND status = 'approved' AND date::date >= $2::date - INTERVAL '60 days' AND date::date <= $3::date`,
                [req.userId, today, today],
            );
            leaveRes.rows.forEach(r => leaveDatesSet.add(r.date));
            leaveRes.rows.forEach(r => { if (r.date >= monthStart) leaveCount++; });
        } catch (_) { }

        let totalFloorMin = 0, workDays = 0, targetMetDays = 0, officeDays = 0, remoteDays = 0;
        let orgWhpd = 8;
        if (req.userOrgId) {
            const orgConfig = await getOrgWorkConfig(req.userOrgId, req.db, req.tenantId);
            if (orgConfig.work_hours_per_day) orgWhpd = orgConfig.work_hours_per_day;
        }
        const TARGET = orgWhpd * 60;

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

        let earlyDays = 0;
        Object.values(grouped).forEach(dayEntries => {
            const ci = dayEntries.find(e => e.entry_type === 'clock_in');
            if (ci) {
                const utcMs = new Date(ci.timestamp).getTime();
                const localDate = new Date(utcMs - offsetMin * 60000);
                const h = localDate.getUTCHours();
                const m = localDate.getUTCMinutes();
                if (h < 10 || (h === 10 && m === 0)) earlyDays++;
            }
        });
        const punctualityPercent = workDays > 0 ? Math.round((earlyDays / workDays) * 100) : 0;

        let monthWorkDays = 0;
        Object.keys(grouped).forEach(date => {
            if (date >= monthStart && date <= today && grouped[date].some(e => e.entry_type === 'clock_in')) {
                monthWorkDays++;
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

        res.json({ avgFloorMinutes, punctualityPercent, attendancePercent, targetMetDays, workDays, totalWeekdays, leaveCount, officeDays, remoteDays });
    } catch (err) {
        req.log.error({ err }, 'Widgets error');
        res.status(500).json({ error: 'Failed to fetch widgets' });
    }
});

// Weekly chart data
router.get('/weekly', auth, async (req, res) => {
    try {
        const offsetMin = getOffsetMin(req);
        const now = new Date(Date.now() - offsetMin * 60000);
        const todayStr = getLocalToday(req);
        const dayOfWeek = now.getUTCDay();
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7));

        const mondayStr = monday.toISOString().slice(0, 10);
        const sunday = new Date(monday);
        sunday.setUTCDate(monday.getUTCDate() + 6);
        const sundayStr = sunday.toISOString().slice(0, 10);

        const tzMod = getTzModifier(req);
        const result = await req.db.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz('timestamp', tzMod)} BETWEEN $2::date AND $3::date
             ORDER BY timestamp ASC`,
            [req.userId, mondayStr, sundayStr],
        );

        const grouped = {};
        result.rows.forEach(e => {
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
                hours = Math.round(summary.floorMinutes / 6) / 10;
            }
            days.push({ date: dateStr, day: dayName, hours, isToday: dateStr === todayStr });
        }

        res.json({ days });
    } catch (err) {
        req.log.error({ err }, 'Weekly error');
        res.status(500).json({ error: 'Failed to fetch weekly data' });
    }
});

// Today task summary
router.get('/task-summary', auth, async (req, res) => {
    try {
        const today = getLocalToday(req);
        const result = await req.db.query(
            'SELECT * FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND date = $2 ORDER BY priority DESC, created_at ASC',
            [req.userId, today],
        );
        const tasks = result.rows;

        const total = tasks.length;
        const done = tasks.filter(t => t.status === 'done').length;
        const pending = tasks.filter(t => t.status === 'pending').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const inReview = tasks.filter(t => t.status === 'in_review').length;

        const activeTasks = tasks
            .filter(t => ['in_progress', 'in_review', 'pending'].includes(t.status))
            .map(t => ({ title: t.title, priority: t.priority, status: t.status }));

        res.json({ total, done, pending, inProgress, inReview, activeTasks });
    } catch (err) {
        req.log.error({ err }, 'Task summary error');
        res.status(500).json({ error: 'Failed to fetch task summary' });
    }
});

// Overtime request
router.post('/overtime-request', auth, loadUserContext, async (req, res) => {
    try {
        const { date, hours, reason } = req.body;
        if (!date || !hours || !reason) return res.status(400).json({ error: 'Date, hours, and reason are required' });
        if (typeof reason !== 'string' || reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or less' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
        const numHours = parseFloat(hours);
        if (isNaN(numHours) || numHours <= 0 || numHours > 24) return res.status(400).json({ error: 'Hours must be between 0 and 24' });

        const existingRes = await req.db.query(
            `SELECT id FROM approval_requests
             WHERE requester_id = $1 AND type = 'overtime' AND status = 'pending'
               AND metadata::jsonb->>'date' = $2`,
            [req.userId, date],
        );
        if (existingRes.rowCount > 0) {
            return res.status(400).json({ error: 'You already have a pending overtime request for this date' });
        }

        const approver = await findApprover(req.db, req.userId, req.userOrgId);
        await req.db.query(
            `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
             VALUES ($1,$2,$3,'overtime',NULL,$4,$5)`,
            [req.userOrgId || null, req.userId, approver?.id || null, reason,
            JSON.stringify({ date, hours: numHours })],
        );

        // Notify the manager/approver about the overtime request
        try {
            if (approver?.id) {
                const requesterName = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0]?.full_name || 'A team member';
                await req.db.query(
                    'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                    [approver.id, 'approval', 'Overtime Request', `${requesterName} requested ${numHours}h overtime for ${date}.`]
                );
                sendToUser(req.tenantId, approver.id, 'approval_update', { type: 'overtime', status: 'pending' });
            }
        } catch (notifErr) {
            req.log.error({ err: notifErr }, 'Manager notification error (overtime)');
        }

        logAction(req, 'create', 'overtime_request', null, { date, hours: numHours });
        res.json({ message: 'Overtime request submitted for approval' });
    } catch (err) {
        req.log.error({ err }, 'Overtime request error');
        res.status(500).json({ error: 'Failed to submit overtime request' });
    }
});

// Get overtime requests
router.get('/overtime-requests', auth, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT ar.id, ar.status, ar.reason, ar.metadata, ar.created_at, ar.reject_reason,
                    u.full_name as approver_name
             FROM approval_requests ar
             LEFT JOIN users u ON u.id = ar.approver_id
             WHERE ar.requester_id = $1 AND ar.type = 'overtime'
             ORDER BY ar.created_at DESC
             LIMIT 50`,
            [req.userId],
        );
        const requests = result.rows.map(r => {
            let meta = {};
            try { meta = JSON.parse(r.metadata); } catch (_) { }
            return { ...r, metadata: meta };
        });
        res.json(requests);
    } catch (err) {
        req.log.error({ err }, 'Overtime requests error');
        res.status(500).json({ error: 'Failed to fetch overtime requests' });
    }
});

// Theme
router.get('/theme', auth, async (req, res) => {
    try {
        const result = await req.db.query('SELECT theme FROM users WHERE id = $1', [req.userId]);
        res.json({ theme: result.rows[0]?.theme || 'dark' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch theme' });
    }
});

router.put('/theme', auth, async (req, res) => {
    try {
        const { theme } = req.body;
        if (!['dark', 'light'].includes(theme)) return res.status(400).json({ error: 'Invalid theme' });
        await req.db.query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.userId]);
        res.json({ theme, message: 'Theme updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update theme' });
    }
});

module.exports = router;