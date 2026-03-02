/**
 * Manager Dashboard routes — team oversight, approvals, team analytics.
 * Requires team_lead+ role.
 */
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, getVisibleUserIds, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { getLocalToday, getTzModifier, getLocalDateFromTs } = require('../utils/timezone');
const { computeFloorMs, computeBreakMs } = require('../utils/timeCalc');
const { updateLeaveBalance } = require('./leaves');

const router = express.Router();

router.use(auth, loadUserContext);

// Allow access if: team_lead+ role, or has direct reports
router.use((req, res, next) => {
    if (req.roleLevel >= 2) return next(); // team_lead+
    const hasReports = db.prepare('SELECT 1 FROM users WHERE manager_id = ? AND is_active = 1 LIMIT 1').get(req.userId);
    if (hasReports) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
});

// ==================== TEAM ATTENDANCE ====================

// Real-time attendance status for all visible team members
router.get('/team-attendance', (req, res) => {
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
    if (visibleIds.length === 0) return res.json([]);

    const { date: queryDate } = req.query;
    const today = getLocalToday(req);
    const targetDate = queryDate || today;
    const isToday = targetDate === today;
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
    `).all(...visibleIds, tzMod, targetDate);

    // Get leaves for the target date
    const leaves = db.prepare(`
        SELECT user_id, leave_type, status as leave_status FROM leaves
        WHERE user_id IN (${placeholders}) AND date = ?
    `).all(...visibleIds, targetDate);
    const leaveMap = {};
    leaves.forEach(l => { leaveMap[l.user_id] = l; });

    // Get current tasks for the target date
    const tasks = db.prepare(`
        SELECT user_id, title, status FROM tasks
        WHERE user_id IN (${placeholders}) AND date = ? AND status IN ('in_progress', 'in_review')
        ORDER BY priority DESC
    `).all(...visibleIds, targetDate);
    const taskMap = {};
    tasks.forEach(t => { if (!taskMap[t.user_id]) taskMap[t.user_id] = t; });

    // Group entries by user
    const userEntries = {};
    entries.forEach(e => {
        if (!userEntries[e.user_id]) userEntries[e.user_id] = [];
        userEntries[e.user_id].push(e);
    });

    const result = users.map(u => {
        const ue = userEntries[u.id] || [];
        const userLeave = leaveMap[u.id];
        const currentTask = taskMap[u.id];
        let state = 'logged_out';

        const floorMs = computeFloorMs(ue, isToday);
        const breakMs = computeBreakMs(ue, isToday);
        const workMode = ue.find(e => e.entry_type === 'clock_in')?.work_mode || null;

        const last = ue[ue.length - 1];
        if (last) {
            if (last.entry_type === 'clock_in' || last.entry_type === 'break_end') state = 'on_floor';
            else if (last.entry_type === 'break_start') state = 'on_break';
            else state = 'logged_out';
        }

        // Map state to frontend-expected status
        let status = 'not_started';
        if (userLeave && userLeave.leave_status !== 'rejected') {
            status = 'on_leave';
        } else if (state === 'on_floor') {
            status = 'working';
        } else if (state === 'on_break') {
            status = 'away';
        } else if (ue.length > 0) {
            status = 'not_started'; // clocked out already
        }

        const floorMinutes = Math.round(floorMs / 60000);

        return {
            id: u.id,
            full_name: u.full_name,
            avatar: u.avatar,
            role: u.role,
            status,
            state,
            hours_today: Math.round(floorMinutes / 6) / 10,
            floorMinutes,
            breakMinutes: Math.round(breakMs / 60000),
            workMode: workMode || 'office',
            clockInTime: ue.find(e => e.entry_type === 'clock_in')?.timestamp || null,
            current_task: currentTask?.title || null,
            leave_type: userLeave?.leave_type || null,
        };
    });

    res.json(result);
});

// ==================== TEAM ANALYTICS ====================

router.get('/team-analytics', (req, res) => {
    const { days } = req.query;
    const numDays = days === 'month' ? 30 : days === 'quarter' ? 90 : parseInt(days) || 7;
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
    if (visibleIds.length === 0) return res.json({ members: [], totalMembers: 0 });

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
        SELECT id, full_name, avatar, role FROM users
        WHERE id IN (${placeholders}) AND is_active = 1
    `).all(...visibleIds);

    // Get task counts per user
    const taskCounts = db.prepare(`
        SELECT user_id, COUNT(*) as count FROM tasks
        WHERE user_id IN (${placeholders}) AND date BETWEEN ? AND ? AND status = 'done'
        GROUP BY user_id
    `).all(...visibleIds, fromDate, today);
    const taskMap = {};
    taskCounts.forEach(t => { taskMap[t.user_id] = t.count; });

    // Get leave counts per user
    const leaveCounts = db.prepare(`
        SELECT user_id, COUNT(*) as count FROM leaves
        WHERE user_id IN (${placeholders}) AND date BETWEEN ? AND ? AND status != 'rejected'
        GROUP BY user_id
    `).all(...visibleIds, fromDate, today);
    const leaveMap = {};
    leaveCounts.forEach(l => { leaveMap[l.user_id] = l.count; });

    // Get pending approvals count
    const pendingCount = db.prepare(`
        SELECT COUNT(*) as count FROM approval_requests
        WHERE approver_id = ? AND status = 'pending'
    `).get(req.userId);

    let totalOrgFloor = 0, totalOrgDays = 0, totalTasks = 0;
    // Expected hours = numDays weekdays * 8
    let expectedWeekdays = 0;
    for (let i = 0; i < numDays; i++) {
        const d = new Date(Date.now() - offsetMin * 60000 - (numDays - 1 - i) * 86400000);
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) expectedWeekdays++;
    }
    const expectedHours = expectedWeekdays * 8;

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

        const hours = Math.round(totalFloor / 6) / 10;
        const userTasks = taskMap[u.id] || 0;
        const userLeaves = leaveMap[u.id] || 0;
        totalOrgFloor += totalFloor;
        totalOrgDays += daysWorked;
        totalTasks += userTasks;

        return {
            id: u.id,
            full_name: u.full_name,
            avatar: u.avatar,
            role: u.role,
            hours,
            tasks: userTasks,
            leaves: userLeaves,
            daysWorked,
            avgFloorMinutes: daysWorked > 0 ? Math.round(totalFloor / daysWorked) : 0,
            targetMetDays: targetMet,
        };
    });

    res.json({
        totalMembers: members.length,
        avgHours: totalOrgDays > 0 ? Math.round((totalOrgFloor / totalOrgDays) / 6) / 10 : 0,
        totalTasks,
        pendingApprovals: pendingCount?.count || 0,
        expectedHours,
        members,
    });
});

