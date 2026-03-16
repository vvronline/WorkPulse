const express = require('express');
const { query, transaction } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, getVisibleUserIds, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { getLocalToday, getTzModifier, getLocalDateFromTs, getOffsetMin } = require('../utils/timezone');
const { computeFloorMs, computeBreakMs } = require('../utils/timeCalc');
const { updateLeaveBalance } = require('./leaves');
const { logger } = require('../utils/logger');
const { notifyByEmail } = require('../utils/mailer');
const { sendToUser } = require('../utils/ws');

const router = express.Router();
router.use(auth, loadUserContext);

router.use(async (req, res, next) => {
    // Require at least team_lead role (level 2) to access manager endpoints.
    // Having subordinates alone (manager_id pointing to this user) is not sufficient
    // without an actual team_lead+ role assignment.
    if (req.roleLevel >= 2) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
});

// ==================== TEAM ATTENDANCE ====================

router.get('/team-attendance', async (req, res) => {
    try {
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (visibleIds.length === 0) return res.json([]);

        const { date: queryDate } = req.query;
        const today = getLocalToday(req);
        const targetDate = queryDate || today;
        const isToday = targetDate === today;
        const tzMod = getTzModifier(req);

        const users = (await query(
            'SELECT id, full_name, avatar, role, team_id, department_id FROM users WHERE id = ANY($1) AND is_active = TRUE',
            [visibleIds]
        )).rows;

        const entries = (await query(
            `SELECT * FROM time_entries WHERE user_id = ANY($1) AND (timestamp + $2::interval)::date = $3::date ORDER BY timestamp ASC`,
            [visibleIds, tzMod, targetDate]
        )).rows;

        const leaves = (await query(
            `SELECT user_id, leave_type, status as leave_status FROM leaves WHERE user_id = ANY($1) AND date = $2`,
            [visibleIds, targetDate]
        )).rows;
        const leaveMap = {};
        leaves.forEach(l => { leaveMap[l.user_id] = l; });

        const tasks = (await query(
            `SELECT user_id, title, status FROM tasks WHERE user_id = ANY($1) AND date = $2 AND status IN ('in_progress', 'in_review') ORDER BY priority DESC`,
            [visibleIds, targetDate]
        )).rows;
        const taskMap = {};
        tasks.forEach(t => { if (!taskMap[t.user_id]) taskMap[t.user_id] = t; });

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

            let status = 'not_started';
            if (userLeave && userLeave.leave_status !== 'rejected') status = 'on_leave';
            else if (state === 'on_floor') status = 'working';
            else if (state === 'on_break') status = 'away';
            else if (ue.length > 0) status = 'not_started';

            const floorMinutes = Math.round(floorMs / 60000);
            return {
                id: u.id, full_name: u.full_name, avatar: u.avatar, role: u.role,
                status, state,
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
    } catch (err) {
        req.log.error({ err }, 'GET /team-attendance error');
        res.status(500).json({ error: 'Failed to fetch team attendance' });
    }
});

// ==================== TEAM ANALYTICS ====================

router.get('/team-analytics', async (req, res) => {
    try {
        const { days, from, to } = req.query;
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (visibleIds.length === 0) return res.json({ members: [], totalMembers: 0 });

        const offsetMin = getOffsetMin(req);
        const today = getLocalToday(req);
        let fromDate, toDate;
        if (from && to) {
            fromDate = from;
            toDate = to > today ? today : to;
        } else {
            const numDays = days === 'month' ? 30 : days === 'quarter' ? 90 : parseInt(days) || 7;
            fromDate = new Date(Date.now() - offsetMin * 60000 - numDays * 86400000).toISOString().slice(0, 10);
            toDate = today;
        }
        const numDays = Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000) + 1;
        const tzMod = getTzModifier(req);

        const entries = (await query(
            `SELECT * FROM time_entries WHERE user_id = ANY($1) AND (timestamp + $2::interval)::date BETWEEN $3::date AND $4::date ORDER BY timestamp ASC`,
            [visibleIds, tzMod, fromDate, toDate]
        )).rows;

        const byUser = {};
        entries.forEach(e => {
            if (!byUser[e.user_id]) byUser[e.user_id] = {};
            const dateStr = getLocalDateFromTs(e.timestamp, req);
            if (!byUser[e.user_id][dateStr]) byUser[e.user_id][dateStr] = [];
            byUser[e.user_id][dateStr].push(e);
        });

        const users = (await query(
            `SELECT u.id, u.full_name, u.email, u.avatar, u.role, u.department_id, u.team_id,
                    d.name as department_name, t.name as team_name
             FROM users u
             LEFT JOIN departments d ON d.id = u.department_id
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE u.id = ANY($1) AND u.is_active = TRUE`,
            [visibleIds]
        )).rows;

        const taskCounts = (await query(
            `SELECT user_id, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, COUNT(*) as total
             FROM tasks WHERE user_id = ANY($1) AND date BETWEEN $2 AND $3 GROUP BY user_id`,
            [visibleIds, fromDate, toDate]
        )).rows;
        const taskMap = {};
        taskCounts.forEach(t => { taskMap[t.user_id] = { done: parseInt(t.done || 0, 10), total: parseInt(t.total, 10) }; });

        const leaveCounts = (await query(
            `SELECT user_id, leave_type, COUNT(*) as count FROM leaves
             WHERE user_id = ANY($1) AND date BETWEEN $2 AND $3 AND status != 'rejected'
             GROUP BY user_id, leave_type`,
            [visibleIds, fromDate, toDate]
        )).rows;
        const leaveMap = {};
        leaveCounts.forEach(l => {
            if (!leaveMap[l.user_id]) leaveMap[l.user_id] = { total: 0, byType: {} };
            const cnt = parseInt(l.count, 10);
            leaveMap[l.user_id].total += cnt;
            leaveMap[l.user_id].byType[l.leave_type] = cnt;
        });

        const pendingCount = (await query(
            "SELECT COUNT(*) as count FROM approval_requests WHERE approver_id = $1 AND status = 'pending'",
            [req.userId]
        )).rows[0];

        const todayEntries = (await query(
            `SELECT * FROM time_entries WHERE user_id = ANY($1) AND (timestamp + $2::interval)::date = $3::date ORDER BY timestamp ASC`,
            [visibleIds, tzMod, toDate]
        )).rows;
        const todayByUser = {};
        todayEntries.forEach(e => {
            if (!todayByUser[e.user_id]) todayByUser[e.user_id] = [];
            todayByUser[e.user_id].push(e);
        });

        const todayLeaves = (await query(
            `SELECT user_id FROM leaves WHERE user_id = ANY($1) AND date = $2 AND status != 'rejected'`,
            [visibleIds, toDate]
        )).rows;
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
            const org = (await query('SELECT work_hours_per_day FROM organizations WHERE id = $1', [req.userOrgId])).rows[0];
            if (org?.work_hours_per_day) orgWhpd = org.work_hours_per_day;
        }
        const targetMinutes = orgWhpd * 60;
        const expectedHours = expectedWeekdays * orgWhpd;

        const trendDays = Math.min(numDays, 7);
        const trendDates = [];
        const toMs = new Date(toDate).getTime();
        for (let i = trendDays - 1; i >= 0; i--) {
            const d = new Date(toMs - i * 86400000);
            trendDates.push(d.toISOString().slice(0, 10));
        }

        const members = users.map(u => {
            const userDays = byUser[u.id] || {};
            let totalFloor = 0, totalBreak = 0, daysWorked = 0, targetMet = 0, earlyDays = 0, officeDays = 0, remoteDays = 0;

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
                const ci = dayEntries.find(e => e.entry_type === 'clock_in');
                if (ci) {
                    const utcMs = ci.timestamp instanceof Date ? ci.timestamp.getTime() : new Date(ci.timestamp.replace(' ', 'T') + 'Z').getTime();
                    const localDate = new Date(utcMs - offsetMin * 60000);
                    if (localDate.getUTCHours() < 10) earlyDays++;
                    if (ci.work_mode === 'remote') remoteDays++;
                    else officeDays++;
                }
            });

            const trend = trendDates.map(date => {
                const dayEntries = userDays[date];
                if (!dayEntries || !dayEntries.some(e => e.entry_type === 'clock_in')) return 0;
                return Math.round(computeFloorMs(dayEntries) / 60000);
            });

            const todayUe = todayByUser[u.id] || [];
            let todayStatus = 'absent', todayHoursMin = 0;
            if (todayLeaveSet.has(u.id)) {
                todayStatus = 'on_leave';
            } else if (todayUe.length > 0) {
                const last = todayUe[todayUe.length - 1];
                if (last.entry_type === 'clock_in' || last.entry_type === 'break_end') todayStatus = 'working';
                else if (last.entry_type === 'break_start') todayStatus = 'on_break';
                else todayStatus = 'left';
                todayHoursMin = Math.round(computeFloorMs(todayUe, true) / 60000);
            }

            let streak = 0;
            for (let i = 0; i <= numDays; i++) {
                const d = new Date(Date.now() - offsetMin * 60000 - i * 86400000);
                const dow = d.getUTCDay();
                if (dow === 0 || dow === 6) continue;
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
                id: u.id, full_name: u.full_name, email: u.email, avatar: u.avatar, role: u.role,
                department_name: u.department_name || null, team_name: u.team_name || null,
                hours, totalFloorMinutes: totalFloor,
                avgFloorMinutes: daysWorked > 0 ? Math.round(totalFloor / daysWorked) : 0,
                avgBreakMinutes: daysWorked > 0 ? Math.round(totalBreak / daysWorked) : 0,
                daysWorked, targetMetDays: targetMet,
                targetMetPercent: daysWorked > 0 ? Math.round((targetMet / daysWorked) * 100) : 0,
                punctualityPercent: daysWorked > 0 ? Math.round((earlyDays / daysWorked) * 100) : 0,
                officeDays, remoteDays,
                tasksDone: userTaskData.done, tasksTotal: userTaskData.total,
                taskCompletionRate: userTaskData.total > 0 ? Math.round((userTaskData.done / userTaskData.total) * 100) : 0,
                leaves: userLeaveData.total, leavesByType: userLeaveData.byType,
                todayStatus, todayHoursMin, trend, streak,
            };
        });

        members.sort((a, b) => b.hours - a.hours);
        const totalLeaves = members.reduce((s, m) => s + m.leaves, 0);
        const avgPunctuality = members.length > 0 ? Math.round(members.reduce((s, m) => s + m.punctualityPercent, 0) / members.length) : 0;
        const avgTargetMet = members.length > 0 ? Math.round(members.reduce((s, m) => s + m.targetMetPercent, 0) / members.length) : 0;

        res.json({
            totalMembers: members.length,
            avgHours: totalOrgDays > 0 ? Math.round((totalOrgFloor / totalOrgDays) / 6) / 10 : 0,
            avgBreakMinutes: totalOrgDays > 0 ? Math.round(totalOrgBreak / totalOrgDays) : 0,
            totalTasksDone, totalLeaves,
            pendingApprovals: parseInt(pendingCount?.count || 0, 10),
            expectedHours, expectedWeekdays, targetMinutes, avgPunctuality, avgTargetMet, trendDates, members,
        });
    } catch (err) {
        req.log.error({ err }, 'GET /team-analytics error');
        res.status(500).json({ error: 'Failed to fetch team analytics' });
    }
});

