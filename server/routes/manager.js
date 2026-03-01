/**
 * Manager Dashboard routes — team oversight, approvals, team analytics.
 * Requires team_lead+ role.
 */
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg, getVisibleUserIds } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { getLocalToday, getTzModifier, getLocalDateFromTs } = require('../utils/timezone');

const router = express.Router();

router.use(auth, loadUserContext, requireRole('team_lead'), requireSameOrg);

// ==================== TEAM ATTENDANCE ====================

// Real-time attendance status for all visible team members
router.get('/team-attendance', (req, res) => {
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
    if (visibleIds.length === 0) return res.json([]);

    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const placeholders = visibleIds.map(() => '?').join(',');

    const users = db.prepare(`
        SELECT id, full_name, avatar, role, team_id, department_id
        FROM users
        WHERE id IN (${placeholders}) AND is_active = 1
    `).all(...visibleIds);

    const entries = db.prepare(`
        SELECT * FROM time_entries
        WHERE user_id IN (${placeholders}) AND date(timestamp, ?) = date(?)
        ORDER BY timestamp ASC
    `).all(...visibleIds, tzMod, today);

    // Group entries by user
    const userEntries = {};
    entries.forEach(e => {
        if (!userEntries[e.user_id]) userEntries[e.user_id] = [];
        userEntries[e.user_id].push(e);
    });

    const result = users.map(u => {
        const ue = userEntries[u.id] || [];
        let state = 'logged_out';
        let floorMs = 0, breakMs = 0, clockInTime = null, breakStartTime = null, workMode = null;

        for (const e of ue) {
            const t = new Date(e.timestamp.replace(' ', 'T') + 'Z').getTime();
            switch (e.entry_type) {
                case 'clock_in':
                    clockInTime = t;
                    if (!workMode && e.work_mode) workMode = e.work_mode;
                    break;
                case 'break_start':
                    if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; }
                    breakStartTime = t;
                    break;
                case 'break_end':
                    if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; }
                    clockInTime = t;
                    break;
                case 'clock_out':
                    if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; }
                    if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; }
                    break;
            }
        }

        // Live calculation
        const now = Date.now();
        if (clockInTime) floorMs += now - clockInTime;
        if (breakStartTime) breakMs += now - breakStartTime;

        const last = ue[ue.length - 1];
        if (last) {
            if (last.entry_type === 'clock_in' || last.entry_type === 'break_end') state = 'on_floor';
            else if (last.entry_type === 'break_start') state = 'on_break';
            else state = 'logged_out';
        }

        return {
            id: u.id,
            full_name: u.full_name,
            avatar: u.avatar,
            role: u.role,
            state,
            floorMinutes: Math.round(floorMs / 60000),
            breakMinutes: Math.round(breakMs / 60000),
            workMode: workMode || 'office',
            clockInTime: ue.find(e => e.entry_type === 'clock_in')?.timestamp || null,
        };
    });

    res.json(result);
});

// ==================== TEAM ANALYTICS ====================

router.get('/team-analytics', (req, res) => {
    const { days } = req.query;
    const numDays = parseInt(days) || 7;
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
    if (visibleIds.length === 0) return res.json({ members: [], summary: {} });

    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const today = getLocalToday(req);
    const fromDate = new Date(Date.now() - offsetMin * 60000 - numDays * 86400000).toISOString().slice(0, 10);
    const tzMod = getTzModifier(req);
    const placeholders = visibleIds.map(() => '?').join(',');

    const entries = db.prepare(`
        SELECT * FROM time_entries
        WHERE user_id IN (${placeholders}) AND date(timestamp, ?) BETWEEN date(?) AND date(?)
        ORDER BY timestamp ASC
    `).all(...visibleIds, tzMod, fromDate, today);

    // Group by user then by date
    const byUser = {};
    entries.forEach(e => {
        if (!byUser[e.user_id]) byUser[e.user_id] = {};
        const dateStr = getLocalDateFromTs(e.timestamp, req);
        if (!byUser[e.user_id][dateStr]) byUser[e.user_id][dateStr] = [];
        byUser[e.user_id][dateStr].push(e);
    });

    const users = db.prepare(`
        SELECT id, full_name, avatar FROM users
        WHERE id IN (${placeholders}) AND is_active = 1
    `).all(...visibleIds);

    let totalOrgFloor = 0, totalOrgDays = 0, totalAbsent = 0;

    const members = users.map(u => {
        const userDays = byUser[u.id] || {};
        let totalFloor = 0, daysWorked = 0, targetMet = 0;

        Object.values(userDays).forEach(dayEntries => {
            if (!dayEntries.some(e => e.entry_type === 'clock_in')) return;
            daysWorked++;
            const floorMs = computeFloorMs(dayEntries);
            const floorMin = Math.round(floorMs / 60000);
            totalFloor += floorMin;
            if (floorMin >= 480) targetMet++;
        });

        totalOrgFloor += totalFloor;
        totalOrgDays += daysWorked;

        const avgFloor = daysWorked > 0 ? Math.round(totalFloor / daysWorked) : 0;

        return {
            id: u.id,
            full_name: u.full_name,
            avatar: u.avatar,
            daysWorked,
            avgFloorMinutes: avgFloor,
            targetMetDays: targetMet,
            totalFloorMinutes: totalFloor,
        };
    });

    const summary = {
        totalMembers: members.length,
        avgFloorMinutes: totalOrgDays > 0 ? Math.round(totalOrgFloor / totalOrgDays) : 0,
        totalDaysWorked: totalOrgDays,
    };

    res.json({ members, summary });
});

