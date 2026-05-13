const crypto = require('crypto');
const express = require('express');
const auth = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { handleMention } = require('../utils/collaboration');
const { masterQuery } = require('../db');

const router = express.Router();
const { requireTenant } = require('../middleware/tenant');
router.use(auth, requireTenant);

const MAX_HISTORY = 50;

async function getNotebook(userId, db) {
    const row = (await db.query('SELECT data FROM notebooks WHERE user_id = $1', [userId])).rows[0];
    return row ? JSON.parse(row.data) : null;
}

/**
 * Append a snapshot to notebook_history and prune older snapshots beyond
 * MAX_HISTORY. Requires a transaction client so the snapshot insert and the
 * notebook upsert stay atomic. (Previously the function had a `client ? ... : query`
 * fallback that referenced an undefined `query` symbol — bug fixed.)
 */
async function writeHistory(userId, page, client) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('writeHistory requires a transaction client');
    }
    const q = client.query.bind(client);
    await q(
        'INSERT INTO notebook_history (user_id, page_id, page_title, content) VALUES ($1, $2, $3, $4)',
        [userId, page.id, page.title || 'Untitled', page.content || '']
    );
    const oldest = (await q(
        'SELECT id FROM notebook_history WHERE user_id = $1 AND page_id = $2 ORDER BY saved_at DESC LIMIT ALL OFFSET $3',
        [userId, page.id, MAX_HISTORY]
    )).rows;
    if (oldest.length > 0) {
        const ids = oldest.map(r => r.id);
        await q('DELETE FROM notebook_history WHERE id = ANY($1)', [ids]);
    }
}

router.get('/', async (req, res) => {
    try {
        const row = (await req.db.query('SELECT data, updated_at FROM notebooks WHERE user_id = $1', [req.userId])).rows[0];
        if (!row) return res.json({ data: null });
        res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes error');
        res.status(500).json({ error: 'Failed to fetch notes' });
    }
});

