/**
 * Manager Dashboard routes — team oversight, approvals, team analytics.
 * Requires team_lead+ role.
 */
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, getVisibleUserIds, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { getLocalToday, getTzModifier, getLocalDateFromTs, getOffsetMin } = require('../utils/timezone');
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
    const { days, from, to } = req.query;
    const visibleIds = getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
    if (visibleIds.length === 0) return res.json({ members: [], totalMembers: 0 });

    const offsetMin = getOffsetMin(req);
    const today = getLocalToday(req);
    let fromDate, toDate;
    if (from && to) {
        // Custom date range
        fromDate = from;
        toDate = to > today ? today : to;
    } else {
        const numDays = days === 'month' ? 30 : days === 'quarter' ? 90 : parseInt(days) || 7;
        fromDate = new Date(Date.now() - offsetMin * 60000 - numDays * 86400000).toISOString().slice(0, 10);
        toDate = today;
    }
    // Compute numDays from the resolved range
    const numDays = Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000) + 1;
    const tzMod = getTzModifier(req);
    const placeholders = visibleIds.map(() => '?').join(',');

    const entries = db.prepare(`
        SELECT * FROM time_entries
        WHERE user_id IN (${placeholders}) AND date(timestamp, ?) BETWEEN date(?) AND date(?)
        ORDER BY timestamp ASC
    `).all(...visibleIds, tzMod, fromDate, toDate);

    // Group by user then by date
    const byUser = {};
    entries.forEach(e => {
        if (!byUser[e.user_id]) byUser[e.user_id] = {};
        const dateStr = getLocalDateFromTs(e.timestamp, req);
        if (!byUser[e.user_id][dateStr]) byUser[e.user_id][dateStr] = [];
        byUser[e.user_id][dateStr].push(e);
    });

    // Get full user details including department & team
    const users = db.prepare(`
        SELECT u.id, u.full_name, u.email, u.avatar, u.role,
               u.department_id, u.team_id,
               d.name as department_name, t.name as team_name
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        WHERE u.id IN (${placeholders}) AND u.is_active = 1
    `).all(...visibleIds);

    // Get task counts per user (done + total)
    const taskCounts = db.prepare(`
        SELECT user_id,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
            COUNT(*) as total
        FROM tasks
        WHERE user_id IN (${placeholders}) AND date BETWEEN ? AND ?
        GROUP BY user_id
    `).all(...visibleIds, fromDate, toDate);
    const taskMap = {};
    taskCounts.forEach(t => { taskMap[t.user_id] = { done: t.done, total: t.total }; });

    // Get leave counts per user (split by type)
    const leaveCounts = db.prepare(`
        SELECT user_id, leave_type, COUNT(*) as count FROM leaves
        WHERE user_id IN (${placeholders}) AND date BETWEEN ? AND ? AND status != 'rejected'
        GROUP BY user_id, leave_type
    `).all(...visibleIds, fromDate, toDate);
    const leaveMap = {};
    leaveCounts.forEach(l => {
        if (!leaveMap[l.user_id]) leaveMap[l.user_id] = { total: 0, byType: {} };
        leaveMap[l.user_id].total += l.count;
        leaveMap[l.user_id].byType[l.leave_type] = l.count;
    });

    // Get pending approvals count
    const pendingCount = db.prepare(`
        SELECT COUNT(*) as count FROM approval_requests
        WHERE approver_id = ? AND status = 'pending'
    `).get(req.userId);

    // Get today's status for each user
    const todayEntries = db.prepare(`
        SELECT * FROM time_entries
        WHERE user_id IN (${placeholders}) AND date(timestamp, ?) = date(?)
        ORDER BY timestamp ASC
    `).all(...visibleIds, tzMod, toDate);
    const todayByUser = {};
    todayEntries.forEach(e => {
        if (!todayByUser[e.user_id]) todayByUser[e.user_id] = [];
        todayByUser[e.user_id].push(e);
    });

    // Get today's leaves
    const todayLeaves = db.prepare(`SELECT user_id FROM leaves WHERE user_id IN (${placeholders}) AND date = ? AND status != 'rejected'`).all(...visibleIds, toDate);
    const todayLeaveSet = new Set(todayLeaves.map(l => l.user_id));

    let totalOrgFloor = 0, totalOrgDays = 0, totalTasksDone = 0, totalOrgBreak = 0;
    let expectedWeekdays = 0;
    const fromMs = new Date(fromDate).getTime();
    for (let i = 0; i < numDays; i++) {
        const d = new Date(fromMs + i * 86400000);
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) expectedWeekdays++;
    }
    let orgWhpd = 8;
    if (req.userOrgId) {
        const org = db.prepare('SELECT work_hours_per_day FROM organizations WHERE id = ?').get(req.userOrgId);
        if (org?.work_hours_per_day) orgWhpd = org.work_hours_per_day;
    }
    const targetMinutes = orgWhpd * 60;
    const expectedHours = expectedWeekdays * orgWhpd;

    // Build last 7 or fewer date keys for the daily trend
    const trendDays = Math.min(numDays, 7);
    const trendDates = [];
    const toMs = new Date(toDate).getTime();
    for (let i = trendDays - 1; i >= 0; i--) {
        const d = new Date(toMs - i * 86400000);
        trendDates.push(d.toISOString().slice(0, 10));
    }

    const members = users.map(u => {
        const userDays = byUser[u.id] || {};
        let totalFloor = 0, totalBreak = 0, daysWorked = 0, targetMet = 0;
        let earlyDays = 0;
        let officeDays = 0, remoteDays = 0;
        const dailyFloor = []; // for daily trend

        // Compute per-day metrics
        const sortedDates = Object.keys(userDays).sort();
        sortedDates.forEach(date => {
            const dayEntries = userDays[date];
            if (!dayEntries.some(e => e.entry_type === 'clock_in')) return;
            daysWorked++;
            const floorMs = computeFloorMs(dayEntries);
            const breakMs = computeBreakMs(dayEntries);
            const floorMin = Math.round(floorMs / 60000);
            const breakMin = Math.round(breakMs / 60000);
            totalFloor += floorMin;
            totalBreak += breakMin;
            if (floorMin >= targetMinutes) targetMet++;

            // Punctuality: clock-in before 10:00 local
            const ci = dayEntries.find(e => e.entry_type === 'clock_in');
            if (ci) {
                const utcMs = new Date(ci.timestamp.replace(' ', 'T') + 'Z').getTime();
                const localDate = new Date(utcMs - offsetMin * 60000);
                const h = localDate.getUTCHours();
                if (h < 10) earlyDays++;
                if (ci.work_mode === 'remote') remoteDays++;
                else officeDays++;
            }
        });

        // Build trend array for last N days
        const trend = trendDates.map(date => {
            const dayEntries = userDays[date];
            if (!dayEntries || !dayEntries.some(e => e.entry_type === 'clock_in')) return 0;
            return Math.round(computeFloorMs(dayEntries) / 60000);
        });

        // Today's status
        const todayUe = todayByUser[u.id] || [];
        let todayStatus = 'absent';
        let todayHoursMin = 0;
        if (todayLeaveSet.has(u.id)) {
            todayStatus = 'on_leave';
        } else if (todayUe.length > 0) {
            const last = todayUe[todayUe.length - 1];
            if (last.entry_type === 'clock_in' || last.entry_type === 'break_end') todayStatus = 'working';
            else if (last.entry_type === 'break_start') todayStatus = 'on_break';
            else todayStatus = 'left';
            todayHoursMin = Math.round(computeFloorMs(todayUe, true) / 60000);
        }

        // Current streak: consecutive working days ending today or yesterday
        let streak = 0;
        for (let i = 0; i <= numDays; i++) {
            const d = new Date(Date.now() - offsetMin * 60000 - i * 86400000);
            const dow = d.getUTCDay();
            if (dow === 0 || dow === 6) continue; // skip weekends
            const dateStr = d.toISOString().slice(0, 10);
            if (userDays[dateStr] && userDays[dateStr].some(e => e.entry_type === 'clock_in')) streak++;
            else break;
        }

        const hours = Math.round(totalFloor / 6) / 10;
        const userTaskData = taskMap[u.id] || { done: 0, total: 0 };
        const userLeaveData = leaveMap[u.id] || { total: 0, byType: {} };
        totalOrgFloor += totalFloor;
        totalOrgBreak += totalBreak;
        totalOrgDays += daysWorked;
        totalTasksDone += userTaskData.done;

        return {
            id: u.id,
            full_name: u.full_name,
            email: u.email,
            avatar: u.avatar,
            role: u.role,
            department_name: u.department_name || null,
            team_name: u.team_name || null,
            // Time metrics
            hours,
            totalFloorMinutes: totalFloor,
            avgFloorMinutes: daysWorked > 0 ? Math.round(totalFloor / daysWorked) : 0,
            avgBreakMinutes: daysWorked > 0 ? Math.round(totalBreak / daysWorked) : 0,
            daysWorked,
            targetMetDays: targetMet,
            targetMetPercent: daysWorked > 0 ? Math.round((targetMet / daysWorked) * 100) : 0,
            // Punctuality & mode
            punctualityPercent: daysWorked > 0 ? Math.round((earlyDays / daysWorked) * 100) : 0,
            officeDays,
            remoteDays,
            // Tasks
            tasksDone: userTaskData.done,
            tasksTotal: userTaskData.total,
            taskCompletionRate: userTaskData.total > 0 ? Math.round((userTaskData.done / userTaskData.total) * 100) : 0,
            // Leaves
            leaves: userLeaveData.total,
            leavesByType: userLeaveData.byType,
            // Today's status
            todayStatus,
            todayHoursMin,
            // Trend & streak
            trend,
            streak,
        };
    });

    // Sort by hours descending by default
    members.sort((a, b) => b.hours - a.hours);

    // Team-level aggregates
    const totalLeaves = members.reduce((s, m) => s + m.leaves, 0);
    const avgPunctuality = members.length > 0 ? Math.round(members.reduce((s, m) => s + m.punctualityPercent, 0) / members.length) : 0;
    const avgTargetMet = members.length > 0 ? Math.round(members.reduce((s, m) => s + m.targetMetPercent, 0) / members.length) : 0;

    res.json({
        totalMembers: members.length,
        avgHours: totalOrgDays > 0 ? Math.round((totalOrgFloor / totalOrgDays) / 6) / 10 : 0,
        avgBreakMinutes: totalOrgDays > 0 ? Math.round(totalOrgBreak / totalOrgDays) : 0,
        totalTasksDone,
        totalLeaves,
        pendingApprovals: pendingCount?.count || 0,
        expectedHours,
        expectedWeekdays,
        targetMinutes,
        avgPunctuality,
        avgTargetMet,
        trendDates,
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

    const txResult = db.transaction(() => {
        const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(id));
        if (!approval) return { error: 'Request not found', status: 404 };
        // Authorized if: explicit approver, HR admin+, or the requester's direct manager
        const isDirectManager = db.prepare('SELECT 1 FROM users WHERE id = ? AND manager_id = ?').get(approval.requester_id, req.userId);
        if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
            return { error: 'Not authorized to approve this request', status: 403 };
        }
        if (approval.status !== 'pending') {
            return { error: `Request already ${approval.status}`, status: 400 };
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
        } else if (approval.type === 'leave_withdraw' && approval.reference_id) {
            // Manager approved the withdrawal — delete the leave
            const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(approval.reference_id);
            if (leave) {
                let meta = {};
                if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                // Restore balance if the leave was previously approved
                if (meta.previous_status === 'approved') {
                    updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'subtract');
                }
                // Delete the original leave approval request
                db.prepare("DELETE FROM approval_requests WHERE type = 'leave' AND reference_id = ? AND requester_id = ?")
                    .run(approval.reference_id, approval.requester_id);
                // Delete the leave itself
                db.prepare('DELETE FROM leaves WHERE id = ?').run(approval.reference_id);
            }
        } else if (approval.type === 'manual_entry') {
            // Mark the time entries as approved by request reference
            let metadata = {};
            if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
            if (metadata.date) {
                const tzMod = getTzModifier(req);
                db.prepare(`
                    UPDATE time_entries SET approval_status = 'approved', approved_by = ?
                    WHERE user_id = ? AND date(timestamp, ?) = date(?) AND is_manual = 1
                `).run(req.userId, approval.requester_id, tzMod, metadata.date);
            }
        }

        return { ok: true, type: approval.type };
    })();

    if (txResult.error) {
        return res.status(txResult.status).json({ error: txResult.error });
    }

    logAction(req, 'approve', 'approval_request', Number(id), { type: txResult.type });
    res.json({ message: 'Request approved' });
});