// ==================== APPROVALS ====================

// Get pending approvals for the current user
router.get('/approvals', (req, res) => {
    const { status, type } = req.query;
    const filterStatus = status || 'pending';

    let where = ['ar.approver_id = ?'];
    let params = [req.userId];

    if (filterStatus !== 'all') { where.push('ar.status = ?'); params.push(filterStatus); }
    if (type) { where.push('ar.type = ?'); params.push(type); }

    const approvals = db.prepare(`
        SELECT ar.*, u.full_name as requester_name, u.avatar as requester_avatar
        FROM approval_requests ar
        JOIN users u ON u.id = ar.requester_id
        WHERE ${where.join(' AND ')}
        ORDER BY ar.created_at DESC
        LIMIT 200
    `).all(...params);

    // Parse metadata JSON
    const parsed = approvals.map(a => ({
        ...a,
        metadata: a.metadata ? JSON.parse(a.metadata) : null,
    }));

    res.json(parsed);
});

// Get my pending requests (as requester)
router.get('/my-requests', (req, res) => {
    const { status } = req.query;

    let where = ['ar.requester_id = ?'];
    let params = [req.userId];
    if (status && status !== 'all') { where.push('ar.status = ?'); params.push(status); }

    const requests = db.prepare(`
        SELECT ar.*, u.full_name as approver_name
        FROM approval_requests ar
        LEFT JOIN users u ON u.id = ar.approver_id
        WHERE ${where.join(' AND ')}
        ORDER BY ar.created_at DESC
        LIMIT 200
    `).all(...params);

    res.json(requests.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })));
});

// Approve a request
router.post('/approvals/:id/approve', (req, res) => {
    const { id } = req.params;
    const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(id));
    if (!approval) return res.status(404).json({ error: 'Request not found' });
    if (approval.approver_id !== req.userId && req.roleLevel < 4) {
        return res.status(403).json({ error: 'Not authorized to approve this request' });
    }
    if (approval.status !== 'pending') {
        return res.status(400).json({ error: `Request already ${approval.status}` });
    }

    db.prepare('UPDATE approval_requests SET status = ?, reviewed_at = CURRENT_TIMESTAMP, approver_id = ? WHERE id = ?')
        .run('approved', req.userId, Number(id));

    // Apply the actual change based on type
    if (approval.type === 'leave' && approval.reference_id) {
        db.prepare("UPDATE leaves SET status = 'approved', approved_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(req.userId, approval.reference_id);
    } else if (approval.type === 'manual_entry') {
        // Mark the time entries as approved
        const metadata = approval.metadata ? JSON.parse(approval.metadata) : {};
        if (metadata.date) {
            const tzMod = getTzModifier(req);
            db.prepare(`
                UPDATE time_entries SET approval_status = 'approved', approved_by = ?
                WHERE user_id = ? AND date(timestamp, ?) = date(?) AND is_manual = 1
            `).run(req.userId, approval.requester_id, tzMod, metadata.date);
        }
    }

    logAction(req, 'approve', 'approval_request', Number(id), { type: approval.type });
    res.json({ message: 'Request approved' });
});

// Reject a request
router.post('/approvals/:id/reject', (req, res) => {
    const { id } = req.params;
    const { reject_reason } = req.body;

    const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(id));
    if (!approval) return res.status(404).json({ error: 'Request not found' });
    if (approval.approver_id !== req.userId && req.roleLevel < 4) {
        return res.status(403).json({ error: 'Not authorized to reject this request' });
    }
    if (approval.status !== 'pending') {
        return res.status(400).json({ error: `Request already ${approval.status}` });
    }

    db.prepare('UPDATE approval_requests SET status = ?, reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP, approver_id = ? WHERE id = ?')
        .run('rejected', reject_reason || null, req.userId, Number(id));

    if (approval.type === 'leave' && approval.reference_id) {
        db.prepare("UPDATE leaves SET status = 'rejected', reject_reason = ?, approved_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(reject_reason || null, req.userId, approval.reference_id);
    } else if (approval.type === 'manual_entry') {
        const metadata = approval.metadata ? JSON.parse(approval.metadata) : {};
        if (metadata.date) {
            const tzMod = getTzModifier(req);
            db.prepare(`
                UPDATE time_entries SET approval_status = 'rejected', approved_by = ?
                WHERE user_id = ? AND date(timestamp, ?) = date(?) AND is_manual = 1
            `).run(req.userId, approval.requester_id, tzMod, metadata.date);
        }
    }

    logAction(req, 'reject', 'approval_request', Number(id), { type: approval.type, reject_reason });
    res.json({ message: 'Request rejected' });
});

