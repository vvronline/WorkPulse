const express = require('express');
const { query, transaction } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole } = require('../middleware/rbac');
const { getLocalToday } = require('../utils/timezone');
const { logger } = require('../utils/logger');
const { notifyByEmail } = require('../utils/mailer');
const { sendToUser } = require('../utils/ws');
const { logAction } = require('../utils/audit');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();
router.use(requireTenant);

// Helper: record task history
async function logHistory(taskId, userId, action, field, oldValue, newValue, client, db) {
    const q = client ? client.query.bind(client) : (db ? db.query : query);
    await q(
        'INSERT INTO task_history (task_id, user_id, action, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
        [taskId, userId, action, field || null, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null]
    );
}

// Helper: get labels for a set of task IDs
async function getLabelsForTasks(taskIds, db) {
    if (!taskIds.length) return {};
    const rows = (await db.query(
        `SELECT tlm.task_id, tl.id, tl.name, tl.color
         FROM task_label_map tlm
         JOIN task_labels tl ON tl.id = tlm.label_id
         WHERE tlm.task_id = ANY($1)`,
        [taskIds]
    )).rows;
    const map = {};
    for (const r of rows) {
        if (!map[r.task_id]) map[r.task_id] = [];
        map[r.task_id].push({ id: r.id, name: r.name, color: r.color });
    }
    return map;
}

// Helper: get comment counts for a set of task IDs
async function getCommentCounts(taskIds, db) {
    if (!taskIds.length) return {};
    const rows = (await db.query(
        `SELECT task_id, COUNT(*) as count FROM task_comments
         WHERE task_id = ANY($1)
         GROUP BY task_id`,
        [taskIds]
    )).rows;
    const map = {};
    for (const r of rows) map[r.task_id] = parseInt(r.count, 10);
    return map;
}

// Helper: enrich tasks with assignee info, labels, comment counts
async function enrichTasks(tasks, db) {
    if (!tasks.length) return [];
    const taskIds = tasks.map(t => t.id);
    const labelsMap = await getLabelsForTasks(taskIds, db);
    const commentMap = await getCommentCounts(taskIds, db);

    const assigneeIds = [...new Set(tasks.map(t => t.assigned_to).filter(Boolean))];
    const assigneeMap = {};
    if (assigneeIds.length) {
        const users = (await db.query('SELECT id, username, full_name, avatar FROM users WHERE id = ANY($1)', [assigneeIds])).rows;
        for (const u of users) assigneeMap[u.id] = { username: u.username, full_name: u.full_name, avatar: u.avatar };
    }

    const creatorIds = [...new Set(tasks.map(t => t.user_id))];
    const creatorMap = {};
    if (creatorIds.length) {
        const users = (await db.query('SELECT id, username, full_name FROM users WHERE id = ANY($1)', [creatorIds])).rows;
        for (const u of users) creatorMap[u.id] = { username: u.username, full_name: u.full_name };
    }

    const sprintIds = [...new Set(tasks.map(t => t.sprint_id).filter(Boolean))];
    const sprintMap = {};
    if (sprintIds.length) {
        const sprints = (await db.query('SELECT id, name, status, start_date, end_date FROM sprints WHERE id = ANY($1)', [sprintIds])).rows;
        for (const s of sprints) sprintMap[s.id] = s;
    }

    return tasks.map(t => ({
        ...t,
        labels: labelsMap[t.id] || [],
        comment_count: commentMap[t.id] || 0,
        assignee: t.assigned_to ? (assigneeMap[t.assigned_to] || null) : null,
        creator: creatorMap[t.user_id] || null,
        sprint: t.sprint_id ? (sprintMap[t.sprint_id] || null) : null,
    }));
}