// ==================== APPROVALS ====================

router.get('/approvals', async (req, res) => {
    try {
        const { status, type } = req.query;
        const filterStatus = status || 'pending';

        const conditions = ['(ar.approver_id = $1 OR (ar.approver_id IS NULL AND ar.requester_id IN (SELECT id FROM users WHERE manager_id = $1)))'];
        const params = [req.userId];
        let pi = 2;

        if (filterStatus !== 'all') { conditions.push(`ar.status = $${pi++}`); params.push(filterStatus); }
        if (type) { conditions.push(`ar.type = $${pi++}`); params.push(type); }

        const approvals = (await query(`
            SELECT ar.*, u.full_name as requester_name, u.avatar as requester_avatar
            FROM approval_requests ar
            JOIN users u ON u.id = ar.requester_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY ar.created_at DESC LIMIT 200
        `, params)).rows;

        res.json(approvals.map(a => {
            let metadata = null;
            if (a.metadata) { try { metadata = JSON.parse(a.metadata); } catch { } }
            return { ...a, metadata };
        }));
    } catch (err) {
        req.log.error({ err }, 'GET /approvals error');
        res.status(500).json({ error: 'Failed to fetch approvals' });
    }
});

router.get('/my-requests', async (req, res) => {
    try {
        const { status } = req.query;
        const conditions = ['ar.requester_id = $1'];
        const params = [req.userId];
        let pi = 2;
        if (status && status !== 'all') { conditions.push(`ar.status = $${pi++}`); params.push(status); }

        const requests = (await query(`
            SELECT ar.*, u.full_name as approver_name
            FROM approval_requests ar
            LEFT JOIN users u ON u.id = ar.approver_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY ar.created_at DESC LIMIT 200
        `, params)).rows;

        res.json(requests.map(r => {
            let metadata = null;
            if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
            return { ...r, metadata };
        }));
    } catch (err) {
        req.log.error({ err }, 'GET /my-requests error');
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

router.post('/approvals/:id/approve', async (req, res) => {
    try {
        const { id } = req.params;

        const txResult = await transaction(async (client) => {
            const approval = (await client.query('SELECT * FROM approval_requests WHERE id = $1', [Number(id)])).rows[0];
            if (!approval) return { error: 'Request not found', status: 404 };
            const isDirectManager = (await client.query('SELECT 1 FROM users WHERE id = $1 AND manager_id = $2', [approval.requester_id, req.userId])).rows[0];
            if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
                return { error: 'Not authorized to approve this request', status: 403 };
            }
            if (approval.status !== 'pending') return { error: `Request already ${approval.status}`, status: 400 };

            await client.query("UPDATE approval_requests SET status = 'approved', reviewed_at = NOW(), approver_id = $1 WHERE id = $2", [req.userId, Number(id)]);

            if (approval.type === 'leave' && approval.reference_id) {
                await client.query("UPDATE leaves SET status = 'approved', approved_by = $1, reviewed_at = NOW() WHERE id = $2", [req.userId, approval.reference_id]);
                const leave = (await client.query('SELECT * FROM leaves WHERE id = $1', [approval.reference_id])).rows[0];
                if (leave) await updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'add', client);
            } else if (approval.type === 'leave_withdraw' && approval.reference_id) {
                const leave = (await client.query('SELECT * FROM leaves WHERE id = $1', [approval.reference_id])).rows[0];
                if (leave) {
                    let meta = {};
                    if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                    if (meta.previous_status === 'approved') {
                        await updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'subtract', client);
                    }
                    await client.query("DELETE FROM approval_requests WHERE type = 'leave' AND reference_id = $1 AND requester_id = $2", [approval.reference_id, approval.requester_id]);
                    await client.query('DELETE FROM leaves WHERE id = $1', [approval.reference_id]);
                }
            } else if (approval.type === 'manual_entry') {
                let metadata = {};
                if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
                if (metadata.date) {
                    // Use the requester's stored timezone, not the manager's header
                    const requesterRow = (await client.query('SELECT timezone_offset FROM users WHERE id = $1', [approval.requester_id])).rows[0];
                    const reqOffset = requesterRow?.timezone_offset || 0;
                    const tzMod = `${-reqOffset} minutes`;
                    await client.query(
                        `UPDATE time_entries SET approval_status = 'approved', approved_by = $1 WHERE user_id = $2 AND (timestamp + $3::interval)::date = $4::date AND is_manual = TRUE`,
                        [req.userId, approval.requester_id, tzMod, metadata.date]
                    );
                }
            } else if (approval.type === 'overtime') {
                // Credit comp-off leave balance for the overtime worked
                let meta = {};
                if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                if (meta.date && meta.hours) {
                    const compHours = parseFloat(meta.hours);
                    if (compHours > 0) {
                        const compDuration = compHours >= 6 ? 'full' : compHours >= 3 ? 'half' : 'quarter';
                        await updateLeaveBalance(approval.requester_id, 'comp_off', meta.date, compDuration, 'add', client);
                    }
                }
            }
            return { ok: true, type: approval.type, requesterId: approval.requester_id, referenceId: approval.reference_id, metadata: approval.metadata };
        });

        if (txResult.error) return res.status(txResult.status).json({ error: txResult.error });

        // Notify the requester about approval
        try {
            const requester = (await query('SELECT email, full_name FROM users WHERE id = $1', [txResult.requesterId])).rows[0];
            if (requester) {
                if (txResult.type === 'leave' || txResult.type === 'leave_withdraw') {
                    const leave = txResult.referenceId ? (await query('SELECT * FROM leaves WHERE id = $1', [txResult.referenceId])).rows[0] : null;
                    const leaveInfo = leave || { leave_type: 'leave', date: '' };
                    await query(
                        'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                        [txResult.requesterId, 'leave', 'Leave Approved \u2705', `Your ${leaveInfo.leave_type} leave on ${leaveInfo.date} has been approved.`]
                    );
                    notifyByEmail('leaveApproved', requester, leaveInfo);
                    sendToUser(txResult.requesterId, 'leave_update', { status: 'approved' });
                } else if (txResult.type === 'manual_entry') {
                    let meta = {};
                    if (txResult.metadata) { try { meta = JSON.parse(txResult.metadata); } catch { } }
                    const entryDate = meta.date || '';
                    await query(
                        'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                        [txResult.requesterId, 'approval', 'Manual Entry Approved \u2705', `Your manual time entry for ${entryDate} has been approved.`]
                    );
                    notifyByEmail('manualEntryApproved', requester, entryDate);
                    sendToUser(txResult.requesterId, 'approval_update', { status: 'approved', type: 'manual_entry' });
                } else if (txResult.type === 'overtime') {
                    let meta = {};
                    if (txResult.metadata) { try { meta = JSON.parse(txResult.metadata); } catch { } }
                    const overtimeDate = meta.date || '';
                    await query(
                        'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                        [txResult.requesterId, 'approval', 'Overtime Approved \u2705', `Your overtime request for ${overtimeDate} has been approved. Comp-off has been credited.`]
                    );
                    sendToUser(txResult.requesterId, 'approval_update', { status: 'approved', type: 'overtime' });
                }
            }
        } catch (notifErr) {
            req.log.error({ err: notifErr }, 'Approval notification error');
        }

        logAction(req, 'approve', 'approval_request', Number(id), { type: txResult.type });
        res.json({ message: 'Request approved' });
    } catch (err) {
        req.log.error({ err }, 'POST /approvals/:id/approve error');
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

router.post('/approvals/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const { reject_reason } = req.body;

        const txResult = await transaction(async (client) => {
            const approval = (await client.query('SELECT * FROM approval_requests WHERE id = $1', [Number(id)])).rows[0];
            if (!approval) return { error: 'Request not found', status: 404 };
            const isDirectManager = (await client.query('SELECT 1 FROM users WHERE id = $1 AND manager_id = $2', [approval.requester_id, req.userId])).rows[0];
            if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
                return { error: 'Not authorized to reject this request', status: 403 };
            }
            if (approval.status !== 'pending') return { error: `Request already ${approval.status}`, status: 400 };

            await client.query("UPDATE approval_requests SET status = 'rejected', reject_reason = $1, reviewed_at = NOW(), approver_id = $2 WHERE id = $3", [reject_reason || null, req.userId, Number(id)]);

            if (approval.type === 'leave' && approval.reference_id) {
                await client.query("UPDATE leaves SET status = 'rejected', reject_reason = $1, approved_by = $2, reviewed_at = NOW() WHERE id = $3", [reject_reason || null, req.userId, approval.reference_id]);
            } else if (approval.type === 'leave_withdraw' && approval.reference_id) {
                let meta = {};
                if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                await client.query('UPDATE leaves SET status = $1 WHERE id = $2', [meta.previous_status || 'approved', approval.reference_id]);
            } else if (approval.type === 'manual_entry') {
                let metadata = {};
                if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
                if (metadata.date) {
                    // Use the requester's stored timezone, not the manager's header
                    const requesterRow = (await client.query('SELECT timezone_offset FROM users WHERE id = $1', [approval.requester_id])).rows[0];
                    const reqOffset = requesterRow?.timezone_offset || 0;
                    const tzMod = `${-reqOffset} minutes`;
                    await client.query(
                        `UPDATE time_entries SET approval_status = 'rejected', approved_by = $1 WHERE user_id = $2 AND (timestamp + $3::interval)::date = $4::date AND is_manual = TRUE`,
                        [req.userId, approval.requester_id, tzMod, metadata.date]
                    );
                }
            }
            return { ok: true, type: approval.type, requesterId: approval.requester_id, referenceId: approval.reference_id, metadata: approval.metadata };
        });

        if (txResult.error) return res.status(txResult.status).json({ error: txResult.error });

        // Notify the requester about rejection
        try {
            const requester = (await query('SELECT email, full_name FROM users WHERE id = $1', [txResult.requesterId])).rows[0];
            if (requester) {
                if (txResult.type === 'leave') {
                    const leave = txResult.referenceId ? (await query('SELECT * FROM leaves WHERE id = $1', [txResult.referenceId])).rows[0] : null;
                    const leaveInfo = leave || { leave_type: 'leave', date: '' };
                    await query(
                        'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                        [txResult.requesterId, 'leave', 'Leave Rejected', `Your ${leaveInfo.leave_type} leave on ${leaveInfo.date} has been rejected.${reject_reason ? ' Reason: ' + reject_reason : ''}`]
                    );
                    notifyByEmail('leaveRejected', requester, leaveInfo, reject_reason);
                    sendToUser(txResult.requesterId, 'leave_update', { status: 'rejected' });
                } else if (txResult.type === 'manual_entry') {
                    let meta = {};
                    if (txResult.metadata) { try { meta = JSON.parse(txResult.metadata); } catch { } }
                    const entryDate = meta.date || '';
                    await query(
                        'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
                        [txResult.requesterId, 'approval', 'Manual Entry Rejected', `Your manual time entry for ${entryDate} has been rejected.${reject_reason ? ' Reason: ' + reject_reason : ''}`]
                    );
                    notifyByEmail('manualEntryRejected', requester, entryDate, reject_reason);
                    sendToUser(txResult.requesterId, 'approval_update', { status: 'rejected', type: 'manual_entry' });
                }
            }
        } catch (notifErr) {
            req.log.error({ err: notifErr }, 'Rejection notification error');
        }

        logAction(req, 'reject', 'approval_request', Number(id), { type: txResult.type, reject_reason });
        res.json({ message: 'Request rejected' });
    } catch (err) {
        req.log.error({ err }, 'POST /approvals/:id/reject error');
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

router.post('/approvals/bulk', async (req, res) => {
    try {
        const { ids, action, reject_reason } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'IDs array is required' });
        if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 requests per bulk action' });
        if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: "Action must be 'approve' or 'reject'" });

        const status = action === 'approve' ? 'approved' : 'rejected';
        let processed = 0, skipped = 0;

        await transaction(async (client) => {
            for (const id of ids) {
                const approval = (await client.query("SELECT * FROM approval_requests WHERE id = $1 AND status = 'pending'", [id])).rows[0];
                if (!approval) continue;

                const isDirectManager = (await client.query('SELECT 1 FROM users WHERE id = $1 AND manager_id = $2', [approval.requester_id, req.userId])).rows[0];
                if (approval.approver_id !== req.userId && req.roleLevel < 4 && !isDirectManager) {
                    skipped++;
                    continue;
                }

                await client.query(
                    'UPDATE approval_requests SET status = $1, reject_reason = $2, reviewed_at = NOW(), approver_id = $3 WHERE id = $4',
                    [status, action === 'reject' ? (reject_reason || null) : null, req.userId, id]
                );

                if (approval.type === 'leave' && approval.reference_id) {
                    await client.query('UPDATE leaves SET status = $1, approved_by = $2, reviewed_at = NOW(), reject_reason = $3 WHERE id = $4',
                        [status, req.userId, action === 'reject' ? (reject_reason || null) : null, approval.reference_id]);
                    if (action === 'approve') {
                        const leave = (await client.query('SELECT * FROM leaves WHERE id = $1', [approval.reference_id])).rows[0];
                        if (leave) await updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'add', client);
                    }
                } else if (approval.type === 'leave_withdraw' && approval.reference_id) {
                    if (action === 'approve') {
                        const leave = (await client.query('SELECT * FROM leaves WHERE id = $1', [approval.reference_id])).rows[0];
                        if (leave) {
                            let meta = {};
                            if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                            if (meta.previous_status === 'approved') {
                                await updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'subtract', client);
                            }
                            await client.query("DELETE FROM approval_requests WHERE type = 'leave' AND reference_id = $1 AND requester_id = $2", [approval.reference_id, approval.requester_id]);
                            await client.query('DELETE FROM leaves WHERE id = $1', [approval.reference_id]);
                        }
                    } else {
                        let meta = {};
                        if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                        await client.query('UPDATE leaves SET status = $1 WHERE id = $2', [meta.previous_status || 'approved', approval.reference_id]);
                    }
                } else if (approval.type === 'manual_entry') {
                    let metadata = {};
                    if (approval.metadata) { try { metadata = JSON.parse(approval.metadata); } catch { } }
                    if (metadata.date) {
                        const tzMod = getTzModifier(req);
                        await client.query(
                            `UPDATE time_entries SET approval_status = $1, approved_by = $2 WHERE user_id = $3 AND (timestamp + $4::interval)::date = $5::date AND is_manual = TRUE`,
                            [action === 'approve' ? 'approved' : 'rejected', req.userId, approval.requester_id, tzMod, metadata.date]
                        );
                    }
                } else if (approval.type === 'overtime' && action === 'approve') {
                    // Credit comp-off leave balance for overtime
                    let meta = {};
                    if (approval.metadata) { try { meta = JSON.parse(approval.metadata); } catch { } }
                    if (meta.date && meta.hours) {
                        const compHours = parseFloat(meta.hours);
                        if (compHours > 0) {
                            const compDuration = compHours >= 6 ? 'full' : compHours >= 3 ? 'half' : 'quarter';
                            await updateLeaveBalance(approval.requester_id, 'comp_off', meta.date, compDuration, 'add', client);
                        }
                    }
                }
                processed++;
            }
        });

        logAction(req, `bulk_${action}`, 'approval_request', null, { ids, count: processed, skipped });
        res.json({ message: `${processed} request(s) ${status}${skipped > 0 ? `, ${skipped} skipped (not authorized)` : ''}`, processed, skipped });
    } catch (err) {
        req.log.error({ err }, 'POST /approvals/bulk error');
        res.status(500).json({ error: 'Failed to process bulk action' });
    }
});