// Reject a request
router.post('/approvals/:id/reject', (req, res) => {
    const { id } = req.params;
    const { reject_reason } = req.body;

    const txResult = db.transaction(() => {
        const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(id));
        if (!approval) return { error: 'Request not found', status: 404 };
        const isDirectManager = db.prepare('SELECT 1 FROM users WHERE id = ? AND manager_id = ?').get(approval.requester_id, req.userId);
        if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
            return { error: 'Not authorized to reject this request', status: 403 };
        }
        if (approval.status !== 'pending') {
            return { error: `Request already ${approval.status}`, status: 400 };
        }

        db.prepare('UPDATE approval_requests SET status = ?, reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP, approver_id = ? WHERE id = ?')
            .run('rejected', reject_reason || null, req.userId, Number(id));

        if (approval.type === 'leave' && approval.reference_id) {
            db.prepare("UPDATE leaves SET status = 'rejected', reject_reason = ?, approved_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
                .run(reject_reason || null, req.userId, approval.reference_id);
        } else if (approval.type === 'leave_withdraw' && approval.reference_id) {
            // Manager rejected the withdrawal — revert leave to its previous status
            let meta = {};
            if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
            const revertStatus = meta.previous_status || 'approved';
            db.prepare('UPDATE leaves SET status = ? WHERE id = ?')
                .run(revertStatus, approval.reference_id);
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

        return { ok: true, type: approval.type };
    })();

    if (txResult.error) {
        return res.status(txResult.status).json({ error: txResult.error });
    }

    logAction(req, 'reject', 'approval_request', Number(id), { type: txResult.type, reject_reason });
    res.json({ message: 'Request rejected' });
});