router.put('/', async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) return res.status(400).json({ error: 'No data provided' });

        // Prevent oversized notebook payloads
        const serialized = JSON.stringify(data);
        if (serialized.length > 2 * 1024 * 1024) {
            return res.status(400).json({ error: 'Notebook data too large (max 2 MB)' });
        }

        const old = await getNotebook(req.userId, req.db);
        const oldMap = {};
        if (old?.pages) old.pages.forEach(p => { oldMap[p.id] = p; });

        const newPages = data.pages || [];
        await req.db.transaction(async (client) => {
            for (const page of newPages) {
                const prev = oldMap[page.id];
                if (!prev) continue;
                if (prev.content !== page.content || prev.title !== page.title) {
                    await writeHistory(req.userId, prev, client);
                }
            }
            await client.query(
                `INSERT INTO notebooks (user_id, data, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT(user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
                [req.userId, JSON.stringify(data)]
            );
        });

        res.json({ ok: true });
    } catch (e) {
        req.log.error({ err: e }, 'PUT /notes error');
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

router.get('/history/:pageId', async (req, res) => {
    try {
        const rows = (await req.db.query(
            'SELECT id, page_title, saved_at FROM notebook_history WHERE user_id = $1 AND page_id = $2 ORDER BY saved_at DESC LIMIT 50',
            [req.userId, req.params.pageId]
        )).rows;
        res.json({ history: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/history error');
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

router.get('/history/snapshot/:id', async (req, res) => {
    try {
        const row = (await req.db.query(
            'SELECT id, page_id, page_title, content, saved_at FROM notebook_history WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        )).rows[0];
        if (!row) return res.status(404).json({ error: 'Snapshot not found' });
        res.json({ snapshot: row });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/history/snapshot error');
        res.status(500).json({ error: 'Failed to fetch snapshot' });
    }
});

// @mention notification endpoint
router.post('/mention', async (req, res) => {
    try {
        const { mentionedUserId, pageId, pageTitle } = req.body;
        if (!mentionedUserId || !pageId) {
            return res.status(400).json({ error: 'mentionedUserId and pageId are required' });
        }
        const uid = parseInt(mentionedUserId, 10);
        if (!uid || uid <= 0) return res.status(400).json({ error: 'Invalid user ID' });

        await handleMention(req.db, req.tenantId, req.userId, uid, pageId, pageTitle || 'Untitled');
        res.json({ ok: true });
    } catch (e) {
        req.log.error({ err: e }, 'POST /notes/mention error');
        res.status(500).json({ error: 'Failed to send mention notification' });
    }
});

// Get mentionable users (same org)
router.get('/mentionable-users', async (req, res) => {
    try {
        const user = (await req.db.query('SELECT org_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!user?.org_id) return res.json({ users: [] });

        const rows = (await req.db.query(
            `SELECT id, full_name, avatar, username FROM users
             WHERE org_id = $1 AND is_active = TRUE AND id != $2
             ORDER BY full_name`,
            [user.org_id, req.userId]
        )).rows;
        res.json({ users: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/mentionable-users error');
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// Tier 6 — WorkPulse-specific integrations
// ═══════════════════════════════════════════════════════════════════

// ── Link / unlink entities (tasks, calendar events, meetings) to a note page ──

router.post('/links', async (req, res) => {
    try {
        const { pageId, entityType, entityId } = req.body;
        if (!pageId || !entityType || !entityId) {
            return res.status(400).json({ error: 'pageId, entityType, and entityId are required' });
        }
        const validTypes = ['task', 'calendar_event', 'meeting'];
        if (!validTypes.includes(entityType)) {
            return res.status(400).json({ error: `entityType must be one of: ${validTypes.join(', ')}` });
        }
        const eid = parseInt(entityId, 10);
        if (!eid || eid <= 0) return res.status(400).json({ error: 'Invalid entityId' });

        await req.db.query(
            `INSERT INTO note_links (user_id, page_id, entity_type, entity_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (page_id, entity_type, entity_id) DO NOTHING`,
            [req.userId, String(pageId), entityType, eid]
        );
        res.json({ ok: true });
    } catch (e) {
        req.log.error({ err: e }, 'POST /notes/links error');
        res.status(500).json({ error: 'Failed to link entity' });
    }
});

router.delete('/links', async (req, res) => {
    try {
        const { pageId, entityType, entityId } = req.body;
        if (!pageId || !entityType || !entityId) {
            return res.status(400).json({ error: 'pageId, entityType, and entityId are required' });
        }
        const validTypes = ['task', 'calendar_event', 'meeting'];
        if (!validTypes.includes(entityType)) {
            return res.status(400).json({ error: `entityType must be one of: ${validTypes.join(', ')}` });
        }
        const eid = parseInt(entityId, 10);
        if (!eid || eid <= 0) return res.status(400).json({ error: 'Invalid entityId' });

        await req.db.query(
            `DELETE FROM note_links WHERE page_id = $1 AND entity_type = $2 AND entity_id = $3 AND user_id = $4`,
            [String(pageId), entityType, eid, req.userId]
        );
        res.json({ ok: true });
    } catch (e) {
        req.log.error({ err: e }, 'DELETE /notes/links error');
        res.status(500).json({ error: 'Failed to unlink entity' });
    }
});

// Get all linked entities for a page (enriched with details)
router.get('/links/:pageId', async (req, res) => {
    try {
        const pageId = req.params.pageId;
        const links = (await req.db.query(
            `SELECT id, entity_type, entity_id, created_at FROM note_links
             WHERE page_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
            [pageId, req.userId]
        )).rows;

        // Enrich each link with entity details
        const enriched = [];
        for (const link of links) {
            let detail = null;
            try {
                if (link.entity_type === 'task') {
                    const r = (await req.db.query(
                        `SELECT id, title, status, priority, date, due_date, sprint_id FROM tasks WHERE id = $1`,
                        [link.entity_id]
                    )).rows[0];
                    detail = r || null;
                } else if (link.entity_type === 'calendar_event') {
                    const r = (await req.db.query(
                        `SELECT id, title, description, start_time, end_time, all_day, color FROM calendar_events WHERE id = $1`,
                        [link.entity_id]
                    )).rows[0];
                    detail = r || null;
                } else if (link.entity_type === 'meeting') {
                    const r = (await req.db.query(
                        `SELECT id, title, scheduled_start, scheduled_end, meeting_code, status FROM meetings WHERE id = $1`,
                        [link.entity_id]
                    )).rows[0];
                    detail = r || null;
                }
            } catch { /* entity may have been deleted */ }
            enriched.push({ ...link, detail });
        }

        res.json({ links: enriched });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/links error');
        res.status(500).json({ error: 'Failed to fetch links' });
    }
});