// ==================== APPROVALS ====================

// Get pending approvals for the current user
router.get('/approvals', (req, res) => {
    const { status, type } = req.query;
    const filterStatus = status || 'pending';

    let where = ['(ar.approver_id = ? OR (ar.approver_id IS NULL AND ar.requester_id IN (SELECT id FROM users WHERE manager_id = ?)))'];
    let params = [req.userId, req.userId];

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

    // Parse metadata JSON (guarded)
    const parsed = approvals.map(a => {
        let metadata = null;
        if (a.metadata) { try { metadata = JSON.parse(a.metadata); } catch { } }
        return { ...a, metadata };
    });

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

    res.json(requests.map(r => {
        let metadata = null;
        if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
        return { ...r, metadata };
    }));
});

// Approve a request
router.post('/approvals/:id/approve', (req, res) => {
    const { id } = req.params;
    const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(id));
    if (!approval) return res.status(404).json({ error: 'Request not found' });
    // Authorized if: explicit approver, HR admin+, or the requester's direct manager
    const isDirectManager = db.prepare('SELECT 1 FROM users WHERE id = ? AND manager_id = ?').get(approval.requester_id, req.userId);
    if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
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
        // Update leave balance
        const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(approval.reference_id);
        if (leave) {
            updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'add');
        }
    } else if (approval.type === 'manual_entry') {
        // Mark the time entries as approved by request reference
        let metadata = {};
        if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
        if (metadata.date) {
            const tzMod = getTzModifier(req);
            // Prefer matching by approval request_id stored in entries, fallback to date
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
    const isDirectManager = db.prepare('SELECT 1 FROM users WHERE id = ? AND manager_id = ?').get(approval.requester_id, req.userId);
    if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
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
        let metadata = {};
        if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
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
                // Update leave balance when bulk-approving
                if (action === 'approve') {
                    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(approval.reference_id);
                    if (leave) {
                        updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'add');
                    }
                }
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

// View a team member's leaves
router.get('/member/:userId/leaves', (req, res) => {
    const targetUserId = Number(req.params.userId);
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);

    if (!visibleIds.includes(targetUserId)) {
        return res.status(403).json({ error: 'Not authorized to view this user\'s data' });
    }

    const { from, to } = req.query;
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 90 * 86400000).toISOString().slice(0, 10);
    const toDate = to || getLocalToday(req);

    const leaves = db.prepare(`
        SELECT l.*, u.full_name as approved_by_name
        FROM leaves l
        LEFT JOIN users u ON u.id = l.approved_by
        WHERE l.user_id = ? AND l.date BETWEEN ? AND ?
        ORDER BY l.date DESC
    `).all(targetUserId, fromDate, toDate);

    res.json(leaves);
});