// Helper: check if user can access task within tenant boundary
async function canAccessTask(task, userId, requesterOrgId, db) {
    if (!task) return false;
    if (!requesterOrgId) {
        // Users without an organization can only access their own direct tasks.
        return task.user_id === userId || task.assigned_to === userId;
    }

    const ownerRes = await db.query('SELECT team_id, org_id FROM users WHERE id = $1', [task.user_id]);
    const owner = ownerRes.rows[0];
    const taskOrgId = task.org_id || owner?.org_id || null;

    if (!taskOrgId || taskOrgId !== requesterOrgId) return false;
    if (task.user_id === userId || task.assigned_to === userId) return true;

    const userRes = await db.query('SELECT team_id, org_id FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user || user.org_id !== requesterOrgId) return false;
    if (!owner || owner.org_id !== requesterOrgId) return false;

    return user.team_id && owner.team_id && user.team_id === owner.team_id;
}

// Helper: sync labels for a task
async function syncLabels(taskId, labelIds, orgId, db) {
    if (!labelIds || !Array.isArray(labelIds)) return;
    // Limit labels per task to prevent resource exhaustion
    const limitedIds = labelIds.slice(0, 20);
    await db.query('DELETE FROM task_label_map WHERE task_id = $1', [taskId]);
    for (const lid of limitedIds) {
        const validLid = parseInt(lid, 10);
        if (isNaN(validLid)) continue;
        // Only allow labels from the same org (or personal labels with no org)
        const label = orgId
            ? (await db.query('SELECT id FROM task_labels WHERE id = $1 AND org_id = $2', [validLid, orgId])).rows[0]
            : (await db.query('SELECT id FROM task_labels WHERE id = $1 AND org_id IS NULL', [validLid])).rows[0];
        if (label) {
            await db.query('INSERT INTO task_label_map (task_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [taskId, validLid]);
        }
    }
}

// ─── Get tasks for a specific date or date range ─────────────────────────
router.get('/', auth, loadUserContext, async (req, res) => {
    try {
        const { date, start_date, end_date, sprint_id, scope, include_due, assignee, label, priority, status, search } = req.query;

        const conditions = [];
        const params = [];
        let pi = 1;

        if (req.userOrgId) {
            conditions.push(`t.org_id = $${pi++}`);
            params.push(req.userOrgId);
        } else {
            conditions.push('t.org_id IS NULL');
        }

        if (sprint_id) {
            conditions.push(`t.sprint_id = $${pi++}`);
            params.push(parseInt(sprint_id, 10));
        } else if (start_date && end_date) {
            conditions.push(`t.date >= $${pi++} AND t.date <= $${pi++}`);
            params.push(start_date, end_date);
        } else if (date) {
            if (include_due === '1') {
                conditions.push(`(t.sprint_id IS NULL AND t.date IS NOT NULL AND (t.date = $${pi} OR t.due_date = $${pi}))`);
                params.push(date);
                pi++;
            } else {
                conditions.push(`t.date = $${pi++}`);
                params.push(date);
            }
        } else {
            const targetDate = getLocalToday(req);
            conditions.push(`t.date = $${pi++}`);
            params.push(targetDate);
        }

        if (scope === 'personal') {
            conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi})`);
            params.push(req.userId);
            pi++;
        } else {
            if (req.userTeamId) {
                conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi} OR t.user_id IN (SELECT id FROM users WHERE team_id = $${pi + 1}))`);
                params.push(req.userId, req.userTeamId);
                pi += 2;
            } else {
                conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi})`);
                params.push(req.userId);
                pi++;
            }
        }

        if (assignee) {
            if (assignee === 'me') {
                conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi})`);
                params.push(req.userId);
                pi++;
            } else {
                const assigneeId = parseInt(assignee, 10);
                conditions.push(`(t.assigned_to = $${pi} OR (t.user_id = $${pi} AND t.assigned_to IS NULL))`);
                params.push(assigneeId);
                pi++;
            }
        }

        if (priority && ['low', 'medium', 'high'].includes(priority)) {
            conditions.push(`t.priority = $${pi++}`);
            params.push(priority);
        }

        if (status && ['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            conditions.push(`t.status = $${pi++}`);
            params.push(status);
        }

        if (search && search.trim()) {
            const escaped = search.trim().replace(/[%_]/g, c => `\\${c}`);
            conditions.push(`(t.title ILIKE $${pi} OR t.description ILIKE $${pi})`);
            params.push(`%${escaped}%`);
            pi++;
        }

        let tasks = (await req.db.query(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY
                CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                CASE t.status WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 WHEN 'pending' THEN 3 WHEN 'done' THEN 4 END,
                t.created_at ASC
        `, params)).rows;

        if (label) {
            const labelId = parseInt(label, 10);
            const taskIdsWithLabel = new Set(
                (await req.db.query('SELECT task_id FROM task_label_map WHERE label_id = $1', [labelId])).rows.map(r => r.task_id)
            );
            tasks = tasks.filter(t => taskIdsWithLabel.has(t.id));
        }

        const enriched = await enrichTasks(tasks, req.db);
        const total = enriched.length;
        const done = enriched.filter(t => t.status === 'done').length;
        const inProgress = enriched.filter(t => t.status === 'in_progress').length;

        res.json({ tasks: enriched, stats: { total, done, inProgress, percent: total > 0 ? Math.round((done / total) * 100) : 0 } });
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching tasks:');
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// ─── Add a task ──────────────────────────────────────────────────────────
router.post('/', auth, loadUserContext, async (req, res) => {
    try {
        const { title, description, priority, date, assigned_to, due_date, label_ids, sprint_id } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'Task title is required' });
        if (title.trim().length > 200) return res.status(400).json({ error: 'Task title must be 200 characters or less' });
        if (description && description.length > 5000) return res.status(400).json({ error: 'Task description must be 5000 characters or less' });

        const targetDate = date || getLocalToday(req);
        const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

        let assignedTo = null;
        if (assigned_to) {
            const targetUser = (await req.db.query('SELECT id, org_id, is_active FROM users WHERE id = $1', [assigned_to])).rows[0];
            if (!targetUser || !targetUser.is_active) return res.status(400).json({ error: 'Assigned user not found or inactive' });
            if (targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
            }
            assignedTo = assigned_to;
        }

        let validDueDate = null;
        if (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) validDueDate = due_date;

        let validSprintId = null;
        if (sprint_id) {
            const sprint = (await req.db.query(
                'SELECT s.id, s.team_id, s.end_date FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
                [sprint_id, req.userOrgId]
            )).rows[0];
            if (sprint && sprint.team_id === req.userTeamId) {
                validSprintId = sprint.id;
                if (!validDueDate) validDueDate = sprint.end_date;
            } else {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
        }

        const result = await req.db.query(
            'INSERT INTO tasks (user_id, date, title, description, priority, assigned_to, due_date, sprint_id, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [req.userId, targetDate, title.trim(), description?.trim() || null, validPriority, assignedTo, validDueDate, validSprintId, req.userOrgId || null]
        );
        const taskId = result.rows[0].id;

        if (label_ids && Array.isArray(label_ids) && label_ids.length > 0) await syncLabels(taskId, label_ids, req.userOrgId, req.db);
        await logHistory(taskId, req.userId, 'created', null, null, null, null, req.db);

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
        const enriched = await enrichTasks([task], req.db);

        // Notify assigned user
        if (assignedTo && assignedTo !== req.userId) {
            const assignee = (await req.db.query('SELECT email, full_name FROM users WHERE id = $1', [assignedTo])).rows[0];
            const assigner = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
            if (assignee) {
                await req.db.query(
                    'INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5)',
                    [assignedTo, 'task', `Task Assigned: ${task.title}`, `${assigner?.full_name || 'Someone'} assigned you a task`, task.id]
                );
                notifyByEmail('taskAssigned', assignee, task, assigner?.full_name || 'Someone');
                sendToUser(req.tenantId, assignedTo, 'task_assigned', { taskId, title: task.title });
            }
        }

        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error creating task:');
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// ─── Update task status ──────────────────────────────────────────────────
router.patch('/:id/status', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        const completedAt = status === 'done' ? new Date().toISOString() : null;
        await req.db.query('UPDATE tasks SET status = $1, completed_at = $2 WHERE id = $3', [status, completedAt, id]);

        if (task.status !== status) await logHistory(id, req.userId, 'status_change', 'status', task.status, status, null, req.db);

        const updated = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);
        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error updating task status:');
        res.status(500).json({ error: 'Failed to update task status' });
    }
});

// ─── Update task details ─────────────────────────────────────────────────
router.put('/:id', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id } = req.body;

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        const newTitle = title?.trim() || task.title;
        const newDesc = description !== undefined ? (description?.trim() || null) : task.description;
        const newPriority = ['low', 'medium', 'high'].includes(priority) ? priority : task.priority;

        let newAssignedTo = task.assigned_to;
        if (assigned_to !== undefined) {
            if (assigned_to === null || assigned_to === '') {
                newAssignedTo = null;
            } else {
                const targetUser = (await req.db.query('SELECT id, org_id, is_active FROM users WHERE id = $1', [assigned_to])).rows[0];
                if (!targetUser || !targetUser.is_active) return res.status(400).json({ error: 'Assigned user not found or inactive' });
                if (targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                    return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
                }
                newAssignedTo = assigned_to;
            }
        }

        let newDueDate = task.due_date;
        if (due_date !== undefined) {
            newDueDate = (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) ? due_date : null;
        }

        let newSprintId = task.sprint_id;
        if (sprint_id !== undefined) {
            if (sprint_id === null || sprint_id === '') {
                newSprintId = null;
            } else {
                const sprint = (await req.db.query(
                    'SELECT s.id, s.team_id, s.end_date FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
                    [sprint_id, req.userOrgId]
                )).rows[0];
                if (sprint && sprint.team_id === req.userTeamId) {
                    newSprintId = sprint_id;
                    newDueDate = sprint.end_date;
                } else {
                    return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
                }
            }
        }

        await req.db.query(
            'UPDATE tasks SET title = $1, description = $2, priority = $3, assigned_to = $4, due_date = $5, sprint_id = $6 WHERE id = $7',
            [newTitle, newDesc, newPriority, newAssignedTo, newDueDate, newSprintId, id]
        );

        if (newTitle !== task.title) await logHistory(id, req.userId, 'updated', 'title', task.title, newTitle, null, req.db);
        if (newDesc !== task.description) await logHistory(id, req.userId, 'updated', 'description', task.description ? task.description.slice(0, 100, null, req.db) : null, newDesc ? newDesc.slice(0, 100) : null);
        if (newPriority !== task.priority) await logHistory(id, req.userId, 'updated', 'priority', task.priority, newPriority, null, req.db);
        if (String(newAssignedTo || '') !== String(task.assigned_to || '')) {
            const oldUser = task.assigned_to ? (await req.db.query('SELECT full_name FROM users WHERE id = $1', [task.assigned_to])).rows[0] : null;
            const newUser = newAssignedTo ? (await req.db.query('SELECT full_name FROM users WHERE id = $1', [newAssignedTo])).rows[0] : null;
            await logHistory(id, req.userId, 'updated', 'assigned_to', oldUser?.full_name || 'unassigned', newUser?.full_name || 'unassigned', null, req.db);
        }
        if (newDueDate !== task.due_date) await logHistory(id, req.userId, 'updated', 'due_date', task.due_date, newDueDate, null, req.db);
        if (String(newSprintId || '') !== String(task.sprint_id || '')) {
            const oldSprint = task.sprint_id ? (await req.db.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            const newSprint = newSprintId ? (await req.db.query('SELECT name FROM sprints WHERE id = $1', [newSprintId])).rows[0] : null;
            await logHistory(id, req.userId, 'updated', 'sprint', oldSprint?.name || 'none', newSprint?.name || 'none', null, req.db);
        }

        if (label_ids !== undefined) {
            const oldLabels = (await req.db.query('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = $1 ORDER BY tl.name', [id])).rows.map(r => r.name);
            await syncLabels(id, label_ids || [], req.userOrgId, req.db);
            const newLabels = (await req.db.query('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = $1 ORDER BY tl.name', [id])).rows.map(r => r.name);
            if (JSON.stringify(oldLabels) !== JSON.stringify(newLabels)) {
                await logHistory(id, req.userId, 'updated', 'labels', oldLabels.join(', ', null, req.db) || 'none', newLabels.join(', ') || 'none');
            }
        }

        const updated = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);

        // Notify if assignment changed to a new user
        if (newAssignedTo && String(newAssignedTo) !== String(task.assigned_to) && newAssignedTo !== req.userId) {
            const assignee = (await req.db.query('SELECT email, full_name FROM users WHERE id = $1', [newAssignedTo])).rows[0];
            const assigner = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
            if (assignee) {
                await req.db.query(
                    'INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5)',
                    [newAssignedTo, 'task', `Task Assigned: ${updated.title}`, `${assigner?.full_name || 'Someone'} assigned you a task`, updated.id]
                );
                notifyByEmail('taskAssigned', assignee, updated, assigner?.full_name || 'Someone');
                sendToUser(req.tenantId, newAssignedTo, 'task_assigned', { taskId: updated.id, title: updated.title });
            }
        }

        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error updating task:');
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// ─── Delete a task (only creator can delete) ─────────────────────────────
router.delete('/:id', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (task.user_id !== req.userId) return res.status(403).json({ error: 'Only task creator can delete task' });
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        await logHistory(id, req.userId, 'deleted', null, task.title, null, null, req.db);
        await req.db.query('DELETE FROM tasks WHERE id = $1', [id]);
        res.json({ message: 'Task deleted' });
    } catch (err) {
        req.log.error({ err: err }, 'Error deleting task:');
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

// ─── Carry-forward incomplete tasks ──────────────────────────────────────
router.post('/carry-forward', auth, loadUserContext, async (req, res) => {
    try {
        const today = getLocalToday(req);

        const lastTaskDay = (await req.db.query(`
            SELECT date FROM tasks
            WHERE (user_id = $1 OR assigned_to = $1)
              AND date::date < $2::date
              AND date::date >= $2::date - INTERVAL '7 days'
              AND ((org_id = $3) OR (org_id IS NULL AND $3::integer IS NULL))
            ORDER BY date DESC LIMIT 1
        `, [req.userId, today, req.userOrgId || null])).rows[0];

        if (!lastTaskDay) return res.json({ message: 'No tasks to carry forward', carried: 0 });

        const incomplete = (await req.db.query(`
            SELECT title, description, priority, assigned_to, due_date FROM tasks
            WHERE (user_id = $1 OR assigned_to = $1)
              AND date = $2
              AND status != 'done'
              AND ((org_id = $3) OR (org_id IS NULL AND $3::integer IS NULL))
        `, [req.userId, lastTaskDay.date, req.userOrgId || null])).rows;

        if (incomplete.length === 0) return res.json({ message: 'No tasks to carry forward', carried: 0 });

        const carried = await req.db.transaction(async (client) => {
            let count = 0;
            for (const t of incomplete) {
                const exists = (await client.query(
                    'SELECT id FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND date = $2 AND title = $3',
                    [req.userId, today, t.title]
                )).rows[0];
                if (!exists) {
                    const dueDate = t.due_date && t.due_date < today ? today : t.due_date;
                    const insertRes = await client.query(
                        'INSERT INTO tasks (user_id, date, title, description, priority, assigned_to, due_date, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
                        [req.userId, today, t.title, t.description, t.priority, t.assigned_to, dueDate, req.userOrgId || null]
                    );
                    const newTaskId = insertRes.rows[0].id;
                    const origTask = (await client.query(
                        'SELECT id FROM tasks WHERE user_id = $1 AND date = $2 AND title = $3',
                        [req.userId, lastTaskDay.date, t.title]
                    )).rows[0];
                    if (origTask) {
                        const origLabels = (await client.query('SELECT label_id FROM task_label_map WHERE task_id = $1', [origTask.id])).rows;
                        for (const lbl of origLabels) {
                            await client.query(
                                'INSERT INTO task_label_map (task_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                                [newTaskId, lbl.label_id]
                            );
                        }
                    }
                    await logHistory(newTaskId, req.userId, 'created', 'date', lastTaskDay.date, today, client, req.db);
                    count++;
                }
            }
            return count;
        });

        res.json({ message: `${carried} task(s) carried forward`, carried });
    } catch (err) {
        req.log.error({ err: err }, 'Error carrying forward tasks:');
        res.status(500).json({ error: 'Failed to carry forward tasks' });
    }
});

// ─── Global search across all dates + backlog ────────────────────────────
router.get('/search', auth, loadUserContext, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || !q.trim() || q.trim().length < 2) return res.json([]);

        const escapedQ = q.trim().replace(/[%_]/g, c => `\\${c}`);
        const conditions = ['(t.title ILIKE $1 OR t.description ILIKE $1)'];
        const params = [`%${escapedQ}%`];
        let pi = 2;

        if (req.userOrgId) {
            conditions.push(`t.org_id = $${pi++}`);
            params.push(req.userOrgId);
        } else {
            conditions.push('t.org_id IS NULL');
        }

        // Restrict search scope: own tasks + assigned to me + same team/dept
        conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi})`);
        params.push(req.userId);
        pi++;

        const tasks = (await req.db.query(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.created_at DESC
            LIMIT 20
        `, params)).rows;

        const enriched = await enrichTasks(tasks, req.db);
        res.json(enriched);
    } catch (err) {
        req.log.error({ err: err }, 'Error in global search:');
        res.status(500).json({ error: 'Search failed' });
    }
});

// ─── Get assignable users (same org) ─────────────────────────────────────
router.get('/assignable-users', auth, loadUserContext, async (req, res) => {
    try {
        let users;
        if (req.userOrgId) {
            users = (await req.db.query(
                'SELECT id, username, full_name, avatar FROM users WHERE org_id = $1 AND is_active = TRUE ORDER BY full_name ASC',
                [req.userOrgId]
            )).rows;
        } else {
            users = (await req.db.query('SELECT id, username, full_name, avatar FROM users WHERE id = $1', [req.userId])).rows;
        }
        res.json(users);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching assignable users:');
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ─── Get labels for current user's org ───────────────────────────────────
router.get('/labels', auth, loadUserContext, async (req, res) => {
    try {
        let labels = [];
        if (req.userOrgId) {
            labels = (await req.db.query('SELECT id, name, color FROM task_labels WHERE org_id = $1 ORDER BY name ASC', [req.userOrgId])).rows;
        }
        res.json(labels);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching labels:');
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
});

// ─── Label Management (manager+) ────────────────────────────────────────
router.get('/labels/manage', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const result = await req.db.query(
            'SELECT tl.*, u.username as created_by_username FROM task_labels tl LEFT JOIN users u ON u.id = tl.created_by WHERE tl.org_id = $1 ORDER BY tl.name ASC',
            [req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'Fetch labels error');
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
});

router.post('/labels', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization required' });
        const { name, color } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Label name is required' });
        if (name.trim().length > 30) return res.status(400).json({ error: 'Label name must be 30 characters or less' });
        const existingRes = await req.db.query('SELECT id FROM task_labels WHERE org_id = $1 AND LOWER(name) = LOWER($2)', [req.userOrgId, name.trim()]);
        if (existingRes.rows[0]) return res.status(409).json({ error: 'A label with this name already exists' });
        const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#6366f1';
        const result = await req.db.query(
            'INSERT INTO task_labels (org_id, name, color, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.userOrgId, name.trim(), validColor, req.userId]
        );
        const label = result.rows[0];
        logAction(req, 'create', 'task_label', label.id, { name: label.name });
        res.json(label);
    } catch (err) {
        req.log.error({ err }, 'Create label error');
        res.status(500).json({ error: 'Failed to create label' });
    }
});

router.put('/labels/:id', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        const labelRes = await req.db.query('SELECT * FROM task_labels WHERE id = $1', [Number(req.params.id)]);
        const label = labelRes.rows[0];
        if (!label) return res.status(404).json({ error: 'Label not found' });
        if (label.org_id !== req.userOrgId) return res.status(403).json({ error: 'Cannot edit labels from another organization' });
        const { name, color } = req.body;
        const newName = name?.trim() || label.name;
        if (newName.length > 30) return res.status(400).json({ error: 'Label name must be 30 characters or less' });
        if (newName.toLowerCase() !== label.name.toLowerCase()) {
            const existingRes = await req.db.query('SELECT id FROM task_labels WHERE org_id = $1 AND LOWER(name) = LOWER($2) AND id != $3', [label.org_id, newName, label.id]);
            if (existingRes.rows[0]) return res.status(409).json({ error: 'A label with this name already exists' });
        }
        const newColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : label.color;
        await req.db.query('UPDATE task_labels SET name = $1, color = $2 WHERE id = $3', [newName, newColor, label.id]);
        const updated = await req.db.query('SELECT * FROM task_labels WHERE id = $1', [label.id]);
        logAction(req, 'update', 'task_label', label.id, { name: newName });
        res.json(updated.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Update label error');
        res.status(500).json({ error: 'Failed to update label' });
    }
});

router.delete('/labels/:id', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        const labelRes = await req.db.query('SELECT * FROM task_labels WHERE id = $1', [Number(req.params.id)]);
        const label = labelRes.rows[0];
        if (!label) return res.status(404).json({ error: 'Label not found' });
        if (label.org_id !== req.userOrgId) return res.status(403).json({ error: 'Cannot delete labels from another organization' });
        await req.db.query('DELETE FROM task_label_map WHERE label_id = $1', [label.id]);
        await req.db.query('DELETE FROM task_labels WHERE id = $1', [label.id]);
        logAction(req, 'delete', 'task_label', label.id, { name: label.name });
        res.json({ message: 'Label deleted' });
    } catch (err) {
        req.log.error({ err }, 'Delete label error');
        res.status(500).json({ error: 'Failed to delete label' });
    }
});

// ─── Get available sprints for user's team (current + future) ────────────
router.get('/available-sprints', auth, loadUserContext, async (req, res) => {
    try {
        if (!req.userTeamId) return res.json([]);

        const sprints = (await req.db.query(`
            SELECT id, name, start_date, end_date, status, goal
            FROM sprints
            WHERE team_id = $1 AND status IN ('active', 'planned')
            ORDER BY start_date ASC
        `, [req.userTeamId])).rows;

        if (sprints.length === 0) {
            const team = (await req.db.query('SELECT sprint_start_date, sprint_duration_weeks FROM teams WHERE id = $1', [req.userTeamId])).rows[0];
            if (team?.sprint_start_date) {
                const tzOffset = req.headers['x-timezone-offset'];
                let todayStr;
                if (tzOffset !== undefined) {
                    const now = new Date();
                    const localNow = new Date(now.getTime() - Number(tzOffset) * 60000);
                    todayStr = localNow.toISOString().split('T')[0];
                } else {
                    const now = new Date();
                    todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                }

                const [sy, sm, sd] = team.sprint_start_date.split('-').map(Number);
                const [ty, tm, td] = todayStr.split('-').map(Number);
                const startMs = Date.UTC(sy, sm - 1, sd);
                const todayMs = Date.UTC(ty, tm - 1, td);
                const daysSinceStart = Math.floor((todayMs - startMs) / 86400000);
                const sprintDurationDays = team.sprint_duration_weeks * 7;
                const sprintNumber = daysSinceStart < 0 ? 1 : Math.floor(daysSinceStart / sprintDurationDays) + 1;

                const fmt = (ms) => {
                    const d = new Date(ms);
                    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
                };

                const autoSprints = [];
                for (let i = 0; i < 2; i++) {
                    const num = sprintNumber + i;
                    const sprintStartDays = (num - 1) * sprintDurationDays;
                    const sMs = startMs + sprintStartDays * 86400000;
                    const eMs = sMs + (sprintDurationDays - 1) * 86400000;
                    const name = `Sprint #${num}`;

                    const existing = (await req.db.query('SELECT id FROM sprints WHERE team_id = $1 AND name = $2', [req.userTeamId, name])).rows[0];
                    if (!existing) {
                        const result = await req.db.query(
                            'INSERT INTO sprints (team_id, name, start_date, end_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                            [req.userTeamId, name, fmt(sMs), fmt(eMs), i === 0 ? 'active' : 'planned']
                        );
                        autoSprints.push({ id: result.rows[0].id, name, start_date: fmt(sMs), end_date: fmt(eMs), status: i === 0 ? 'active' : 'planned', goal: null });
                    } else {
                        const sprint = (await req.db.query('SELECT id, name, start_date, end_date, status, goal FROM sprints WHERE id = $1', [existing.id])).rows[0];
                        autoSprints.push(sprint);
                    }
                }
                return res.json(autoSprints);
            }
        }

        res.json(sprints);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching available sprints:');
        res.status(500).json({ error: 'Failed to fetch sprints' });
    }
});

