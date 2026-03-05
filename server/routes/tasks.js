const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { getLocalToday } = require('../utils/timezone');

const router = express.Router();

// Helper: record task history
function logHistory(taskId, userId, action, field, oldValue, newValue) {
    db.prepare(
        'INSERT INTO task_history (task_id, user_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(taskId, userId, action, field || null, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null);
}

// Helper: get labels for a set of task IDs
function getLabelsForTasks(taskIds) {
    if (!taskIds.length) return {};
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT tlm.task_id, tl.id, tl.name, tl.color
        FROM task_label_map tlm
        JOIN task_labels tl ON tl.id = tlm.label_id
        WHERE tlm.task_id IN (${placeholders})
    `).all(...taskIds);
    const map = {};
    for (const r of rows) {
        if (!map[r.task_id]) map[r.task_id] = [];
        map[r.task_id].push({ id: r.id, name: r.name, color: r.color });
    }
    return map;
}

// Helper: get comment counts for a set of task IDs
function getCommentCounts(taskIds) {
    if (!taskIds.length) return {};
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT task_id, COUNT(*) as count FROM task_comments
        WHERE task_id IN (${placeholders})
        GROUP BY task_id
    `).all(...taskIds);
    const map = {};
    for (const r of rows) map[r.task_id] = r.count;
    return map;
}