// Bulk approve/reject
router.post('/approvals/bulk', (req, res) => {
    const { ids, action, reject_reason } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'IDs array is required' });
    }
    if (ids.length > 100) {
        return res.status(400).json({ error: 'Maximum 100 requests per bulk action' });
    }
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "Action must be 'approve' or 'reject'" });
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    let processed = 0;
    let skipped = 0;

    const tx = db.transaction(() => {
        for (const id of ids) {
            const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ? AND status = ?').get(id, 'pending');
            if (!approval) continue;

            // Authorization check: must be explicit approver, direct manager, or HR admin+
            const isDirectManager = db.prepare('SELECT 1 FROM users WHERE id = ? AND manager_id = ?').get(approval.requester_id, req.userId);
            if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
                skipped++;
                continue;
            }

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
            } else if (approval.type === 'leave_withdraw' && approval.reference_id) {
                if (action === 'approve') {
                    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(approval.reference_id);
                    if (leave) {
                        let meta = {};
                        if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                        if (meta.previous_status === 'approved') {
                            updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'subtract');
                        }
                        db.prepare("DELETE FROM approval_requests WHERE type = 'leave' AND reference_id = ? AND requester_id = ?")
                            .run(approval.reference_id, approval.requester_id);
                        db.prepare('DELETE FROM leaves WHERE id = ?').run(approval.reference_id);
                    }
                } else {
                    let meta = {};
                    if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                    db.prepare('UPDATE leaves SET status = ? WHERE id = ?')
                        .run(meta.previous_status || 'approved', approval.reference_id);
                }
            } else if (approval.type === 'manual_entry') {
                let metadata = {};
                if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
                if (metadata.date) {
                    const tzMod = getTzModifier(req);
                    const newStatus = action === 'approve' ? 'approved' : 'rejected';
                    db.prepare(`
                        UPDATE time_entries SET approval_status = ?, approved_by = ?
                        WHERE user_id = ? AND date(timestamp, ?) = date(?) AND is_manual = 1
                    `).run(newStatus, req.userId, approval.requester_id, tzMod, metadata.date);
                }
            }

            processed++;
        }
    });

    tx();
    logAction(req, `bulk_${action}`, 'approval_request', null, { ids, count: processed, skipped });
    res.json({ message: `${processed} request(s) ${status}${skipped > 0 ? `, ${skipped} skipped (not authorized)` : ''}`, processed, skipped });
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
    const offsetMin = getOffsetMin(req);
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

    const tasks = db.prepare('SELECT * FROM tasks WHERE (user_id = ? OR assigned_to = ?) AND date = ? ORDER BY priority DESC, created_at ASC')
        .all(targetUserId, targetUserId, targetDate);

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

    const user = db.prepare(`
        SELECT u.id, u.full_name, u.email, u.avatar, u.role, u.team_id, u.department_id, u.created_at,
               d.name as department_name, t.name as team_name
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        WHERE u.id = ?
    `).get(targetUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = getLocalToday(req);
    const tzMod = getTzModifier(req);
    const offsetMin = getOffsetMin(req);
    const monthStart = today.slice(0, 7) + '-01';
    const thirtyDaysAgo = new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);

    // Today's entries
    const todayEntries = db.prepare(`
        SELECT * FROM time_entries WHERE user_id = ? AND date(timestamp, ?) = date(?) ORDER BY timestamp ASC
    `).all(targetUserId, tzMod, today);

    const todayFloorMs = computeFloorMs(todayEntries, true);
    const todayBreakMs = computeBreakMs(todayEntries, true);

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
        SELECT * FROM tasks WHERE (user_id = ? OR assigned_to = ?) AND date = ? ORDER BY priority DESC, created_at ASC
    `).all(targetUserId, targetUserId, today);

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

    // --- ENHANCED DATA ---

    // Weekly trend (last 7 days floor time) — single batch query instead of N+1
    const trendStart = new Date(Date.now() - offsetMin * 60000 - 6 * 86400000);
    const trendStartStr = `${trendStart.getUTCFullYear()}-${String(trendStart.getUTCMonth() + 1).padStart(2, '0')}-${String(trendStart.getUTCDate()).padStart(2, '0')}`;
    const trendEntries = db.prepare(`
        SELECT * FROM time_entries WHERE user_id = ? AND date(timestamp, ?) BETWEEN date(?) AND date(?)
        ORDER BY timestamp ASC
    `).all(targetUserId, tzMod, trendStartStr, today);
    const trendGrouped = {};
    trendEntries.forEach(e => {
        const dateStr = getLocalDateFromTs(e.timestamp, req);
        if (!trendGrouped[dateStr]) trendGrouped[dateStr] = [];
        trendGrouped[dateStr].push(e);
    });
    const weeklyTrend = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - offsetMin * 60000 - i * 86400000);
        const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        const dayEntries = trendGrouped[dateStr] || [];
        const floorMin = dayEntries.length > 0 ? Math.round(computeFloorMs(dayEntries) / 60000) : 0;
        const breakMin = dayEntries.length > 0 ? Math.round(computeBreakMs(dayEntries) / 60000) : 0;
        const clockIn = dayEntries.find(e => e.entry_type === 'clock_in');
        weeklyTrend.push({
            date: dateStr,
            dayLabel: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
            floorMinutes: floorMin,
            breakMinutes: breakMin,
            workMode: clockIn?.work_mode || null,
        });
    }

    // 30-day stats
    const last30Entries = db.prepare(`
        SELECT * FROM time_entries WHERE user_id = ? AND date(timestamp, ?) BETWEEN date(?) AND date(?) ORDER BY timestamp ASC
    `).all(targetUserId, tzMod, thirtyDaysAgo, today);
    const grouped30 = {};
    last30Entries.forEach(e => {
        const dateStr = getLocalDateFromTs(e.timestamp, req);
        if (!grouped30[dateStr]) grouped30[dateStr] = [];
        grouped30[dateStr].push(e);
    });
    let total30Floor = 0, total30Break = 0, days30Worked = 0, targetMet30 = 0, early30 = 0;
    let orgWhpd = 8;
    if (req.userOrgId) {
        const org = db.prepare('SELECT work_hours_per_day FROM organizations WHERE id = ?').get(req.userOrgId);
        if (org?.work_hours_per_day) orgWhpd = org.work_hours_per_day;
    }
    const targetMin = orgWhpd * 60;
    Object.values(grouped30).forEach(dayEntries => {
        if (!dayEntries.some(e => e.entry_type === 'clock_in')) return;
        days30Worked++;
        const fMs = computeFloorMs(dayEntries);
        const bMs = computeBreakMs(dayEntries);
        total30Floor += Math.round(fMs / 60000);
        total30Break += Math.round(bMs / 60000);
        if (Math.round(fMs / 60000) >= targetMin) targetMet30++;
        const ci = dayEntries.find(e => e.entry_type === 'clock_in');
        if (ci) {
            const utcMs = new Date(ci.timestamp.replace(' ', 'T') + 'Z').getTime();
            const localDate = new Date(utcMs - offsetMin * 60000);
            if (localDate.getUTCHours() < 10) early30++;
        }
    });

    // Task stats (this month)
    const monthTaskStats = db.prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
        FROM tasks WHERE (user_id = ? OR assigned_to = ?) AND date >= ? AND date <= ?
    `).get(targetUserId, targetUserId, monthStart, today);

    // Leave balances (current year)
    const year = parseInt(today.slice(0, 4));
    let leaveBalances = [];
    try {
        leaveBalances = db.prepare(`
            SELECT lb.leave_type, lb.quota, lb.carried_forward, lb.used,
                   lp.annual_quota, lp.half_day_allowed, lp.quarter_day_allowed
            FROM leave_balances lb
            LEFT JOIN users u2 ON u2.id = lb.user_id
            LEFT JOIN leave_policies lp ON lp.org_id = u2.org_id AND lp.leave_type = lb.leave_type
            WHERE lb.user_id = ? AND lb.year = ?
        `).all(targetUserId, year);
    } catch { /* leave_balances might not exist */ }

    res.json({
        user,
        todayHours: Math.round(todayFloorMs / 60000 / 6) / 10,
        todayBreakMin: Math.round(todayBreakMs / 60000),
        todayTasks,
        pendingRequests: pendingRequests?.count || 0,
        monthLeaves: monthLeaves?.count || 0,
        recentLeaves,
        recentRequests: recentRequests.map(r => {
            let metadata = null;
            if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
            return { ...r, metadata };
        }),
        // Enhanced data
        weeklyTrend,
        stats30d: {
            daysWorked: days30Worked,
            totalFloorMinutes: total30Floor,
            avgFloorMinutes: days30Worked > 0 ? Math.round(total30Floor / days30Worked) : 0,
            avgBreakMinutes: days30Worked > 0 ? Math.round(total30Break / days30Worked) : 0,
            targetMetDays: targetMet30,
            targetMetPercent: days30Worked > 0 ? Math.round((targetMet30 / days30Worked) * 100) : 0,
            punctualityPercent: days30Worked > 0 ? Math.round((early30 / days30Worked) * 100) : 0,
        },
        monthTaskStats: {
            total: monthTaskStats?.total || 0,
            done: monthTaskStats?.done || 0,
            inProgress: monthTaskStats?.in_progress || 0,
            completionRate: monthTaskStats?.total > 0 ? Math.round((monthTaskStats.done / monthTaskStats.total) * 100) : 0,
        },
        leaveBalances,
    });
});

module.exports = router;
