/**
 * Export endpoints — CSV & PDF for analytics, leaves, tasks, and team data.
 */
const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, getVisibleUserIds } = require('../middleware/rbac');
const { getOffsetMin } = require('../utils/timezone');
const { computeFloorMs, computeBreakMs } = require('../utils/timeCalc');
const { sendCSV, sendPDF } = require('../utils/export');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(auth, loadUserContext);

// ─── Personal Analytics Export ─────────────────────────────────────────
router.get('/my-analytics', async (req, res) => {
    try {
        const { from, to, format } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        const offsetMin = getOffsetMin(req);
        const intervalStr = `${-offsetMin} minutes`;
        const entries = (await query(`
            SELECT * FROM time_entries
            WHERE user_id = $1 AND approval_status = 'approved'
                AND (timestamp + $4::interval)::date BETWEEN $2::date AND $3::date
            ORDER BY timestamp ASC
        `, [req.userId, from, to, intervalStr])).rows;

        // Group by date
        const byDate = {};
        entries.forEach(e => {
            const d = new Date(e.timestamp).toISOString().slice(0, 10);
            if (!byDate[d]) byDate[d] = [];
            byDate[d].push(e);
        });

        const rows = Object.entries(byDate).map(([date, dayEntries]) => {
            const floorMs = computeFloorMs(dayEntries);
            const breakMs = computeBreakMs(dayEntries);
            const clockIn = dayEntries.find(e => e.entry_type === 'clock_in');
            return {
                date,
                work_mode: clockIn?.work_mode || 'N/A',
                floor_hours: (floorMs / 3600000).toFixed(2),
                break_hours: (breakMs / 3600000).toFixed(2),
                total_hours: ((floorMs + breakMs) / 3600000).toFixed(2),
                target_met: floorMs >= 8 * 3600000 ? 'Yes' : 'No',
            };
        });

        const fields = [
            { label: 'Date', value: 'date' },
            { label: 'Work Mode', value: 'work_mode' },
            { label: 'Floor Hours', value: 'floor_hours' },
            { label: 'Break Hours', value: 'break_hours' },
            { label: 'Total Hours', value: 'total_hours' },
            { label: 'Target Met', value: 'target_met' },
        ];

        if (format === 'pdf') {
            sendPDF(res, {
                title: `My Analytics (${from} to ${to})`,
                columns: fields.map(f => ({ header: f.label, key: f.value })),
                rows,
                filename: `analytics_${from}_${to}.pdf`,
            });
        } else {
            sendCSV(res, rows, fields, `analytics_${from}_${to}.csv`);
        }
    } catch (err) {
        req.log.error({ err }, 'Export my-analytics error');
        res.status(500).json({ error: 'Export failed' });
    }
});

// ─── Personal Leaves Export ─────────────────────────────────────────────
router.get('/my-leaves', async (req, res) => {
    try {
        const { year, format } = req.query;
        const targetYear = parseInt(year, 10) || new Date().getFullYear();

        const leaves = (await query(`
            SELECT l.date, l.leave_type, l.duration, l.status, l.reason, l.reject_reason,
                   u.full_name AS approved_by_name
            FROM leaves l
            LEFT JOIN users u ON u.id = l.approved_by
            WHERE l.user_id = $1 AND EXTRACT(YEAR FROM l.date::date) = $2
            ORDER BY l.date ASC
        `, [req.userId, targetYear])).rows;

        const fields = [
            { label: 'Date', value: 'date' },
            { label: 'Type', value: 'leave_type' },
            { label: 'Duration', value: 'duration' },
            { label: 'Status', value: 'status' },
            { label: 'Reason', value: 'reason' },
            { label: 'Reviewed By', value: 'approved_by_name' },
        ];

        if (format === 'pdf') {
            sendPDF(res, {
                title: `My Leaves — ${targetYear}`,
                columns: fields.map(f => ({ header: f.label, key: f.value })),
                rows: leaves,
                filename: `leaves_${targetYear}.pdf`,
            });
        } else {
            sendCSV(res, leaves, fields, `leaves_${targetYear}.csv`);
        }
    } catch (err) {
        req.log.error({ err }, 'Export my-leaves error');
        res.status(500).json({ error: 'Export failed' });
    }
});