// Bulk approve/reject
router.post('/approvals/bulk', (req, res) => {
    const { ids, action, reject_reason } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'IDs array is required' });
    }
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "Action must be 'approve' or 'reject'" });
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    let processed = 0;

    const tx = db.transaction(() => {
        for (const id of ids) {
            const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ? AND status = ?').get(id, 'pending');
            if (!approval) continue;

            db.prepare('UPDATE approval_requests SET status = ?, reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP, approver_id = ? WHERE id = ?')
                .run(status, action === 'reject' ? (reject_reason || null) : null, req.userId, id);

            // Apply changes
            if (approval.type === 'leave' && approval.reference_id) {
                db.prepare(`UPDATE leaves SET status = ?, approved_by = ?, reviewed_at = CURRENT_TIMESTAMP, reject_reason = ? WHERE id = ?`)
                    .run(status, req.userId, action === 'reject' ? (reject_reason || null) : null, approval.reference_id);
            }

            processed++;
        }
    });

    tx();
    logAction(req, `bulk_${action}`, 'approval_request', null, { ids, count: processed });
    res.json({ message: `${processed} request(s) ${status}`, processed });
});

// ==================== TEAM MEMBER DETAILS ====================

// View a specific team member's hours for a date range
router.get('/member/:userId/hours', (req, res) => {
    const targetUserId = Number(req.params.userId);
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);

    if (!visibleIds.includes(targetUserId)) {
        return res.status(403).json({ error: 'Not authorized to view this user\'s data' });
    }

    const { from, to } = req.query;
    const today = getLocalToday(req);
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);
    const toDate = to || today;
    const tzMod = getTzModifier(req);

    const entries = db.prepare(`
        SELECT * FROM time_entries
        WHERE user_id = ? AND date(timestamp, ?) BETWEEN date(?) AND date(?)
        ORDER BY timestamp ASC
    `).all(targetUserId, tzMod, fromDate, toDate);

    const grouped = {};
    entries.forEach(e => {
        const date = getLocalDateFromTs(e.timestamp, req);
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });

    const dailySummaries = Object.keys(grouped).sort().map(date => {
        const dayEntries = grouped[date];
        const floorMs = computeFloorMs(dayEntries);
        const breakMs = computeBreakMs(dayEntries);
        const clockIn = dayEntries.find(e => e.entry_type === 'clock_in');
        return {
            date,
            floorMinutes: Math.round(floorMs / 60000),
            breakMinutes: Math.round(breakMs / 60000),
            workMode: clockIn?.work_mode || 'office',
        };
    });

    res.json(dailySummaries);
});

// View a team member's tasks
router.get('/member/:userId/tasks', (req, res) => {
    const targetUserId = Number(req.params.userId);
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);

    if (!visibleIds.includes(targetUserId)) {
        return res.status(403).json({ error: 'Not authorized to view this user\'s tasks' });
    }

    const { date } = req.query;
    const targetDate = date || getLocalToday(req);

    const tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY priority DESC, created_at ASC')
        .all(targetUserId, targetDate);

    res.json(tasks);
});

// ==================== HELPERS ====================

function computeFloorMs(entries) {
    let floorMs = 0, clockInTime = null;
    for (const e of entries) {
        const t = new Date(e.timestamp.replace(' ', 'T') + 'Z').getTime();
        switch (e.entry_type) {
            case 'clock_in': clockInTime = t; break;
            case 'break_start': if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; } break;
            case 'break_end': clockInTime = t; break;
            case 'clock_out':
                if (clockInTime) { floorMs += t - clockInTime; clockInTime = null; }
                break;
        }
    }
    return floorMs;
}

function computeBreakMs(entries) {
    let breakMs = 0, breakStartTime = null;
    for (const e of entries) {
        const t = new Date(e.timestamp.replace(' ', 'T') + 'Z').getTime();
        switch (e.entry_type) {
            case 'break_start': breakStartTime = t; break;
            case 'break_end': if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; } break;
            case 'clock_out': if (breakStartTime) { breakMs += t - breakStartTime; breakStartTime = null; } break;
        }
    }
    return breakMs;
}

module.exports = router;