// ==================== TEAM MEMBER DETAILS ====================

router.get('/member/:userId/hours', async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (!visibleIds.includes(targetUserId)) return res.status(403).json({ error: 'Not authorized to view this user\'s data' });

        const { from, to } = req.query;
        const today = getLocalToday(req);
        const offsetMin = getOffsetMin(req);
        const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);
        const toDate = to || today;
        const tzMod = getTzModifier(req);

        const entries = (await query(
            `SELECT * FROM time_entries WHERE user_id = $1 AND (timestamp + $2::interval)::date BETWEEN $3::date AND $4::date ORDER BY timestamp ASC`,
            [targetUserId, tzMod, fromDate, toDate]
        )).rows;

        const grouped = {};
        entries.forEach(e => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const dailySummaries = Object.keys(grouped).sort().map(date => {
            const dayEntries = grouped[date];
            const clockIn = dayEntries.find(e => e.entry_type === 'clock_in');
            return {
                date,
                floorMinutes: Math.round(computeFloorMs(dayEntries) / 60000),
                breakMinutes: Math.round(computeBreakMs(dayEntries) / 60000),
                workMode: clockIn?.work_mode || 'office',
            };
        });

        res.json(dailySummaries);
    } catch (err) {
        req.log.error({ err }, 'GET /member/:userId/hours error');
        res.status(500).json({ error: 'Failed to fetch member hours' });
    }
});