// ─── Assign task to sprint ────────────────────────────────────────────────
router.patch('/:id/assign-sprint', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;
        const { sprint_id } = req.body;

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        if (sprint_id === null || sprint_id === undefined || sprint_id === '') {
            const oldSprint = task.sprint_id ? (await req.db.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            await req.db.query('UPDATE tasks SET sprint_id = NULL WHERE id = $1', [id]);
            await logHistory(id, req.userId, 'updated', 'sprint', oldSprint?.name || 'none', 'none', null, req.db);
        } else {
            const sprint = (await req.db.query('SELECT id, team_id, name, end_date FROM sprints WHERE id = $1', [sprint_id])).rows[0];
            if (!sprint || sprint.team_id !== req.userTeamId) {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
            const oldSprint = task.sprint_id ? (await req.db.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            if (task.due_date !== sprint.end_date) {
                await logHistory(id, req.userId, 'updated', 'due_date', task.due_date, sprint.end_date, null, req.db);
            }
            await req.db.query('UPDATE tasks SET sprint_id = $1, due_date = $2 WHERE id = $3', [sprint.id, sprint.end_date, id]);
            await logHistory(id, req.userId, 'updated', 'sprint', oldSprint?.name || 'none', sprint.name, null, req.db);
        }

        const updated = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);
        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error assigning sprint:');
        res.status(500).json({ error: 'Failed to assign sprint' });
    }
});