// ─── Personal Tasks Export ──────────────────────────────────────────────
router.get('/my-tasks', async (req, res) => {
    try {
        const { from, to, format } = req.query;

        let dateFilter = '';
        const params = [req.userId];
        if (from && to) {
            dateFilter = ' AND t.date BETWEEN $2 AND $3';
            params.push(from, to);
        }

        const tasks = (await query(`
            SELECT t.date, t.title, t.status, t.priority, t.due_date,
                   u.full_name AS assigned_to_name
            FROM tasks t
            LEFT JOIN users u ON u.id = t.assigned_to
            WHERE t.user_id = $1${dateFilter}
            ORDER BY t.date DESC, t.id DESC
        `, params)).rows;

        const fields = [
            { label: 'Date', value: 'date' },
            { label: 'Title', value: 'title' },
            { label: 'Status', value: 'status' },
            { label: 'Priority', value: 'priority' },
            { label: 'Due Date', value: 'due_date' },
            { label: 'Assigned To', value: 'assigned_to_name' },
        ];

        if (format === 'pdf') {
            sendPDF(res, {
                title: `My Tasks${from ? ` (${from} to ${to})` : ''}`,
                columns: fields.map(f => ({ header: f.label, key: f.value })),
                rows: tasks,
                filename: `tasks_export.pdf`,
            });
        } else {
            sendCSV(res, tasks, fields, `tasks_export.csv`);
        }
    } catch (err) {
        req.log.error({ err }, 'Export my-tasks error');
        res.status(500).json({ error: 'Export failed' });
    }
});