// ── Daily journal auto-prefill — aggregate today's activity ──

router.get('/daily-prefill', async (req, res) => {
    try {
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

        // Tasks completed today
        const tasks = (await req.db.query(
            `SELECT id, title, status, priority FROM tasks
             WHERE (user_id = $1 OR assigned_to = $1)
               AND (date = $2 OR (completed_at >= $3 AND completed_at <= $4))
             ORDER BY completed_at DESC NULLS LAST, created_at DESC
             LIMIT 30`,
            [req.userId, dateStr, startOfDay.toISOString(), endOfDay.toISOString()]
        )).rows;

        // Time tracked today
        const timeEntries = (await req.db.query(
            `SELECT entry_type, timestamp, work_mode FROM time_entries
             WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
               AND (is_manual = FALSE OR approval_status = 'approved')
             ORDER BY timestamp ASC`,
            [req.userId, startOfDay.toISOString(), endOfDay.toISOString()]
        )).rows;

        // Calculate hours worked
        let totalMinutes = 0;
        let clockIn = null;
        let breakStart = null;
        for (const e of timeEntries) {
            if (e.entry_type === 'clock_in') clockIn = new Date(e.timestamp);
            else if (e.entry_type === 'break_start') {
                if (clockIn) totalMinutes += (new Date(e.timestamp) - clockIn) / 60000;
                breakStart = new Date(e.timestamp);
                clockIn = null;
            } else if (e.entry_type === 'break_end') {
                clockIn = new Date(e.timestamp);
                breakStart = null;
            } else if (e.entry_type === 'clock_out') {
                if (clockIn) totalMinutes += (new Date(e.timestamp) - clockIn) / 60000;
                clockIn = null;
            }
        }
        // If still clocked in, count until now
        if (clockIn) totalMinutes += (new Date() - clockIn) / 60000;
        const hoursWorked = Math.round(totalMinutes / 6) / 10; // round to 1 decimal

        // Meetings attended today
        const meetings = (await req.db.query(
            `SELECT m.id, m.title, m.scheduled_start, m.scheduled_end, m.meeting_code
             FROM meetings m
             JOIN meeting_participants mp ON mp.meeting_id = m.id
             WHERE mp.user_id = $1
               AND m.scheduled_start >= $2 AND m.scheduled_start <= $3
             ORDER BY m.scheduled_start ASC`,
            [req.userId, startOfDay.toISOString(), endOfDay.toISOString()]
        )).rows;

        // Calendar events today
        const events = (await req.db.query(
            `SELECT id, title, start_time, end_time, all_day FROM calendar_events
             WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3
             ORDER BY start_time ASC`,
            [req.userId, startOfDay.toISOString(), endOfDay.toISOString()]
        )).rows;

        res.json({ tasks, hoursWorked, timeEntries: timeEntries.length > 0, meetings, events, date: dateStr });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/daily-prefill error');
        res.status(500).json({ error: 'Failed to fetch daily data' });
    }
});

// ── Manager 1-on-1 prefill — fetch direct report's recent activity ──