// View a team member's approval requests
router.get('/member/:userId/requests', (req, res) => {
    const targetUserId = Number(req.params.userId);
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);

    if (!visibleIds.includes(targetUserId)) {
        return res.status(403).json({ error: 'Not authorized to view this user\'s data' });
    }

    const requests = db.prepare(`
        SELECT ar.*, u.full_name as approver_name
        FROM approval_requests ar
        LEFT JOIN users u ON u.id = ar.approver_id
        WHERE ar.requester_id = ?
        ORDER BY ar.created_at DESC
        LIMIT 100
    `).all(targetUserId);

    res.json(requests.map(r => {
        let metadata = null;
        if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
        return { ...r, metadata };
    }));
});

// View a team member's overview (summary dashboard data)
router.get('/member/:userId/overview', (req, res) => {
    const targetUserId = Number(req.params.userId);
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);

    if (!visibleIds.includes(targetUserId)) {
        return res.status(403).json({ error: 'Not authorized to view this user\'s data' });
    }

    const user = db.prepare('SELECT id, full_name, avatar, role, team_id, department_id FROM users WHERE id = ?').get(targetUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const monthStart = today.slice(0, 7) + '-01';
    const thirtyDaysAgo = new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);

    // Today's entries
    const todayEntries = db.prepare(`
        SELECT * FROM time_entries WHERE user_id = ? AND date(timestamp, ?) = date(?) ORDER BY timestamp ASC
    `).all(targetUserId, tzMod, today);

    const todayFloorMs = computeFloorMs(todayEntries, true);

    // Pending requests
    const pendingRequests = db.prepare(`
        SELECT COUNT(*) as count FROM approval_requests WHERE requester_id = ? AND status = 'pending'
    `).get(targetUserId);

    // Leaves this month
    const monthLeaves = db.prepare(`
        SELECT COUNT(*) as count FROM leaves WHERE user_id = ? AND date >= ? AND date <= ? AND status != 'rejected'
    `).get(targetUserId, monthStart, today);

    // Today's tasks
    const todayTasks = db.prepare(`
        SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY priority DESC, created_at ASC
    `).all(targetUserId, today);

    // Recent leaves
    const recentLeaves = db.prepare(`
        SELECT * FROM leaves WHERE user_id = ? AND date >= ? ORDER BY date DESC LIMIT 10
    `).all(targetUserId, thirtyDaysAgo);

    // Recent requests
    const recentRequests = db.prepare(`
        SELECT ar.*, u.full_name as approver_name
        FROM approval_requests ar
        LEFT JOIN users u ON u.id = ar.approver_id
        WHERE ar.requester_id = ?
        ORDER BY ar.created_at DESC LIMIT 10
    `).all(targetUserId);

    res.json({
        user,
        todayHours: Math.round(todayFloorMs / 60000 / 6) / 10,
        todayTasks,
        pendingRequests: pendingRequests?.count || 0,
        monthLeaves: monthLeaves?.count || 0,
        recentLeaves,
        recentRequests: recentRequests.map(r => {
            let metadata = null;
            if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
            return { ...r, metadata };
        }),
    });
});

module.exports = router;