// ─── Team Analytics Export (Manager+) ───────────────────────────────────
router.get('/team-analytics', requireRole('team_lead'), async (req, res) => {
    try {
        const { from, to, format } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        const userIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (userIds.length === 0) return res.status(200).json([]);

        const members = (await query(`
            SELECT u.id, u.full_name, u.email, u.role, u.timezone_offset,
                   d.name AS department_name, tm.name AS team_name
            FROM users u
            LEFT JOIN departments d ON d.id = u.department_id
            LEFT JOIN teams tm ON tm.id = u.team_id
            WHERE u.id = ANY($1) AND u.is_active = TRUE
            ORDER BY u.full_name
        `, [userIds])).rows;

        const offsetMin = getOffsetMin(req);
        const rows = [];
        for (const member of members) {
            const memberInterval = `${-(member.timezone_offset || offsetMin)} minutes`;
            const entries = (await query(`
                SELECT * FROM time_entries
                WHERE user_id = $1 AND approval_status = 'approved'
                    AND (timestamp + $4::interval)::date BETWEEN $2::date AND $3::date
                ORDER BY timestamp ASC
            `, [member.id, from, to, memberInterval])).rows;

            // Group by date
            const byDate = {};
            entries.forEach(e => {
                const d = new Date(e.timestamp).toISOString().slice(0, 10);
                if (!byDate[d]) byDate[d] = [];
                byDate[d].push(e);
            });

            let totalFloor = 0, totalBreak = 0, daysWorked = 0, targetMet = 0;
            Object.values(byDate).forEach(dayEntries => {
                const f = computeFloorMs(dayEntries);
                const b = computeBreakMs(dayEntries);
                totalFloor += f;
                totalBreak += b;
                daysWorked++;
                if (f >= 8 * 3600000) targetMet++;
            });

            const tasksDone = (await query(
                "SELECT COUNT(*) AS c FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND status = 'done' AND date BETWEEN $2 AND $3",
                [member.id, from, to]
            )).rows[0].c;

            const leaves = (await query(
                "SELECT COUNT(*) AS c FROM leaves WHERE user_id = $1 AND status = 'approved' AND date BETWEEN $2 AND $3",
                [member.id, from, to]
            )).rows[0].c;

            rows.push({
                name: member.full_name,
                email: member.email,
                role: member.role,
                department: member.department_name || '',
                team: member.team_name || '',
                days_worked: daysWorked,
                total_hours: (totalFloor / 3600000).toFixed(2),
                avg_hours: daysWorked > 0 ? (totalFloor / daysWorked / 3600000).toFixed(2) : '0.00',
                break_hours: (totalBreak / 3600000).toFixed(2),
                target_met_days: targetMet,
                target_met_pct: daysWorked > 0 ? Math.round((targetMet / daysWorked) * 100) + '%' : '0%',
                tasks_done: tasksDone,
                leaves_taken: leaves,
            });
        }

        const fields = [
            { label: 'Name', value: 'name' },
            { label: 'Email', value: 'email' },
            { label: 'Role', value: 'role' },
            { label: 'Department', value: 'department' },
            { label: 'Team', value: 'team' },
            { label: 'Days Worked', value: 'days_worked' },
            { label: 'Total Hours', value: 'total_hours' },
            { label: 'Avg Hours/Day', value: 'avg_hours' },
            { label: 'Break Hours', value: 'break_hours' },
            { label: 'Target Met Days', value: 'target_met_days' },
            { label: 'Target Met %', value: 'target_met_pct' },
            { label: 'Tasks Done', value: 'tasks_done' },
            { label: 'Leaves Taken', value: 'leaves_taken' },
        ];

        if (format === 'pdf') {
            sendPDF(res, {
                title: `Team Analytics (${from} to ${to})`,
                columns: fields.map(f => ({ header: f.label, key: f.value, width: 55 })),
                rows,
                filename: `team_analytics_${from}_${to}.pdf`,
            });
        } else {
            sendCSV(res, rows, fields, `team_analytics_${from}_${to}.csv`);
        }
    } catch (err) {
        req.log.error({ err }, 'Export team-analytics error');
        res.status(500).json({ error: 'Export failed' });
    }
});

// ─── Team Leaves Export (Manager+) ──────────────────────────────────────
router.get('/team-leaves', requireRole('team_lead'), async (req, res) => {
    try {
        const { year, format } = req.query;
        const targetYear = parseInt(year, 10) || new Date().getFullYear();
        const userIds = await getVisibleUserIds(req.userId, req.userRole, req.userOrgId, req.userTeamId);
        if (userIds.length === 0) return sendCSV(res, [], [], 'team_leaves.csv');

        const leaves = (await query(`
            SELECT u.full_name, l.date, l.leave_type, l.duration, l.status, l.reason
            FROM leaves l
            JOIN users u ON u.id = l.user_id
            WHERE l.user_id = ANY($1) AND EXTRACT(YEAR FROM l.date::date) = $2
            ORDER BY l.date ASC
        `, [userIds, targetYear])).rows;

        const fields = [
            { label: 'Employee', value: 'full_name' },
            { label: 'Date', value: 'date' },
            { label: 'Type', value: 'leave_type' },
            { label: 'Duration', value: 'duration' },
            { label: 'Status', value: 'status' },
            { label: 'Reason', value: 'reason' },
        ];

        if (format === 'pdf') {
            sendPDF(res, {
                title: `Team Leaves — ${targetYear}`,
                columns: fields.map(f => ({ header: f.label, key: f.value })),
                rows: leaves,
                filename: `team_leaves_${targetYear}.pdf`,
            });
        } else {
            sendCSV(res, leaves, fields, `team_leaves_${targetYear}.csv`);
        }
    } catch (err) {
        req.log.error({ err }, 'Export team-leaves error');
        res.status(500).json({ error: 'Export failed' });
    }
});

module.exports = router;