router.get('/oneonone-prefill/:userId', async (req, res) => {
    try {
        const reportId = parseInt(req.params.userId, 10);
        if (!reportId || reportId <= 0) return res.status(400).json({ error: 'Invalid userId' });

        // Verify the requesting user is the report's manager (or higher)
        const report = (await req.db.query(
            `SELECT id, full_name, team_id, manager_id FROM users WHERE id = $1`,
            [reportId]
        )).rows[0];
        if (!report) return res.status(404).json({ error: 'User not found' });

        // Allow if requester is the manager, or has a management role in same org
        const requester = (await req.db.query(
            `SELECT role, org_id FROM users WHERE id = $1`, [req.userId]
        )).rows[0];
        if (report.manager_id !== req.userId && !['manager', 'hr_admin', 'super_admin', 'platform_admin'].includes(requester?.role)) {
            return res.status(403).json({ error: 'You are not this user\'s manager' });
        }

        const today = new Date();
        const twoWeeksAgo = new Date(today); twoWeeksAgo.setDate(today.getDate() - 14);
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // Recent tasks (last 2 weeks)
        const tasks = (await req.db.query(
            `SELECT id, title, status, priority, date, completed_at FROM tasks
             WHERE (user_id = $1 OR assigned_to = $1)
               AND created_at >= $2
             ORDER BY created_at DESC LIMIT 20`,
            [reportId, twoWeeksAgo.toISOString()]
        )).rows;

        // Recent leaves
        const leaves = (await req.db.query(
            `SELECT date, leave_type, duration, status FROM leaves
             WHERE user_id = $1 AND date >= $2
             ORDER BY date DESC LIMIT 10`,
            [reportId, twoWeeksAgo.toISOString().split('T')[0]]
        )).rows;

        // Sprint progress (if in a team with active sprint)
        let sprint = null;
        if (report.team_id) {
            const activeSprint = (await req.db.query(
                `SELECT id, name, start_date, end_date, goal FROM sprints
                 WHERE team_id = $1 AND status = 'active' LIMIT 1`,
                [report.team_id]
            )).rows[0];
            if (activeSprint) {
                const sprintTasks = (await req.db.query(
                    `SELECT status, COUNT(*)::int AS count FROM tasks
                     WHERE sprint_id = $1 AND (user_id = $2 OR assigned_to = $2)
                     GROUP BY status`,
                    [activeSprint.id, reportId]
                )).rows;
                sprint = { ...activeSprint, taskBreakdown: sprintTasks };
            }
        }

        // Hours this week
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const weekEntries = (await req.db.query(
            `SELECT entry_type, timestamp FROM time_entries
             WHERE user_id = $1 AND timestamp >= $2
               AND (is_manual = FALSE OR approval_status = 'approved')
             ORDER BY timestamp ASC`,
            [reportId, weekStart.toISOString()]
        )).rows;
        let weekMinutes = 0;
        let ci = null;
        for (const e of weekEntries) {
            if (e.entry_type === 'clock_in') ci = new Date(e.timestamp);
            else if (e.entry_type === 'break_start') { if (ci) weekMinutes += (new Date(e.timestamp) - ci) / 60000; ci = null; }
            else if (e.entry_type === 'break_end') ci = new Date(e.timestamp);
            else if (e.entry_type === 'clock_out') { if (ci) weekMinutes += (new Date(e.timestamp) - ci) / 60000; ci = null; }
        }
        const hoursThisWeek = Math.round(weekMinutes / 6) / 10;

        res.json({
            report: { id: report.id, fullName: report.full_name },
            tasks,
            leaves,
            sprint,
            hoursThisWeek,
        });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/oneonone-prefill error');
        res.status(500).json({ error: 'Failed to fetch 1-on-1 data' });
    }
});

// ── Time tracking data for /time block ──