// ─── Get comments for a task ──────────────────────────────────────────────
router.get('/:id/comments', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        const comments = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = $1
            ORDER BY tc.created_at ASC
        `, [req.params.id])).rows;

        res.json(comments);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching comments:');
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// ─── Add comment ──────────────────────────────────────────────────────────
router.post('/:id/comments', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (content.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or less' });

        const result = await req.db.query(
            'INSERT INTO task_comments (task_id, user_id, content) VALUES ($1, $2, $3) RETURNING id',
            [req.params.id, req.userId, content.trim()]
        );
        await logHistory(req.params.id, req.userId, 'comment_added', null, null, null, null, req.db);

        const comment = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.id = $1
        `, [result.rows[0].id])).rows[0];

        try {
            const mentionRegex = /data-user-id="(\d+)"/g;
            const mentionedIds = new Set();
            let m;
            while ((m = mentionRegex.exec(content)) !== null) {
                const uid = parseInt(m[1]);
                if (uid !== req.userId) mentionedIds.add(uid);
            }
            if (mentionedIds.size > 0) {
                const commenter = (await req.db.query('SELECT username, full_name FROM users WHERE id = $1', [req.userId])).rows[0];
                const commenterName = commenter?.full_name || commenter?.username || 'Someone';
                const orgMentionRows = req.userOrgId
                    ? (await req.db.query(
                        'SELECT id FROM users WHERE id = ANY($1) AND org_id = $2 AND is_active = TRUE',
                        [[...mentionedIds], req.userOrgId]
                    )).rows
                    : [];

                for (const row of orgMentionRows) {
                    const uid = row.id;
                    if (!await canAccessTask(task, uid, req.userOrgId, req.db)) continue;
                    await req.db.query(
                        'INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5)',
                        [uid, 'mention', `${commenterName} mentioned you`, `In task: ${task.title}`, task.id]
                    );
                    // Email + WS notification for mention
                    const mentioned = (await req.db.query('SELECT email, full_name FROM users WHERE id = $1', [uid])).rows[0];
                    if (mentioned) {
                        notifyByEmail('mention', mentioned, commenterName, task.title);
                        sendToUser(req.tenantId, uid, 'notification', { type: 'mention', title: `${commenterName} mentioned you`, body: `In task: ${task.title}` });
                    }
                }
            }
        } catch (mentionErr) {
            req.log.error({ err: mentionErr }, 'Mention notification error:');
        }

        res.json(comment);
    } catch (err) {
        req.log.error({ err: err }, 'Error adding comment:');
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// ─── Edit comment (author only) ───────────────────────────────────────────
router.put('/:id/comments/:commentId', auth, async (req, res) => {
    try {
        const comment = (await req.db.query('SELECT * FROM task_comments WHERE id = $1 AND task_id = $2', [req.params.commentId, req.params.id])).rows[0];
        if (!comment || comment.user_id !== req.userId) return res.status(404).json({ error: 'Comment not found' });

        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (content.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or less' });

        await req.db.query('UPDATE task_comments SET content = $1, updated_at = $2 WHERE id = $3',
            [content.trim(), new Date().toISOString(), req.params.commentId]);

        const updated = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.id = $1
        `, [req.params.commentId])).rows[0];

        res.json(updated);
    } catch (err) {
        req.log.error({ err: err }, 'Error updating comment:');
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// ─── Delete comment (author or task creator) ──────────────────────────────
router.delete('/:id/comments/:commentId', auth, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        const comment = (await req.db.query('SELECT * FROM task_comments WHERE id = $1 AND task_id = $2', [req.params.commentId, req.params.id])).rows[0];
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.user_id !== req.userId && (!task || task.user_id !== req.userId)) {
            return res.status(403).json({ error: 'Cannot delete this comment' });
        }

        await req.db.query('DELETE FROM task_comments WHERE id = $1', [req.params.commentId]);
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        req.log.error({ err: err }, 'Error deleting comment:');
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// ─── Backlog: Get all backlog items ───────────────────────────────────────
router.get('/backlog', auth, loadUserContext, async (req, res) => {
    try {
        const { assignee, label, priority, status, search } = req.query;

        const conditions = ['t.date IS NULL', 't.sprint_id IS NULL'];
        const params = [];
        let pi = 1;

        if (req.userOrgId) {
            conditions.push(`t.org_id = $${pi++}`);
            params.push(req.userOrgId);
        } else {
            conditions.push('t.org_id IS NULL');
        }

        if (req.userTeamId) {
            conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi} OR t.user_id IN (SELECT id FROM users WHERE team_id = $${pi + 1}))`);
            params.push(req.userId, req.userTeamId);
            pi += 2;
        } else {
            conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi})`);
            params.push(req.userId);
            pi++;
        }

        if (assignee) {
            if (assignee === 'me') {
                conditions.push(`(t.user_id = $${pi} OR t.assigned_to = $${pi})`);
                params.push(req.userId);
                pi++;
            } else {
                const assigneeId = parseInt(assignee, 10);
                conditions.push(`(t.assigned_to = $${pi} OR (t.user_id = $${pi} AND t.assigned_to IS NULL))`);
                params.push(assigneeId);
                pi++;
            }
        }

        if (priority && ['low', 'medium', 'high'].includes(priority)) {
            conditions.push(`t.priority = $${pi++}`);
            params.push(priority);
        }

        if (status && ['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            conditions.push(`t.status = $${pi++}`);
            params.push(status);
        }

        if (search && search.trim()) {
            const escaped = search.trim().replace(/[%_]/g, c => `\\${c}`);
            conditions.push(`(t.title ILIKE $${pi} OR t.description ILIKE $${pi})`);
            params.push(`%${escaped}%`);
            pi++;
        }

        let tasks = (await req.db.query(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY
                CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                t.created_at DESC
        `, params)).rows;

        if (label) {
            const labelId = parseInt(label, 10);
            const taskIdsWithLabel = new Set(
                (await req.db.query('SELECT task_id FROM task_label_map WHERE label_id = $1', [labelId])).rows.map(r => r.task_id)
            );
            tasks = tasks.filter(t => taskIdsWithLabel.has(t.id));
        }

        const enriched = await enrichTasks(tasks, req.db);
        const summary = { total: enriched.length, byStatus: {}, byPriority: { high: 0, medium: 0, low: 0 } };
        for (const col of ['pending', 'in_progress', 'in_review', 'done']) summary.byStatus[col] = 0;
        for (const t of enriched) {
            if (summary.byStatus[t.status] !== undefined) summary.byStatus[t.status]++;
            if (summary.byPriority[t.priority] !== undefined) summary.byPriority[t.priority]++;
        }

        res.json({ tasks: enriched, summary });
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching backlog:');
        res.status(500).json({ error: 'Failed to fetch backlog' });
    }
});