router.get('/member/:userId/tasks', async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (!visibleIds.includes(targetUserId)) return res.status(403).json({ error: 'Not authorized to view this user\'s tasks' });

        const targetDate = req.query.date || getLocalToday(req);
        const tasks = (await query(
            'SELECT * FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND date = $2 ORDER BY priority DESC, created_at ASC',
            [targetUserId, targetDate]
        )).rows;

        res.json(tasks);
    } catch (err) {
        req.log.error({ err }, 'GET /member/:userId/tasks error');
        res.status(500).json({ error: 'Failed to fetch member tasks' });
    }
});

router.get('/member/:userId/leaves', async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (!visibleIds.includes(targetUserId)) return res.status(403).json({ error: 'Not authorized to view this user\'s data' });

        const { from, to } = req.query;
        const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
        const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 90 * 86400000).toISOString().slice(0, 10);
        const toDate = to || getLocalToday(req);

        const leaves = (await query(
            `SELECT l.*, u.full_name as approved_by_name FROM leaves l
             LEFT JOIN users u ON u.id = l.approved_by
             WHERE l.user_id = $1 AND l.date BETWEEN $2 AND $3 ORDER BY l.date DESC`,
            [targetUserId, fromDate, toDate]
        )).rows;

        res.json(leaves);
    } catch (err) {
        req.log.error({ err }, 'GET /member/:userId/leaves error');
        res.status(500).json({ error: 'Failed to fetch member leaves' });
    }
});