// Helper: enrich tasks with assignee info, labels, comment counts
function enrichTasks(tasks) {
    const taskIds = tasks.map(t => t.id);
    const labelsMap = getLabelsForTasks(taskIds);
    const commentMap = getCommentCounts(taskIds);

    // Get assignee names
    const assigneeIds = [...new Set(tasks.map(t => t.assigned_to).filter(Boolean))];
    const assigneeMap = {};
    if (assigneeIds.length) {
        const ph = assigneeIds.map(() => '?').join(',');
        const users = db.prepare(`SELECT id, username, full_name, avatar FROM users WHERE id IN (${ph})`).all(...assigneeIds);
        for (const u of users) assigneeMap[u.id] = { username: u.username, full_name: u.full_name, avatar: u.avatar };
    }

    // Get creator names (for tasks assigned to others)
    const creatorIds = [...new Set(tasks.map(t => t.user_id))];
    const creatorMap = {};
    if (creatorIds.length) {
        const ph = creatorIds.map(() => '?').join(',');
        const users = db.prepare(`SELECT id, username, full_name FROM users WHERE id IN (${ph})`).all(...creatorIds);
        for (const u of users) creatorMap[u.id] = { username: u.username, full_name: u.full_name };
    }

    // Get sprint information
    const sprintIds = [...new Set(tasks.map(t => t.sprint_id).filter(Boolean))];
    const sprintMap = {};
    if (sprintIds.length) {
        const ph = sprintIds.map(() => '?').join(',');
        const sprints = db.prepare(`SELECT id, name, status, start_date, end_date FROM sprints WHERE id IN (${ph})`).all(...sprintIds);
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

// Helper: check if user can access task (creator, assignee, or same team)
function canAccessTask(task, userId) {
    if (!task) return false;
    if (task.user_id === userId || task.assigned_to === userId) return true;
    // Allow access if both users belong to the same team
    const user = db.prepare('SELECT team_id FROM users WHERE id = ?').get(userId);
    const owner = db.prepare('SELECT team_id FROM users WHERE id = ?').get(task.user_id);
    return user?.team_id && owner?.team_id && user.team_id === owner.team_id;
}

// Helper: sync labels for a task
function syncLabels(taskId, labelIds) {
    if (!labelIds || !Array.isArray(labelIds)) return;
    db.prepare('DELETE FROM task_label_map WHERE task_id = ?').run(taskId);
    const insert = db.prepare('INSERT OR IGNORE INTO task_label_map (task_id, label_id) VALUES (?, ?)');
    for (const lid of labelIds) {
        insert.run(taskId, lid);
    }
}

// ─── Get tasks for a specific date or date range ────────────────────────
router.get('/', auth, loadUserContext, (req, res) => {
    try {
        const { date, start_date, end_date, sprint_id, scope, include_due, assignee, label, priority, status, search } = req.query;

        // Build dynamic WHERE
        const conditions = [];
        const params = [];

        // Sprint mode: filter by sprint_id only — no date overlap
        if (sprint_id) {
            conditions.push('t.sprint_id = ?');
            params.push(parseInt(sprint_id, 10));
        } else if (start_date && end_date) {
            // Date range mode
            conditions.push('t.date >= ? AND t.date <= ?');
            params.push(start_date, end_date);
        } else if (date) {
            if (include_due === '1') {
                // My Day: only no-sprint tasks — dated today OR due today
                conditions.push('(t.sprint_id IS NULL AND (t.date = ? OR t.due_date = ?))');
                params.push(date, date);
            } else {
                // Single date mode
                conditions.push('t.date = ?');
                params.push(date);
            }
        } else {
            // Default to today
            const targetDate = getLocalToday(req);
            conditions.push('t.date = ?');
            params.push(targetDate);
        }

        // Scope filtering: 'personal' shows only user's own tasks
        if (scope === 'personal') {
            conditions.push('(t.user_id = ? OR t.assigned_to = ?)');
            params.push(req.userId, req.userId);
        } else {
            // Show tasks visible to user (created by, assigned to, or same team)
            if (req.userTeamId) {
                conditions.push('(t.user_id = ? OR t.assigned_to = ? OR t.user_id IN (SELECT id FROM users WHERE team_id = ?))');
                params.push(req.userId, req.userId, req.userTeamId);
            } else {
                conditions.push('(t.user_id = ? OR t.assigned_to = ?)');
                params.push(req.userId, req.userId);
            }
        }

        if (assignee) {
            if (assignee === 'me') {
                conditions.push('(t.user_id = ? OR t.assigned_to = ?)');
                params.push(req.userId, req.userId);
            } else {
                const assigneeId = parseInt(assignee, 10);
                conditions.push('(t.assigned_to = ? OR (t.user_id = ? AND t.assigned_to IS NULL))');
                params.push(assigneeId, assigneeId);
            }
        }

        if (priority && ['low', 'medium', 'high'].includes(priority)) {
            conditions.push('t.priority = ?');
            params.push(priority);
        }

        if (status && ['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            conditions.push('t.status = ?');
            params.push(status);
        }

        if (search && search.trim()) {
            conditions.push('(t.title LIKE ? OR t.description LIKE ?)');
            const term = `%${search.trim()}%`;
            params.push(term, term);
        }

        let tasks = db.prepare(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY
                CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                CASE t.status WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 WHEN 'pending' THEN 3 WHEN 'done' THEN 4 END,
                t.created_at ASC
        `).all(...params);

        // Filter by label if requested (post-query since it's a join table)
        if (label) {
            const labelId = parseInt(label, 10);
            const taskIdsWithLabel = new Set(
                db.prepare('SELECT task_id FROM task_label_map WHERE label_id = ?').all(labelId).map(r => r.task_id)
            );
            tasks = tasks.filter(t => taskIdsWithLabel.has(t.id));
        }

        const enriched = enrichTasks(tasks);
        const total = enriched.length;
        const done = enriched.filter(t => t.status === 'done').length;
        const inProgress = enriched.filter(t => t.status === 'in_progress').length;

        res.json({ tasks: enriched, stats: { total, done, inProgress, percent: total > 0 ? Math.round((done / total) * 100) : 0 } });
    } catch (err) {
        console.error('Error fetching tasks:', err.message);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// ─── Add a task ─────────────────────────────────────────────────────────
router.post('/', auth, loadUserContext, (req, res) => {
    try {
        const { title, description, priority, date, assigned_to, due_date, label_ids, sprint_id } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Task title is required' });
        }
        if (title.trim().length > 200) {
            return res.status(400).json({ error: 'Task title must be 200 characters or less' });
        }
        if (description && description.length > 5000) {
            return res.status(400).json({ error: 'Task description must be 5000 characters or less' });
        }

        const targetDate = date || getLocalToday(req);
        const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

        // Validate assigned_to user exists and is in same org
        let assignedTo = null;
        if (assigned_to) {
            const targetUser = db.prepare('SELECT id, org_id, is_active FROM users WHERE id = ?').get(assigned_to);
            if (!targetUser || !targetUser.is_active) {
                return res.status(400).json({ error: 'Assigned user not found or inactive' });
            }
            // Check same org (if both have orgs)
            if (req.userOrgId && targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
            }
            assignedTo = assigned_to;
        }

        // Validate due_date format
        let validDueDate = null;
        if (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
            validDueDate = due_date;
        }

        // Handle sprint_id assignment with auto due-date
        let validSprintId = null;
        if (sprint_id) {
            const sprint = db.prepare('SELECT id, team_id, end_date FROM sprints WHERE id = ?').get(sprint_id);
            if (sprint && sprint.team_id === req.userTeamId) {
                validSprintId = sprint.id;
                // Auto-set due date to sprint end date if not explicitly provided
                if (!validDueDate) {
                    validDueDate = sprint.end_date;
                }
            } else {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
        }

        const result = db.prepare(
            'INSERT INTO tasks (user_id, date, title, description, priority, assigned_to, due_date, sprint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(req.userId, targetDate, title.trim(), description?.trim() || null, validPriority, assignedTo, validDueDate, validSprintId);

        const taskId = result.lastInsertRowid;

        // Sync labels
        if (label_ids && Array.isArray(label_ids) && label_ids.length > 0) {
            syncLabels(taskId, label_ids);
        }

        logHistory(taskId, req.userId, 'created', null, null, null);

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        const enriched = enrichTasks([task]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error creating task:', err.message);
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// ─── Update task status ─────────────────────────────────────────────────
router.patch('/:id/status', auth, (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        const completedAt = status === 'done' ? new Date().toISOString() : null;
        db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id);

        if (task.status !== status) {
            logHistory(id, req.userId, 'status_change', 'status', task.status, status);
        }

        const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        const enriched = enrichTasks([updated]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error updating task status:', err.message);
        res.status(500).json({ error: 'Failed to update task status' });
    }
});

// ─── Update task details ────────────────────────────────────────────────
router.put('/:id', auth, loadUserContext, (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id } = req.body;

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        const newTitle = title?.trim() || task.title;
        const newDesc = description !== undefined ? (description?.trim() || null) : task.description;
        const newPriority = ['low', 'medium', 'high'].includes(priority) ? priority : task.priority;

        // Handle assigned_to update
        let newAssignedTo = task.assigned_to;
        if (assigned_to !== undefined) {
            if (assigned_to === null || assigned_to === '') {
                newAssignedTo = null;
            } else {
                const targetUser = db.prepare('SELECT id, org_id, is_active FROM users WHERE id = ?').get(assigned_to);
                if (!targetUser || !targetUser.is_active) {
                    return res.status(400).json({ error: 'Assigned user not found or inactive' });
                }
                if (req.userOrgId && targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                    return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
                }
                newAssignedTo = assigned_to;
            }
        }

        // Handle due_date update
        let newDueDate = task.due_date;
        if (due_date !== undefined) {
            newDueDate = (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) ? due_date : null;
        }

        // Handle sprint_id update
        let newSprintId = task.sprint_id;
        if (sprint_id !== undefined) {
            if (sprint_id === null || sprint_id === '') {
                newSprintId = null;
            } else {
                const sprint = db.prepare('SELECT id, team_id, end_date FROM sprints WHERE id = ?').get(sprint_id);
                if (sprint && sprint.team_id === req.userTeamId) {
                    newSprintId = sprint_id;
                    // Always override due date with sprint end date
                    newDueDate = sprint.end_date;
                } else {
                    return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
                }
            }
        }

        db.prepare('UPDATE tasks SET title = ?, description = ?, priority = ?, assigned_to = ?, due_date = ?, sprint_id = ? WHERE id = ?')
            .run(newTitle, newDesc, newPriority, newAssignedTo, newDueDate, newSprintId, id);

        // Log changes to history
        if (newTitle !== task.title) logHistory(id, req.userId, 'updated', 'title', task.title, newTitle);
        if (newDesc !== task.description) logHistory(id, req.userId, 'updated', 'description', task.description ? 'changed' : null, newDesc ? 'changed' : null);
        if (newPriority !== task.priority) logHistory(id, req.userId, 'updated', 'priority', task.priority, newPriority);
        if (String(newAssignedTo || '') !== String(task.assigned_to || '')) {
            const oldName = task.assigned_to ? (db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(task.assigned_to)?.full_name || 'someone') : 'unassigned';
            const newName = newAssignedTo ? (db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(newAssignedTo)?.full_name || 'someone') : 'unassigned';
            logHistory(id, req.userId, 'updated', 'assigned_to', oldName, newName);
        }
        if (newDueDate !== task.due_date) logHistory(id, req.userId, 'updated', 'due_date', task.due_date, newDueDate);
        if (String(newSprintId || '') !== String(task.sprint_id || '')) {
            const oldSprint = task.sprint_id ? (db.prepare('SELECT name FROM sprints WHERE id = ?').get(task.sprint_id)?.name || 'unknown') : 'none';
            const newSprint = newSprintId ? (db.prepare('SELECT name FROM sprints WHERE id = ?').get(newSprintId)?.name || 'unknown') : 'none';
            logHistory(id, req.userId, 'updated', 'sprint', oldSprint, newSprint);
        }

        // Sync labels if provided and log changes
        if (label_ids !== undefined) {
            const oldLabelRows = db.prepare('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = ? ORDER BY tl.name').all(id);
            const oldLabelNames = oldLabelRows.map(r => r.name);
            syncLabels(id, label_ids || []);
            const newLabelRows = db.prepare('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = ? ORDER BY tl.name').all(id);
            const newLabelNames = newLabelRows.map(r => r.name);
            if (JSON.stringify(oldLabelNames) !== JSON.stringify(newLabelNames)) {
                logHistory(id, req.userId, 'updated', 'labels', oldLabelNames.join(', ') || 'none', newLabelNames.join(', ') || 'none');
            }
        }

        const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        const enriched = enrichTasks([updated]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error updating task:', err.message);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// ─── Delete a task (only creator can delete) ────────────────────────────
router.delete('/:id', auth, (req, res) => {
    try {
        const { id } = req.params;
        const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.userId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        logHistory(id, req.userId, 'deleted', null, task.title, null);
        db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        res.json({ message: 'Task deleted' });
    } catch (err) {
        console.error('Error deleting task:', err.message);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

// ─── Carry-forward incomplete tasks ─────────────────────────────────────
router.post('/carry-forward', auth, (req, res) => {
    try {
        const today = getLocalToday(req);

        // Find the most recent previous day that has tasks (up to 7 days back)
        const lastTaskDay = db.prepare(`
            SELECT date FROM tasks
            WHERE (user_id = ? OR assigned_to = ?) AND date < ? AND date >= date(?, '-7 days')
            ORDER BY date DESC LIMIT 1
        `).get(req.userId, req.userId, today, today);

        if (!lastTaskDay) {
            return res.json({ message: 'No tasks to carry forward', carried: 0 });
        }

        const incomplete = db.prepare(`
            SELECT title, description, priority, assigned_to, due_date FROM tasks
            WHERE (user_id = ? OR assigned_to = ?) AND date = ? AND status != 'done'
        `).all(req.userId, req.userId, lastTaskDay.date);

        if (incomplete.length === 0) {
            return res.json({ message: 'No tasks to carry forward', carried: 0 });
        }

        const insert = db.prepare(
            'INSERT INTO tasks (user_id, date, title, description, priority, assigned_to, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const getLabelIds = db.prepare('SELECT label_id FROM task_label_map WHERE task_id = ?');
        const insertLabelMap = db.prepare('INSERT OR IGNORE INTO task_label_map (task_id, label_id) VALUES (?, ?)');

        const tx = db.transaction(() => {
            let carried = 0;
            for (const t of incomplete) {
                // Skip if a task with same title already exists today for this user
                const exists = db.prepare('SELECT id FROM tasks WHERE (user_id = ? OR assigned_to = ?) AND date = ? AND title = ?')
                    .get(req.userId, req.userId, today, t.title);
                if (!exists) {
                    // Bump overdue due_date to today
                    const dueDate = t.due_date && t.due_date < today ? today : t.due_date;
                    const result = insert.run(req.userId, today, t.title, t.description, t.priority, t.assigned_to, dueDate);
                    const newTaskId = result.lastInsertRowid;
                    // Carry forward labels from original task
                    const origTask = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND date = ? AND title = ?')
                        .get(req.userId, lastTaskDay.date, t.title);
                    if (origTask) {
                        const origLabels = getLabelIds.all(origTask.id);
                        for (const lbl of origLabels) {
                            insertLabelMap.run(newTaskId, lbl.label_id);
                        }
                    }
                    logHistory(newTaskId, req.userId, 'created', 'date', lastTaskDay.date, today);
                    carried++;
                }
            }
            return carried;
        });

        const carried = tx();
        res.json({ message: `${carried} task(s) carried forward`, carried });
    } catch (err) {
        console.error('Error carrying forward tasks:', err.message);
        res.status(500).json({ error: 'Failed to carry forward tasks' });
    }
});

// ─── Global search across all dates + backlog ──────────────────────────
router.get('/search', auth, loadUserContext, (req, res) => {
    try {
        const { q } = req.query;
        if (!q || !q.trim() || q.trim().length < 2) {
            return res.json([]);
        }

        const term = `%${q.trim()}%`;
        const conditions = ['(t.title LIKE ? OR t.description LIKE ?)'];
        const params = [term, term];

        // Restrict to tasks the user can see
        if (req.userOrgId) {
            conditions.push('(t.user_id = ? OR t.assigned_to = ? OR t.user_id IN (SELECT id FROM users WHERE org_id = ?))');
            params.push(req.userId, req.userId, req.userOrgId);
        } else {
            conditions.push('(t.user_id = ? OR t.assigned_to = ?)');
            params.push(req.userId, req.userId);
        }

        const tasks = db.prepare(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.created_at DESC
            LIMIT 20
        `).all(...params);

        const enriched = enrichTasks(tasks);
        res.json(enriched);
    } catch (err) {
        console.error('Error in global search:', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// ─── Get assignable users (same org) ────────────────────────────────────
router.get('/assignable-users', auth, loadUserContext, (req, res) => {
    try {
        let users;
        if (req.userOrgId) {
            users = db.prepare(
                'SELECT id, username, full_name, avatar FROM users WHERE org_id = ? AND is_active = 1 ORDER BY full_name ASC'
            ).all(req.userOrgId);
        } else {
            // No org — only return self
            users = db.prepare('SELECT id, username, full_name, avatar FROM users WHERE id = ?').all(req.userId);
        }
        res.json(users);
    } catch (err) {
        console.error('Error fetching assignable users:', err.message);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ─── Get labels for current user's org ──────────────────────────────────
router.get('/labels', auth, loadUserContext, (req, res) => {
    try {
        let labels = [];
        if (req.userOrgId) {
            labels = db.prepare('SELECT id, name, color FROM task_labels WHERE org_id = ? ORDER BY name ASC').all(req.userOrgId);
        }
        res.json(labels);
    } catch (err) {
        console.error('Error fetching labels:', err.message);
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
});

// ─── Get available sprints for user's team (current + future) ───────────
router.get('/available-sprints', auth, loadUserContext, (req, res) => {
    try {
        if (!req.userTeamId) {
            return res.json([]);
        }

        // Get sprints that are active or planned (not completed) for user's team
        const sprints = db.prepare(`
            SELECT id, name, start_date, end_date, status, goal
            FROM sprints
            WHERE team_id = ? AND status IN ('active', 'planned')
            ORDER BY start_date ASC
        `).all(req.userTeamId);

        // Also include auto-calculated sprint from team config if no explicit sprints exist
        if (sprints.length === 0) {
            const team = db.prepare('SELECT sprint_start_date, sprint_duration_weeks FROM teams WHERE id = ?').get(req.userTeamId);
            if (team?.sprint_start_date) {
                // Calculate current and next sprint from team config
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

                // Auto-create current sprint if it doesn't exist
                const autoSprints = [];
                for (let i = 0; i < 2; i++) {
                    const num = sprintNumber + i;
                    const sprintStartDays = (num - 1) * sprintDurationDays;
                    const sMs = startMs + sprintStartDays * 86400000;
                    const eMs = sMs + (sprintDurationDays - 1) * 86400000;
                    const name = `Sprint #${num}`;

                    // Check if this sprint already exists in DB
                    let existing = db.prepare('SELECT id FROM sprints WHERE team_id = ? AND name = ?').get(req.userTeamId, name);
                    if (!existing) {
                        const result = db.prepare(
                            'INSERT INTO sprints (team_id, name, start_date, end_date, status) VALUES (?, ?, ?, ?, ?)'
                        ).run(req.userTeamId, name, fmt(sMs), fmt(eMs), i === 0 ? 'active' : 'planned');
                        autoSprints.push({
                            id: result.lastInsertRowid,
                            name,
                            start_date: fmt(sMs),
                            end_date: fmt(eMs),
                            status: i === 0 ? 'active' : 'planned',
                            goal: null
                        });
                    } else {
                        const sprint = db.prepare('SELECT id, name, start_date, end_date, status, goal FROM sprints WHERE id = ?').get(existing.id);
                        autoSprints.push(sprint);
                    }
                }
                return res.json(autoSprints);
            }
        }

        res.json(sprints);
    } catch (err) {
        console.error('Error fetching available sprints:', err.message);
        res.status(500).json({ error: 'Failed to fetch sprints' });
    }
});

// ─── Assign task to sprint ──────────────────────────────────────────────
router.patch('/:id/assign-sprint', auth, loadUserContext, (req, res) => {
    try {
        const { id } = req.params;
        const { sprint_id } = req.body;

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        if (sprint_id === null || sprint_id === undefined || sprint_id === '') {
            // Remove from sprint
            const oldSprint = task.sprint_id ? (db.prepare('SELECT name FROM sprints WHERE id = ?').get(task.sprint_id)?.name || 'unknown') : 'none';
            db.prepare('UPDATE tasks SET sprint_id = NULL WHERE id = ?').run(id);
            logHistory(id, req.userId, 'updated', 'sprint', oldSprint, 'none');
        } else {
            const sprint = db.prepare('SELECT id, team_id, name, end_date FROM sprints WHERE id = ?').get(sprint_id);
            if (!sprint || sprint.team_id !== req.userTeamId) {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }

            const oldSprint = task.sprint_id ? (db.prepare('SELECT name FROM sprints WHERE id = ?').get(task.sprint_id)?.name || 'unknown') : 'none';

            // Always set due date to sprint end date when assigning a sprint
            const updates = ['sprint_id = ?', 'due_date = ?'];
            const updateParams = [sprint.id, sprint.end_date];
            if (task.due_date !== sprint.end_date) {
                logHistory(id, req.userId, 'updated', 'due_date', task.due_date, sprint.end_date);
            }
            updateParams.push(id);
            db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...updateParams);
            logHistory(id, req.userId, 'updated', 'sprint', oldSprint, sprint.name);
        }

        const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        const enriched = enrichTasks([updated]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error assigning sprint:', err.message);
        res.status(500).json({ error: 'Failed to assign sprint' });
    }
});

// ─── Comments ───────────────────────────────────────────────────────────

// Get comments for a task
router.get('/:id/comments', auth, (req, res) => {
    try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        const comments = db.prepare(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = ?
            ORDER BY tc.created_at ASC
        `).all(req.params.id);

        res.json(comments);
    } catch (err) {
        console.error('Error fetching comments:', err.message);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// Add comment
router.post('/:id/comments', auth, (req, res) => {
    try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (content.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or less' });

        const result = db.prepare(
            'INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)'
        ).run(req.params.id, req.userId, content.trim());

        logHistory(req.params.id, req.userId, 'comment_added', null, null, null);

        const comment = db.prepare(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.id = ?
        `).get(result.lastInsertRowid);

        res.json(comment);
    } catch (err) {
        console.error('Error adding comment:', err.message);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// Edit comment (author only)
router.put('/:id/comments/:commentId', auth, (req, res) => {
    try {
        const comment = db.prepare('SELECT * FROM task_comments WHERE id = ? AND task_id = ?').get(req.params.commentId, req.params.id);
        if (!comment || comment.user_id !== req.userId) return res.status(404).json({ error: 'Comment not found' });

        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (content.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or less' });

        db.prepare('UPDATE task_comments SET content = ?, updated_at = ? WHERE id = ?')
            .run(content.trim(), new Date().toISOString(), req.params.commentId);

        const updated = db.prepare(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.id = ?
        `).get(req.params.commentId);

        res.json(updated);
    } catch (err) {
        console.error('Error updating comment:', err.message);
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// Delete comment (author or task creator)
router.delete('/:id/comments/:commentId', auth, (req, res) => {
    try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        const comment = db.prepare('SELECT * FROM task_comments WHERE id = ? AND task_id = ?').get(req.params.commentId, req.params.id);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.user_id !== req.userId && (!task || task.user_id !== req.userId)) {
            return res.status(403).json({ error: 'Cannot delete this comment' });
        }

        db.prepare('DELETE FROM task_comments WHERE id = ?').run(req.params.commentId);
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        console.error('Error deleting comment:', err.message);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// ─── Backlog: Get all backlog items (date IS NULL) ──────────────────────
router.get('/backlog', auth, loadUserContext, (req, res) => {
    try {
        const { assignee, label, priority, status, search } = req.query;

        const conditions = ['t.sprint_id IS NULL'];
        const params = [];

        // Show backlog tasks visible to user (created by or assigned to, or same team)
        if (req.userTeamId) {
            conditions.push('(t.user_id = ? OR t.assigned_to = ? OR t.user_id IN (SELECT id FROM users WHERE team_id = ?))');
            params.push(req.userId, req.userId, req.userTeamId);
        } else {
            conditions.push('(t.user_id = ? OR t.assigned_to = ?)');
            params.push(req.userId, req.userId);
        }

        if (assignee) {
            if (assignee === 'me') {
                conditions.push('(t.user_id = ? OR t.assigned_to = ?)');
                params.push(req.userId, req.userId);
            } else {
                const assigneeId = parseInt(assignee, 10);
                conditions.push('(t.assigned_to = ? OR (t.user_id = ? AND t.assigned_to IS NULL))');
                params.push(assigneeId, assigneeId);
            }
        }

        if (priority && ['low', 'medium', 'high'].includes(priority)) {
            conditions.push('t.priority = ?');
            params.push(priority);
        }

        if (status && ['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            conditions.push('t.status = ?');
            params.push(status);
        }

        if (search && search.trim()) {
            conditions.push('(t.title LIKE ? OR t.description LIKE ?)');
            const term = `%${search.trim()}%`;
            params.push(term, term);
        }

        let tasks = db.prepare(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY
                CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                t.created_at DESC
        `).all(...params);

        // Filter by label if requested
        if (label) {
            const labelId = parseInt(label, 10);
            const taskIdsWithLabel = new Set(
                db.prepare('SELECT task_id FROM task_label_map WHERE label_id = ?').all(labelId).map(r => r.task_id)
            );
            tasks = tasks.filter(t => taskIdsWithLabel.has(t.id));
        }

        const enriched = enrichTasks(tasks);

        // Compute backlog summary stats
        const summary = {
            total: enriched.length,
            byStatus: {},
            byPriority: { high: 0, medium: 0, low: 0 },
        };
        for (const col of ['pending', 'in_progress', 'in_review', 'done']) {
            summary.byStatus[col] = 0;
        }
        for (const t of enriched) {
            if (summary.byStatus[t.status] !== undefined) summary.byStatus[t.status]++;
            if (summary.byPriority[t.priority] !== undefined) summary.byPriority[t.priority]++;
        }

        res.json({ tasks: enriched, summary });
    } catch (err) {
        console.error('Error fetching backlog:', err.message);
        res.status(500).json({ error: 'Failed to fetch backlog' });
    }
});

// ─── Backlog: Create a backlog item (no date) ───────────────────────────
router.post('/backlog', auth, loadUserContext, (req, res) => {
    try {
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Task title is required' });
        }
        if (title.trim().length > 200) {
            return res.status(400).json({ error: 'Task title must be 200 characters or less' });
        }
        if (description && description.length > 5000) {
            return res.status(400).json({ error: 'Task description must be 5000 characters or less' });
        }

        const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

        let assignedTo = null;
        if (assigned_to) {
            const targetUser = db.prepare('SELECT id, org_id, is_active FROM users WHERE id = ?').get(assigned_to);
            if (!targetUser || !targetUser.is_active) {
                return res.status(400).json({ error: 'Assigned user not found or inactive' });
            }
            if (req.userOrgId && targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
            }
            assignedTo = assigned_to;
        }

        let validDueDate = null;
        if (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
            validDueDate = due_date;
        }

        // Handle sprint_id assignment with auto due-date
        let validSprintId = null;
        if (sprint_id) {
            const sprint = db.prepare('SELECT id, team_id, end_date FROM sprints WHERE id = ?').get(sprint_id);
            if (sprint && sprint.team_id === req.userTeamId) {
                validSprintId = sprint.id;
                if (!validDueDate) {
                    validDueDate = sprint.end_date;
                }
            } else {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
        }

        const result = db.prepare(
            'INSERT INTO tasks (user_id, date, title, description, priority, assigned_to, due_date, sprint_id) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)'
        ).run(req.userId, title.trim(), description?.trim() || null, validPriority, assignedTo, validDueDate, validSprintId);

        const taskId = result.lastInsertRowid;

        if (label_ids && Array.isArray(label_ids) && label_ids.length > 0) {
            syncLabels(taskId, label_ids);
        }

        logHistory(taskId, req.userId, 'created', null, null, null);

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        const enriched = enrichTasks([task]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error creating backlog item:', err.message);
        res.status(500).json({ error: 'Failed to create backlog item' });
    }
});

// ─── Move backlog item to a specific date (schedule it) ─────────────────
router.patch('/:id/schedule', auth, (req, res) => {
    try {
        const { id } = req.params;
        const { date } = req.body;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Valid date is required' });
        }

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        db.prepare('UPDATE tasks SET date = ? WHERE id = ?').run(date, id);
        logHistory(id, req.userId, 'scheduled', 'date', task.date || 'backlog', date);

        const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        const enriched = enrichTasks([updated]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error scheduling task:', err.message);
        res.status(500).json({ error: 'Failed to schedule task' });
    }
});

// ─── Move a dated task back to backlog ──────────────────────────────────
router.patch('/:id/unschedule', auth, (req, res) => {
    try {
        const { id } = req.params;

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        db.prepare('UPDATE tasks SET date = NULL WHERE id = ?').run(id);
        logHistory(id, req.userId, 'unscheduled', 'date', task.date, 'backlog');

        const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        const enriched = enrichTasks([updated]);
        res.json(enriched[0]);
    } catch (err) {
        console.error('Error unscheduling task:', err.message);
        res.status(500).json({ error: 'Failed to move task to backlog' });
    }
});

// ─── Get single task detail ─────────────────────────────────────────────
router.get('/:id/detail', auth, (req, res) => {
    try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        const enriched = enrichTasks([task]);

        // Also fetch comments
        const comments = db.prepare(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = ?
            ORDER BY tc.created_at ASC
        `).all(task.id);

        res.json({ ...enriched[0], comments });
    } catch (err) {
        console.error('Error fetching task detail:', err.message);
        res.status(500).json({ error: 'Failed to fetch task detail' });
    }
});

// ─── Get task history ───────────────────────────────────────────────────
router.get('/:id/history', auth, (req, res) => {
    try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (!canAccessTask(task, req.userId)) return res.status(404).json({ error: 'Task not found' });

        const history = db.prepare(`
            SELECT th.*, u.username, u.full_name, u.avatar
            FROM task_history th
            JOIN users u ON u.id = th.user_id
            WHERE th.task_id = ?
            ORDER BY th.created_at DESC
        `).all(req.params.id);

        res.json(history);
    } catch (err) {
        console.error('Error fetching task history:', err.message);
        res.status(500).json({ error: 'Failed to fetch task history' });
    }
});

module.exports = router;