router.get('/time-summary', async (req, res) => {
    try {
        const today = new Date();
        const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

        const entries = (await req.db.query(
            `SELECT entry_type, timestamp, work_mode FROM time_entries
             WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
               AND (is_manual = FALSE OR approval_status = 'approved')
             ORDER BY timestamp ASC`,
            [req.userId, startOfDay.toISOString(), endOfDay.toISOString()]
        )).rows;

        let totalMinutes = 0;
        let breakMinutes = 0;
        let clockIn = null;
        let breakStart = null;
        let firstIn = null;
        let lastOut = null;
        let workMode = null;

        for (const e of entries) {
            if (e.entry_type === 'clock_in') {
                clockIn = new Date(e.timestamp);
                if (!firstIn) firstIn = clockIn;
                if (e.work_mode) workMode = e.work_mode;
            } else if (e.entry_type === 'break_start') {
                if (clockIn) totalMinutes += (new Date(e.timestamp) - clockIn) / 60000;
                breakStart = new Date(e.timestamp);
                clockIn = null;
            } else if (e.entry_type === 'break_end') {
                if (breakStart) breakMinutes += (new Date(e.timestamp) - breakStart) / 60000;
                clockIn = new Date(e.timestamp);
                breakStart = null;
            } else if (e.entry_type === 'clock_out') {
                if (clockIn) totalMinutes += (new Date(e.timestamp) - clockIn) / 60000;
                lastOut = new Date(e.timestamp);
                clockIn = null;
            }
        }
        if (clockIn) totalMinutes += (new Date() - clockIn) / 60000;
        if (breakStart) breakMinutes += (new Date() - breakStart) / 60000;

        res.json({
            hoursWorked: Math.round(totalMinutes / 6) / 10,
            breakHours: Math.round(breakMinutes / 6) / 10,
            firstClockIn: firstIn?.toISOString() || null,
            lastClockOut: lastOut?.toISOString() || null,
            workMode,
            isActive: !!clockIn,
        });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/time-summary error');
        res.status(500).json({ error: 'Failed to fetch time summary' });
    }
});

// ── Convert checklist item → Task ──