router.get('/member/:userId/requests', async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (!visibleIds.includes(targetUserId)) return res.status(403).json({ error: 'Not authorized to view this user\'s data' });

        const requests = (await query(
            `SELECT ar.*, u.full_name as approver_name FROM approval_requests ar
             LEFT JOIN users u ON u.id = ar.approver_id
             WHERE ar.requester_id = $1 ORDER BY ar.created_at DESC LIMIT 100`,
            [targetUserId]
        )).rows;

        res.json(requests.map(r => {
            let metadata = null;
            if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
            return { ...r, metadata };
        }));
    } catch (err) {
        req.log.error({ err }, 'GET /member/:userId/requests error');
        res.status(500).json({ error: 'Failed to fetch member requests' });
    }
});

router.get('/member/:userId/overview', async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const visibleIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (!visibleIds.includes(targetUserId)) return res.status(403).json({ error: 'Not authorized to view this user\'s data' });

        const user = (await query(
            `SELECT u.id, u.full_name, u.email, u.avatar, u.role, u.team_id, u.department_id, u.created_at,
                    d.name as department_name, t.name as team_name
             FROM users u
             LEFT JOIN departments d ON d.id = u.department_id
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE u.id = $1`,
            [targetUserId]
        )).rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const offsetMin = getOffsetMin(req);
        const monthStart = today.slice(0, 7) + '-01';
        const thirtyDaysAgo = new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);

        const todayEntries = (await query(
            `SELECT * FROM time_entries WHERE user_id = $1 AND (timestamp + $2::interval)::date = $3::date ORDER BY timestamp ASC`,
            [targetUserId, tzMod, today]
        )).rows;
        const todayFloorMs = computeFloorMs(todayEntries, true);
        const todayBreakMs = computeBreakMs(todayEntries, true);

        const pendingRequests = (await query(
            "SELECT COUNT(*) as count FROM approval_requests WHERE requester_id = $1 AND status = 'pending'",
            [targetUserId]
        )).rows[0];

        const monthLeaves = (await query(
            "SELECT COUNT(*) as count FROM leaves WHERE user_id = $1 AND date >= $2 AND date <= $3 AND status != 'rejected'",
            [targetUserId, monthStart, today]
        )).rows[0];

        const todayTasks = (await query(
            'SELECT * FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND date = $2 ORDER BY priority DESC, created_at ASC',
            [targetUserId, today]
        )).rows;

        const recentLeaves = (await query(
            'SELECT * FROM leaves WHERE user_id = $1 AND date >= $2 ORDER BY date DESC LIMIT 10',
            [targetUserId, thirtyDaysAgo]
        )).rows;

        const recentRequestsRows = (await query(
            `SELECT ar.*, u.full_name as approver_name FROM approval_requests ar
             LEFT JOIN users u ON u.id = ar.approver_id
             WHERE ar.requester_id = $1 ORDER BY ar.created_at DESC LIMIT 10`,
            [targetUserId]
        )).rows;

        const trendStart = new Date(Date.now() - offsetMin * 60000 - 6 * 86400000);
        const trendStartStr = `${trendStart.getUTCFullYear()}-${String(trendStart.getUTCMonth() + 1).padStart(2, '0')}-${String(trendStart.getUTCDate()).padStart(2, '0')}`;
        const trendEntries = (await query(
            `SELECT * FROM time_entries WHERE user_id = $1 AND (timestamp + $2::interval)::date BETWEEN $3::date AND $4::date ORDER BY timestamp ASC`,
            [targetUserId, tzMod, trendStartStr, today]
        )).rows;
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
            weeklyTrend.push({
                date: dateStr,
                dayLabel: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
                floorMinutes: dayEntries.length > 0 ? Math.round(computeFloorMs(dayEntries) / 60000) : 0,
                breakMinutes: dayEntries.length > 0 ? Math.round(computeBreakMs(dayEntries) / 60000) : 0,
                workMode: dayEntries.find(e => e.entry_type === 'clock_in')?.work_mode || null,
            });
        }

        const last30Entries = (await query(
            `SELECT * FROM time_entries WHERE user_id = $1 AND (timestamp + $2::interval)::date BETWEEN $3::date AND $4::date ORDER BY timestamp ASC`,
            [targetUserId, tzMod, thirtyDaysAgo, today]
        )).rows;
        const grouped30 = {};
        last30Entries.forEach(e => {
            const dateStr = getLocalDateFromTs(e.timestamp, req);
            if (!grouped30[dateStr]) grouped30[dateStr] = [];
            grouped30[dateStr].push(e);
        });
        let total30Floor = 0, total30Break = 0, days30Worked = 0, targetMet30 = 0, early30 = 0;
        let orgWhpd = 8;
        if (req.userOrgId) {
            const org = (await query('SELECT work_hours_per_day FROM organizations WHERE id = $1', [req.userOrgId])).rows[0];
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
                const utcMs = ci.timestamp instanceof Date ? ci.timestamp.getTime() : new Date(ci.timestamp.replace(' ', 'T') + 'Z').getTime();
                const localDate = new Date(utcMs - offsetMin * 60000);
                if (localDate.getUTCHours() < 10) early30++;
            }
        });

        const monthTaskStats = (await query(
            `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
                    SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
             FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND date >= $2 AND date <= $3`,
            [targetUserId, monthStart, today]
        )).rows[0];

        const year = parseInt(today.slice(0, 4));
        let leaveBalances = [];
        try {
            leaveBalances = (await query(
                `SELECT lb.leave_type, lb.quota, lb.carried_forward, lb.used,
                        lp.annual_quota, lp.half_day_allowed, lp.quarter_day_allowed
                 FROM leave_balances lb
                 LEFT JOIN users u2 ON u2.id = lb.user_id
                 LEFT JOIN leave_policies lp ON lp.org_id = u2.org_id AND lp.leave_type = lb.leave_type
                 WHERE lb.user_id = $1 AND lb.year = $2`,
                [targetUserId, year]
            )).rows;
        } catch { /* leave_balances might not exist */ }

        const total = parseInt(monthTaskStats?.total || 0, 10);
        const done = parseInt(monthTaskStats?.done || 0, 10);
        const inProgress = parseInt(monthTaskStats?.in_progress || 0, 10);

        res.json({
            user,
            todayHours: Math.round(todayFloorMs / 60000 / 6) / 10,
            todayBreakMin: Math.round(todayBreakMs / 60000),
            todayTasks,
            pendingRequests: parseInt(pendingRequests?.count || 0, 10),
            monthLeaves: parseInt(monthLeaves?.count || 0, 10),
            recentLeaves,
            recentRequests: recentRequestsRows.map(r => {
                let metadata = null;
                if (r.metadata) { try { metadata = JSON.parse(r.metadata); } catch { } }
                return { ...r, metadata };
            }),
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
                total, done, inProgress,
                completionRate: total > 0 ? Math.round((done / total) * 100) : 0,
            },
            leaveBalances,
        });
    } catch (err) {
        req.log.error({ err }, 'GET /member/:userId/overview error');
        res.status(500).json({ error: 'Failed to fetch member overview' });
    }
});

module.exports = router;