// ─── Backlog: Create a backlog item (no date) ─────────────────────────────
router.post('/backlog', auth, loadUserContext, async (req, res) => {
    try {
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'Task title is required' });
        if (title.trim().length > 200) return res.status(400).json({ error: 'Task title must be 200 characters or less' });
        if (description && description.length > 5000) return res.status(400).json({ error: 'Task description must be 5000 characters or less' });

        const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

        let assignedTo = null;
        if (assigned_to) {
            const targetUser = (await req.db.query('SELECT id, org_id, is_active FROM users WHERE id = $1', [assigned_to])).rows[0];
            if (!targetUser || !targetUser.is_active) return res.status(400).json({ error: 'Assigned user not found or inactive' });
            if (targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
            }
            assignedTo = assigned_to;
        }

        let validDueDate = null;
        if (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) validDueDate = due_date;

        let validSprintId = null;
        if (sprint_id) {
            const sprint = (await req.db.query('SELECT id, team_id, end_date FROM sprints WHERE id = $1', [sprint_id])).rows[0];
            if (sprint && sprint.team_id === req.userTeamId) {
                validSprintId = sprint.id;
                if (!validDueDate) validDueDate = sprint.end_date;
            } else {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
        }

        const result = await req.db.query(
            'INSERT INTO tasks (user_id, date, title, description, priority, assigned_to, due_date, sprint_id, org_id) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [req.userId, title.trim(), description?.trim() || null, validPriority, assignedTo, validDueDate, validSprintId, req.userOrgId || null]
        );
        const taskId = result.rows[0].id;

        if (label_ids && Array.isArray(label_ids) && label_ids.length > 0) await syncLabels(taskId, label_ids, req.userOrgId, req.db);
        await logHistory(taskId, req.userId, 'created', null, null, null, null, req.db);

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
        const enriched = await enrichTasks([task], req.db);

        // Notify assigned user
        if (assignedTo && assignedTo !== req.userId) {
            const assignee = (await req.db.query('SELECT email, full_name FROM users WHERE id = $1', [assignedTo])).rows[0];
            const assigner = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
            if (assignee) {
                await req.db.query(
                    'INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5)',
                    [assignedTo, 'task', `Task Assigned: ${task.title}`, `${assigner?.full_name || 'Someone'} assigned you a task`, task.id]
                );
                notifyByEmail('taskAssigned', assignee, task, assigner?.full_name || 'Someone');
                sendToUser(req.tenantId, assignedTo, 'task_assigned', { taskId, title: task.title });
            }
        }

        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error creating backlog item:');
        res.status(500).json({ error: 'Failed to create backlog item' });
    }
});