router.post('/convert-to-task', async (req, res) => {
    try {
        const { title, pageId, pageTitle } = req.body;
        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Task title is required' });
        }

        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // Get user's org_id
        const userRow = (await req.db.query('SELECT org_id, team_id FROM users WHERE id = $1', [req.userId])).rows[0];

        // Find active sprint for the user's team (if any)
        let sprintId = null;
        if (userRow?.team_id) {
            const sprint = (await req.db.query(
                `SELECT id FROM sprints WHERE team_id = $1 AND status = 'active' LIMIT 1`,
                [userRow.team_id]
            )).rows[0];
            if (sprint) sprintId = sprint.id;
        }

        const result = await req.db.query(
            `INSERT INTO tasks (user_id, org_id, title, date, status, priority, sprint_id)
             VALUES ($1, $2, $3, $4, 'pending', 'medium', $5)
             RETURNING id, title, date, status, priority, sprint_id`,
            [req.userId, userRow?.org_id || null, title.trim(), dateStr, sprintId]
        );
        const task = result.rows[0];

        // Also link the task to the note page if pageId is provided
        if (pageId) {
            await req.db.query(
                `INSERT INTO note_links (user_id, page_id, entity_type, entity_id)
                 VALUES ($1, $2, 'task', $3)
                 ON CONFLICT (page_id, entity_type, entity_id) DO NOTHING`,
                [req.userId, String(pageId), task.id]
            );
        }

        res.json({ task });
    } catch (e) {
        req.log.error({ err: e }, 'POST /notes/convert-to-task error');
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// ── Sprint board data for embedding in notes ──

router.get('/sprint-embed', async (req, res) => {
    try {
        const userRow = (await req.db.query('SELECT team_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!userRow?.team_id) return res.json({ sprint: null, tasks: [] });

        const sprint = (await req.db.query(
            `SELECT id, name, goal, status, start_date, end_date FROM sprints
             WHERE team_id = $1 AND status = 'active' LIMIT 1`,
            [userRow.team_id]
        )).rows[0];
        if (!sprint) return res.json({ sprint: null, tasks: [] });

        // Sort by priority weight (high → medium → low) so the embedded sprint
        // board mirrors the main backlog order. Plain `ORDER BY priority DESC`
        // would sort alphabetically and put 'medium' before 'low' before 'high'.
        const tasks = (await req.db.query(
            `SELECT t.id, t.title, t.status, t.priority, t.assigned_to,
                    u.full_name AS assignee_name
             FROM tasks t
             LEFT JOIN users u ON u.id = t.assigned_to
             WHERE t.sprint_id = $1
             ORDER BY CASE t.priority
                          WHEN 'high'   THEN 1
                          WHEN 'medium' THEN 2
                          WHEN 'low'    THEN 3
                          ELSE 4
                      END,
                      t.created_at ASC`,
            [sprint.id]
        )).rows;

        // Calculate burndown-style stats
        const total = tasks.length;
        const done = tasks.filter(t => t.status === 'done').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const inReview = tasks.filter(t => t.status === 'in_review').length;
        const pending = tasks.filter(t => t.status === 'pending').length;

        res.json({
            sprint,
            tasks,
            stats: { total, done, inProgress, inReview, pending },
        });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/sprint-embed error');
        res.status(500).json({ error: 'Failed to fetch sprint data' });
    }
});

// ── Searchable tasks for linking UI ──

router.get('/search-tasks', async (req, res) => {
    try {
        const { q } = req.query;

        // Include tasks the user owns, is assigned to, OR belong to same org
        const userRow = (await req.db.query('SELECT org_id FROM users WHERE id = $1', [req.userId])).rows[0];
        const orgId = userRow?.org_id || null;

        let rows;
        if (!q || !q.trim()) {
            // Return recent tasks when no query
            rows = (await req.db.query(
                `SELECT id, title, status, priority, date FROM tasks
                 WHERE (user_id = $1 OR assigned_to = $1${orgId ? ' OR org_id = $2' : ''})
                 ORDER BY created_at DESC LIMIT 20`,
                orgId ? [req.userId, orgId] : [req.userId]
            )).rows;
        } else {
            const ilikePat = `%${q.trim().replace(/[\\%_]/g, c => `\\${c}`)}%`;
            rows = (await req.db.query(
                `SELECT id, title, status, priority, date FROM tasks
                 WHERE (user_id = $1 OR assigned_to = $1${orgId ? ' OR org_id = $3' : ''})
                   AND title ILIKE $2
                 ORDER BY created_at DESC LIMIT 20`,
                orgId ? [req.userId, ilikePat, orgId] : [req.userId, ilikePat]
            )).rows;
        }
        res.json({ tasks: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/search-tasks error');
        res.status(500).json({ error: 'Failed to search tasks' });
    }
});

// ── Searchable meetings for linking UI ──

router.get('/search-meetings', async (req, res) => {
    try {
        const { q } = req.query;
        const ilikePat = `%${(q || '').replace(/[\\%_]/g, c => `\\${c}`)}%`;
        const rows = (await req.db.query(
            `SELECT m.id, m.title, m.scheduled_start, m.scheduled_end, m.meeting_code, m.status
             FROM meetings m
             JOIN meeting_participants mp ON mp.meeting_id = m.id
             WHERE mp.user_id = $1 AND m.title ILIKE $2
             ORDER BY m.scheduled_start DESC LIMIT 15`,
            [req.userId, ilikePat]
        )).rows;
        res.json({ meetings: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/search-meetings error');
        res.status(500).json({ error: 'Failed to search meetings' });
    }
});

// ── Searchable calendar events for linking UI ──

router.get('/search-events', async (req, res) => {
    try {
        const { q } = req.query;
        const ilikePat = `%${(q || '').replace(/[\\%_]/g, c => `\\${c}`)}%`;
        const rows = (await req.db.query(
            `SELECT id, title, start_time, end_time, all_day FROM calendar_events
             WHERE user_id = $1 AND title ILIKE $2
             ORDER BY start_time DESC LIMIT 15`,
            [req.userId, ilikePat]
        )).rows;
        res.json({ events: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/search-events error');
        res.status(500).json({ error: 'Failed to search events' });
    }
});

// ── Team members list for 1-on-1 report picker ──

router.get('/direct-reports', async (req, res) => {
    try {
        const reports = (await req.db.query(
            `SELECT id, full_name, avatar, username FROM users
             WHERE manager_id = $1 AND is_active = TRUE
             ORDER BY full_name`,
            [req.userId]
        )).rows;
        res.json({ reports });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/direct-reports error');
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// Public read-only share links (Chunk 5)
//
// A user can mint a share token for any of their own pages. The token is
// stored in the MASTER DB (note_share_tokens) so the public viewer route
// can resolve token → (tenant, user, page) without authentication.
//
// GET    /api/notes/share/:pageId  → { token, url } | { token: null }
// POST   /api/notes/share/:pageId  → mint or reuse token; returns { token, url }
// DELETE /api/notes/share/:pageId  → revoke
// ─────────────────────────────────────────────────────────────────────────

function publicShareUrlFor(req, token) {
    // Best-effort absolute URL for copy-to-clipboard. Falls back to relative.
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers.host;
    if (host) return `${proto}://${host}/n/${token}`;
    return `/n/${token}`;
}

router.get('/share/:pageId', async (req, res) => {
    try {
        const pageId = String(req.params.pageId || '');
        if (!pageId) return res.status(400).json({ error: 'pageId required' });
        const row = (await masterQuery(
            `SELECT token, page_title, created_at FROM note_share_tokens
              WHERE tenant_id = $1 AND user_id = $2 AND page_id = $3`,
            [req.tenantId, req.userId, pageId]
        )).rows[0];
        if (!row) return res.json({ token: null });
        res.json({ token: row.token, url: publicShareUrlFor(req, row.token), page_title: row.page_title, created_at: row.created_at });
    } catch (err) {
        req.log.error({ err }, 'GET /notes/share failed');
        res.status(500).json({ error: 'Failed to fetch share token' });
    }
});

router.post('/share/:pageId', async (req, res) => {
    try {
        const pageId = String(req.params.pageId || '');
        if (!pageId) return res.status(400).json({ error: 'pageId required' });

        // Confirm the page exists in the user's notebook (we read titles from
        // the user's notebooks JSON, since the tenant DB is the source of
        // truth for note content).
        const notebook = await getNotebook(req.userId, req.db);
        const page = notebook?.pages?.find(p => p.id === pageId);
        if (!page) return res.status(404).json({ error: 'Page not found' });

        // Reuse an existing token if there's one — share URLs are stable.
        const existing = (await masterQuery(
            `SELECT token FROM note_share_tokens
              WHERE tenant_id = $1 AND user_id = $2 AND page_id = $3`,
            [req.tenantId, req.userId, pageId]
        )).rows[0];

        let token = existing?.token;
        if (!token) {
            // Unguessable: 32 bytes → ~43 url-safe chars.
            token = crypto.randomBytes(32).toString('base64url');
            await masterQuery(
                `INSERT INTO note_share_tokens
                    (token, tenant_id, user_id, page_id, page_title, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [token, req.tenantId, req.userId, pageId, page.title || 'Untitled', req.userId]
            );
        } else {
            // Refresh the cached title so revisitors see the current name.
            await masterQuery(
                `UPDATE note_share_tokens SET page_title = $1
                  WHERE tenant_id = $2 AND user_id = $3 AND page_id = $4`,
                [page.title || 'Untitled', req.tenantId, req.userId, pageId]
            );
        }

        res.json({ token, url: publicShareUrlFor(req, token) });
    } catch (err) {
        req.log.error({ err }, 'POST /notes/share failed');
        res.status(500).json({ error: 'Failed to create share token' });
    }
});

router.delete('/share/:pageId', async (req, res) => {
    try {
        const pageId = String(req.params.pageId || '');
        if (!pageId) return res.status(400).json({ error: 'pageId required' });
        await masterQuery(
            `DELETE FROM note_share_tokens
              WHERE tenant_id = $1 AND user_id = $2 AND page_id = $3`,
            [req.tenantId, req.userId, pageId]
        );
        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, 'DELETE /notes/share failed');
        res.status(500).json({ error: 'Failed to revoke share token' });
    }
});

module.exports = router;