// ─── Move backlog item to a specific date (schedule it) ───────────────────
router.patch('/:id/schedule', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;
        const { date } = req.body;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Valid date is required' });
        }

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        await req.db.query('UPDATE tasks SET date = $1 WHERE id = $2', [date, id]);
        await logHistory(id, req.userId, 'scheduled', 'date', task.date || 'backlog', date, null, req.db);

        const updated = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);
        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error scheduling task:');
        res.status(500).json({ error: 'Failed to schedule task' });
    }
});

// ─── Move a dated task back to backlog ────────────────────────────────────
router.patch('/:id/unschedule', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        await req.db.query('UPDATE tasks SET date = NULL WHERE id = $1', [id]);
        await logHistory(id, req.userId, 'unscheduled', 'date', task.date, 'backlog', null, req.db);

        const updated = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);
        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error unscheduling task:');
        res.status(500).json({ error: 'Failed to move task to backlog' });
    }
});

// ─── Get single task detail ───────────────────────────────────────────────
router.get('/:id/detail', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        const enriched = await enrichTasks([task], req.db);

        const comments = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = $1
            ORDER BY tc.created_at ASC
        `, [task.id])).rows;

        res.json({ ...enriched[0], comments });
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching task detail:');
        res.status(500).json({ error: 'Failed to fetch task detail' });
    }
});

// ─── Get task history ─────────────────────────────────────────────────────
router.get('/:id/history', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db)) return res.status(404).json({ error: 'Task not found' });

        const history = (await req.db.query(`
            SELECT th.*, u.username, u.full_name, u.avatar
            FROM task_history th
            JOIN users u ON u.id = th.user_id
            WHERE th.task_id = $1
            ORDER BY th.created_at DESC
        `, [req.params.id])).rows;

        res.json(history);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching task history:');
        res.status(500).json({ error: 'Failed to fetch task history' });
    }
});

module.exports = router;