const express = require('express');
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
//
// Either `client` (a transaction connection) or `db` (a tenant-bound DB
// handle) must be supplied. The original implementation fell through to a
// bare `query` identifier as a "last resort", but that symbol is not
// imported anywhere in this module — so a missing context would throw a
// confusing `ReferenceError: query is not defined` instead of a clear
// validation error. Throw explicitly so the caller's missing argument is
// obvious in the stack trace.
async function logHistory(taskId, userId, action, field, oldValue, newValue, client, db) {
    let q;
    if (client) q = client.query.bind(client);
    else if (db && typeof db.query === 'function') q = db.query.bind(db);
    else throw new Error('logHistory: either client or db must be provided');
    await q(
        'INSERT INTO task_history (task_id, user_id, action, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
        [taskId, userId, action, field || null, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null]
    );
}

// ─── Agile helpers ──────────────────────────────────────────────────────────

function validateStoryPoints(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 9999) return null;
    return n;
}

/**
 * Resolve work_item_type_id for an org. Accepts either a numeric id or a key.
 * Returns the type row or null. Returns null if value is empty.
 */
async function resolveWorkItemType(value, orgId, db) {
    if (value === null || value === undefined || value === '') return null;
    if (!orgId) return null;
    const num = Number(value);
    let row;
    if (Number.isFinite(num) && Number.isInteger(num)) {
        row = (await db.query('SELECT * FROM work_item_types WHERE id = $1 AND org_id = $2 AND is_active = TRUE', [num, orgId])).rows[0];
    } else {
        row = (await db.query('SELECT * FROM work_item_types WHERE key = $1 AND org_id = $2 AND is_active = TRUE', [String(value), orgId])).rows[0];
    }
    return row || null;
}

/**
 * Resolve workflow_state by id or key, scoped to the org.
 */
async function resolveWorkflowState(value, orgId, db) {
    if (value === null || value === undefined || value === '') return null;
    if (!orgId) return null;
    const num = Number(value);
    let row;
    if (Number.isFinite(num) && Number.isInteger(num)) {
        row = (await db.query('SELECT * FROM workflow_states WHERE id = $1 AND org_id = $2 AND is_active = TRUE', [num, orgId])).rows[0];
    } else {
        row = (await db.query('SELECT * FROM workflow_states WHERE key = $1 AND org_id = $2 AND is_active = TRUE', [String(value), orgId])).rows[0];
    }
    return row || null;
}

/**
 * Get the org's initial workflow state (or first state by sort order). Used
 * when creating a task without an explicit workflow_state_id.
 */
async function getInitialWorkflowState(orgId, db) {
    if (!orgId) return null;
    let row = (await db.query(
        'SELECT * FROM workflow_states WHERE org_id = $1 AND is_active = TRUE AND is_initial = TRUE LIMIT 1',
        [orgId]
    )).rows[0];
    if (!row) {
        row = (await db.query(
            "SELECT * FROM workflow_states WHERE org_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, id ASC LIMIT 1",
            [orgId]
        )).rows[0];
    }
    return row || null;
}

/**
 * Get the org's default work item type, falling back to the first active type.
 */
async function getDefaultWorkItemType(orgId, db) {
    if (!orgId) return null;
    let row = (await db.query(
        'SELECT * FROM work_item_types WHERE org_id = $1 AND is_active = TRUE AND is_default = TRUE LIMIT 1',
        [orgId]
    )).rows[0];
    if (!row) {
        row = (await db.query(
            'SELECT * FROM work_item_types WHERE org_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, id ASC LIMIT 1',
            [orgId]
        )).rows[0];
    }
    return row || null;
}

/**
 * Validate and normalise an acceptance_criteria array.
 * Each item: { text, done, doneAt, doneBy }.
 */
function normalizeAcceptanceCriteria(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) return null;
    return value.slice(0, 50).map(it => {
        const text = String(it?.text || '').slice(0, 500);
        if (!text) return null;
        return {
            text,
            done: !!it?.done,
            doneAt: it?.doneAt || null,
            doneBy: it?.doneBy != null ? Number(it.doneBy) : null,
        };
    }).filter(Boolean);
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

    const [labelsMap, commentMap] = await Promise.all([
        getLabelsForTasks(taskIds, db),
        getCommentCounts(taskIds, db),
    ]);

    const assigneeIds = [...new Set(tasks.map(t => t.assigned_to).filter(Boolean))];
    const creatorIds = [...new Set(tasks.map(t => t.user_id))];
    const sprintIds = [...new Set(tasks.map(t => t.sprint_id).filter(Boolean))];
    const allUserIds = [...new Set([...assigneeIds, ...creatorIds])];

    const [userRows, sprintRows] = await Promise.all([
        allUserIds.length
            ? db.query('SELECT id, username, full_name, avatar FROM users WHERE id = ANY($1)', [allUserIds]).then(r => r.rows)
            : [],
        sprintIds.length
            ? db.query('SELECT id, name, status, start_date, end_date FROM sprints WHERE id = ANY($1)', [sprintIds]).then(r => r.rows)
            : [],
    ]);

    const userMap = {};
    for (const u of userRows) userMap[u.id] = u;
    const sprintMap = {};
    for (const s of sprintRows) sprintMap[s.id] = s;

    return tasks.map(t => ({
        ...t,
        labels: labelsMap[t.id] || [],
        comment_count: commentMap[t.id] || 0,
        assignee: t.assigned_to ? (userMap[t.assigned_to] ? { username: userMap[t.assigned_to].username, full_name: userMap[t.assigned_to].full_name, avatar: userMap[t.assigned_to].avatar } : null) : null,
        creator: userMap[t.user_id] ? { username: userMap[t.user_id].username, full_name: userMap[t.user_id].full_name } : null,
        sprint: t.sprint_id ? (sprintMap[t.sprint_id] || null) : null,
    }));
}

// Helper: check if user can access task within tenant boundary
async function canAccessTask(task, userId, requesterOrgId, db, requesterRole) {
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

    // Org-level admins can access any task within their org (needed for service-desk
    // tickets that get mirrored as backlog tasks for cross-team triage).
    if (requesterRole === 'super_admin' || requesterRole === 'hr_admin' || requesterRole === 'platform_admin') {
        return true;
    }

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
    const limitedIds = labelIds.slice(0, 20).map(lid => parseInt(lid, 10)).filter(n => !isNaN(n));
    await db.query('DELETE FROM task_label_map WHERE task_id = $1', [taskId]);
    if (limitedIds.length === 0) return;
    // Batch-validate labels belong to the same org
    const validLabels = orgId
        ? (await db.query('SELECT id FROM task_labels WHERE id = ANY($1) AND org_id = $2', [limitedIds, orgId])).rows
        : (await db.query('SELECT id FROM task_labels WHERE id = ANY($1) AND org_id IS NULL', [limitedIds])).rows;
    const validIds = validLabels.map(r => r.id);
    if (validIds.length > 0) {
        const values = validIds.map((lid, i) => `($1, $${i + 2})`).join(', ');
        await db.query(
            `INSERT INTO task_label_map (task_id, label_id) VALUES ${values} ON CONFLICT DO NOTHING`,
            [taskId, ...validIds]
        );
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
        } else if (req.userOrgId && (req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin')) {
            // Org-wide visibility for org admins (covers service desk tickets created by/for any team)
            // No additional creator/assignee constraint beyond the org filter already added above.
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
                // "My tasks" = tasks assigned to me, OR tasks I created that are still unassigned.
                // Tasks I created but reassigned to someone else should NOT appear under "me".
                conditions.push(`(t.assigned_to = $${pi} OR (t.user_id = $${pi} AND t.assigned_to IS NULL))`);
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

        if (label) {
            const labelId = parseInt(label, 10);
            if (!isNaN(labelId)) {
                conditions.push(`EXISTS (SELECT 1 FROM task_label_map tlm WHERE tlm.task_id = t.id AND tlm.label_id = $${pi++})`);
                params.push(labelId);
            }
        }

        if (search && search.trim()) {
            const escaped = search.trim().replace(/[%_]/g, c => `\\${c}`);
            conditions.push(`(t.title ILIKE $${pi} OR t.description ILIKE $${pi})`);
            params.push(`%${escaped}%`);
            pi++;
        }

        const tasks = (await req.db.query(`
            SELECT t.* FROM tasks t
            WHERE ${conditions.join(' AND ')}
            ORDER BY
                CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                CASE t.status WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 WHEN 'pending' THEN 3 WHEN 'done' THEN 4 END,
                t.created_at ASC
            LIMIT 500
        `, params)).rows;

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
        const { title, description, priority, date, assigned_to, due_date, label_ids, sprint_id,
            story_points, work_item_type_id, workflow_state_id, parent_task_id,
            acceptance_criteria, is_blocked, blocked_reason } = req.body;

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
            const isOrgAdmin = req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin';
            if (sprint && (sprint.team_id === req.userTeamId || isOrgAdmin)) {
                validSprintId = sprint.id;
                if (!validDueDate) validDueDate = sprint.end_date;
            } else {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
        }

        // Agile fields
        const sp = validateStoryPoints(story_points);
        const witRow = await resolveWorkItemType(work_item_type_id, req.userOrgId, req.db);
        const wsRow = await resolveWorkflowState(workflow_state_id, req.userOrgId, req.db);
        // Default work item type / workflow state when not supplied
        const witId = witRow ? witRow.id : (await getDefaultWorkItemType(req.userOrgId, req.db))?.id || null;
        const initialState = wsRow || (await getInitialWorkflowState(req.userOrgId, req.db));
        const wsId = initialState ? initialState.id : null;
        const statusKey = initialState ? initialState.key : 'pending';
        const ac = normalizeAcceptanceCriteria(acceptance_criteria);
        const isBlocked = !!is_blocked;
        const blockedReason = isBlocked ? (blocked_reason ? String(blocked_reason).slice(0, 500) : null) : null;
        let parentTaskId = null;
        if (parent_task_id) {
            const parentNum = parseInt(parent_task_id, 10);
            if (!isNaN(parentNum)) {
                const parent = (await req.db.query('SELECT id, org_id FROM tasks WHERE id = $1', [parentNum])).rows[0];
                if (parent && parent.org_id === req.userOrgId) parentTaskId = parent.id;
            }
        }

        const result = await req.db.query(
            `INSERT INTO tasks
                (user_id, date, title, description, priority, status, assigned_to, due_date,
                 sprint_id, org_id, story_points, work_item_type_id, workflow_state_id,
                 parent_task_id, acceptance_criteria, is_blocked, blocked_reason, lead_started_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
             RETURNING id`,
            [req.userId, targetDate, title.trim(), description?.trim() || null, validPriority,
                statusKey, assignedTo, validDueDate, validSprintId, req.userOrgId || null,
                sp, witId, wsId, parentTaskId, ac ? JSON.stringify(ac) : null, isBlocked, blockedReason]
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
//
// Status can be supplied as either:
//   - { status: <workflow_state.key> }   (legacy + tenants on default workflow)
//   - { workflow_state_id: <id> }        (new tenant-customisable workflow)
//
// We resolve to the matching workflow_states row in the requester's org and
// keep both `tasks.status` (key) and `tasks.workflow_state_id` (id) in sync.
// The is_terminal flag drives `completed_at`.
router.patch('/:id/status', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });
        const { status, workflow_state_id } = req.body;

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        // Resolve target workflow state. Accept either a numeric workflow_state_id
        // or a status key (back-compat with default 'pending'/'in_progress'/...).
        let target = await resolveWorkflowState(workflow_state_id, req.userOrgId, req.db);
        if (!target && status) target = await resolveWorkflowState(status, req.userOrgId, req.db);
        // Fallback: legacy hard-coded keys when the org has no workflow_states yet
        // (shouldn't happen post-seeding, but guards old tenants).
        if (!target && status && ['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            target = { id: null, key: status, is_terminal: status === 'done' };
        }
        if (!target) return res.status(400).json({ error: 'Invalid status / workflow state' });

        // ── Phase 3: WIP enforcement ────────────────────────────────────────
        // If the org has WIP limits enabled and the destination state has a
        // wip_limit, refuse the move when the column is already full. We don't
        // count the task itself if it's already in the target state.
        if (target.id) {
            const settingsRow = (await req.db.query(
                'SELECT enable_wip_limits FROM org_agile_settings WHERE org_id = $1',
                [req.userOrgId]
            )).rows[0];
            const stateRow = (await req.db.query(
                'SELECT wip_limit, name FROM workflow_states WHERE id = $1',
                [target.id]
            )).rows[0];
            if (settingsRow?.enable_wip_limits && stateRow?.wip_limit) {
                const occupancy = (await req.db.query(
                    `SELECT COUNT(*)::int AS c FROM tasks
                      WHERE workflow_state_id = $1 AND id != $2 AND org_id = $3`,
                    [target.id, id, req.userOrgId]
                )).rows[0].c;
                if (occupancy >= stateRow.wip_limit) {
                    return res.status(409).json({
                        error: `WIP limit reached for "${stateRow.name}" (${occupancy}/${stateRow.wip_limit}). ` +
                            `Move a ticket out of this column first.`,
                        code: 'WIP_EXCEEDED',
                        wip_limit: stateRow.wip_limit,
                        occupancy,
                    });
                }
            }
        }

        // ── Phase 3: cycle-time start marker ────────────────────────────────
        // Record the moment the task first transitions out of an "open" state
        // (i.e. work actually begins). This stamp is what we use later to
        // compute cycle time = completed_at - cycle_started_at.
        const completedAt = target.is_terminal ? new Date().toISOString() : null;
        let cycleStartedAtClause = '';
        const wasOpen = !task.cycle_started_at;
        const startsCycle = wasOpen && target.id && !target.is_terminal && target.key !== 'pending';
        if (startsCycle) cycleStartedAtClause = ', cycle_started_at = NOW()';

        await req.db.query(
            `UPDATE tasks SET status = $1, workflow_state_id = $2, completed_at = $3${cycleStartedAtClause}
              WHERE id = $4`,
            [target.key, target.id, completedAt, id]
        );

        if (task.status !== target.key) {
            await logHistory(id, req.userId, 'status_change', 'status', task.status, target.key, null, req.db);
        }

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
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id,
            story_points, work_item_type_id, workflow_state_id, parent_task_id,
            acceptance_criteria, is_blocked, blocked_reason } = req.body;

        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

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
                // Service desk tasks (linked via service_desk_ticket_id) can be assigned
                // to any active user in the tenant by org admins for cross-team resolution.
                const isServiceDeskTask = !!task.service_desk_ticket_id;
                const isOrgAdminUser = req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin';
                if (!isServiceDeskTask && targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                    return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
                }
                if (isServiceDeskTask && !isOrgAdminUser && targetUser.org_id && req.userOrgId !== targetUser.org_id) {
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
                const isOrgAdmin = req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin';
                if (sprint && (sprint.team_id === req.userTeamId || isOrgAdmin)) {
                    newSprintId = sprint_id;
                    newDueDate = sprint.end_date;
                } else {
                    return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
                }
            }
        }

        // Resolve agile fields (only update if explicitly supplied)
        let newStoryPoints = task.story_points;
        if (story_points !== undefined) {
            newStoryPoints = (story_points === null || story_points === '') ? null : validateStoryPoints(story_points);
        }
        let newWitId = task.work_item_type_id;
        let newWitRow = null;
        if (work_item_type_id !== undefined) {
            if (work_item_type_id === null || work_item_type_id === '') {
                newWitId = null;
            } else {
                newWitRow = await resolveWorkItemType(work_item_type_id, req.userOrgId, req.db);
                if (!newWitRow) return res.status(400).json({ error: 'Invalid work_item_type' });
                newWitId = newWitRow.id;
            }
        }
        let newWsId = task.workflow_state_id;
        let newStatusKey = task.status;
        let newCompletedAt = task.completed_at;
        let newWsRow = null;
        if (workflow_state_id !== undefined) {
            if (workflow_state_id === null || workflow_state_id === '') {
                // Reset to initial state for the org
                newWsRow = await getInitialWorkflowState(req.userOrgId, req.db);
            } else {
                newWsRow = await resolveWorkflowState(workflow_state_id, req.userOrgId, req.db);
                if (!newWsRow) return res.status(400).json({ error: 'Invalid workflow_state' });
            }
            newWsId = newWsRow ? newWsRow.id : null;
            newStatusKey = newWsRow ? newWsRow.key : task.status;
            newCompletedAt = newWsRow?.is_terminal ? new Date().toISOString() : null;
        }
        let newParentTaskId = task.parent_task_id;
        if (parent_task_id !== undefined) {
            if (parent_task_id === null || parent_task_id === '') {
                newParentTaskId = null;
            } else {
                const parentNum = parseInt(parent_task_id, 10);
                if (isNaN(parentNum) || parentNum === id) return res.status(400).json({ error: 'Invalid parent_task_id' });
                const parent = (await req.db.query('SELECT id, org_id FROM tasks WHERE id = $1', [parentNum])).rows[0];
                if (!parent || parent.org_id !== req.userOrgId) return res.status(400).json({ error: 'Parent task not found' });
                newParentTaskId = parent.id;
            }
        }
        let newAc = task.acceptance_criteria;
        if (acceptance_criteria !== undefined) {
            newAc = (acceptance_criteria === null) ? null : normalizeAcceptanceCriteria(acceptance_criteria);
        }
        let newIsBlocked = task.is_blocked;
        let newBlockedReason = task.blocked_reason;
        if (is_blocked !== undefined) {
            newIsBlocked = !!is_blocked;
            if (!newIsBlocked) newBlockedReason = null;
        }
        if (blocked_reason !== undefined) {
            newBlockedReason = blocked_reason ? String(blocked_reason).slice(0, 500) : null;
        }

        await req.db.query(
            `UPDATE tasks SET title = $1, description = $2, priority = $3, assigned_to = $4,
                due_date = $5, sprint_id = $6, story_points = $7, work_item_type_id = $8,
                workflow_state_id = $9, status = $10, completed_at = $11, parent_task_id = $12,
                acceptance_criteria = $13, is_blocked = $14, blocked_reason = $15
              WHERE id = $16`,
            [newTitle, newDesc, newPriority, newAssignedTo, newDueDate, newSprintId,
                newStoryPoints, newWitId, newWsId, newStatusKey, newCompletedAt, newParentTaskId,
                newAc !== null && newAc !== undefined ? JSON.stringify(newAc) : null,
                newIsBlocked, newBlockedReason, id]
        );

        if (newTitle !== task.title) await logHistory(id, req.userId, 'updated', 'title', task.title, newTitle, null, req.db);
        if (newDesc !== task.description) await logHistory(id, req.userId, 'updated', 'description', task.description ? task.description.slice(0, 100) : null, newDesc ? newDesc.slice(0, 100) : null, null, req.db);
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
        // Normalize for comparison: DB returns NUMERIC as a string like '8.00',
        // while newStoryPoints is a JS number (e.g. 8). A naive string compare
        // would mark every edit as a change. Compare numerically and treat
        // null/undefined as equal.
        const oldSpNum = task.story_points == null ? null : Number(task.story_points);
        const newSpNum = newStoryPoints == null ? null : Number(newStoryPoints);
        const spChanged = (oldSpNum === null) !== (newSpNum === null)
            || (oldSpNum !== null && newSpNum !== null && oldSpNum !== newSpNum);
        if (spChanged) {
            // Log normalised numeric values so the history reads "8 → 9" rather
            // than "8.00 → 9" (Postgres NUMERIC vs JS number formatting).
            await logHistory(id, req.userId, 'updated', 'story_points', oldSpNum, newSpNum, null, req.db);
        }
        if (String(newWitId ?? '') !== String(task.work_item_type_id ?? '')) {
            const oldWit = task.work_item_type_id ? (await req.db.query('SELECT name FROM work_item_types WHERE id = $1', [task.work_item_type_id])).rows[0] : null;
            const newWit = newWitId ? (newWitRow || (await req.db.query('SELECT name FROM work_item_types WHERE id = $1', [newWitId])).rows[0]) : null;
            await logHistory(id, req.userId, 'updated', 'work_item_type', oldWit?.name || 'none', newWit?.name || 'none', null, req.db);
        }
        if (String(newStatusKey || '') !== String(task.status || '')) {
            await logHistory(id, req.userId, 'status_change', 'status', task.status, newStatusKey, null, req.db);
        }
        if (String(newParentTaskId ?? '') !== String(task.parent_task_id ?? '')) {
            await logHistory(id, req.userId, 'updated', 'parent', task.parent_task_id || 'none', newParentTaskId || 'none', null, req.db);
        }
        if (!!newIsBlocked !== !!task.is_blocked) {
            await logHistory(id, req.userId, 'updated', 'is_blocked', String(task.is_blocked), String(newIsBlocked), null, req.db);
        }

        if (label_ids !== undefined) {
            const oldLabels = (await req.db.query('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = $1 ORDER BY tl.name', [id])).rows.map(r => r.name);
            await syncLabels(id, label_ids || [], req.userOrgId, req.db);
            const newLabels = (await req.db.query('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = $1 ORDER BY tl.name', [id])).rows.map(r => r.name);
            if (JSON.stringify(oldLabels) !== JSON.stringify(newLabels)) {
                await logHistory(id, req.userId, 'updated', 'labels', oldLabels.join(', ') || 'none', newLabels.join(', ') || 'none', null, req.db);
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
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (task.user_id !== req.userId) return res.status(403).json({ error: 'Only task creator can delete task' });
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

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
        const isOrgAdmin = req.userOrgId && (req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin');

        // ── Helper: figure out today's date in the caller's local timezone ──
        const getTodayStr = () => {
            const tzOffset = req.headers['x-timezone-offset'];
            if (tzOffset !== undefined) {
                const now = new Date();
                const localNow = new Date(now.getTime() - Number(tzOffset) * 60000);
                return localNow.toISOString().split('T')[0];
            }
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        };
        const fmt = (ms) => {
            const d = new Date(ms);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        };

        // ── Helper: ensure the current + next sprint exist for a team that has
        //    sprint_start_date / sprint_duration_weeks configured. Returns
        //    the materialised sprint rows (existing or newly inserted). ──
        const materialiseTeamSprints = async (team) => {
            if (!team?.sprint_start_date || !team.sprint_duration_weeks) return [];
            const todayStr = getTodayStr();
            const [sy, sm, sd] = team.sprint_start_date.split('-').map(Number);
            const [ty, tm, td] = todayStr.split('-').map(Number);
            const startMs = Date.UTC(sy, sm - 1, sd);
            const todayMs = Date.UTC(ty, tm - 1, td);
            const daysSinceStart = Math.floor((todayMs - startMs) / 86400000);
            const sprintDurationDays = team.sprint_duration_weeks * 7;
            const sprintNumber = daysSinceStart < 0 ? 1 : Math.floor(daysSinceStart / sprintDurationDays) + 1;

            const out = [];
            for (let i = 0; i < 2; i++) {
                const num = sprintNumber + i;
                const sprintStartDays = (num - 1) * sprintDurationDays;
                const sMs = startMs + sprintStartDays * 86400000;
                const eMs = sMs + (sprintDurationDays - 1) * 86400000;
                const name = `Sprint #${num}`;
                const existing = (await req.db.query(
                    'SELECT id, name, start_date, end_date, status, goal FROM sprints WHERE team_id = $1 AND name = $2',
                    [team.id, name]
                )).rows[0];
                if (existing) {
                    out.push(existing);
                } else {
                    const inserted = await req.db.query(
                        'INSERT INTO sprints (team_id, name, start_date, end_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, start_date, end_date, status, goal',
                        [team.id, name, fmt(sMs), fmt(eMs), i === 0 ? 'active' : 'planned']
                    );
                    out.push(inserted.rows[0]);
                }
            }
            return out;
        };

        // Org admins see every active/planned sprint across all teams in their org
        // (so they can move service-desk tickets into any team's sprint). For any
        // team in the org that has a sprint_start_date configured but no sprint
        // rows yet, auto-materialise the current + next sprint so admins don't
        // have to wait for a team member to visit the Tasks page first.
        if (isOrgAdmin) {
            // Auto-create sprints for every configured-but-empty team in the org
            const teamsNeedingSprints = (await req.db.query(`
                SELECT t.id, t.name, t.sprint_start_date, t.sprint_duration_weeks
                FROM teams t
                LEFT JOIN sprints s
                       ON s.team_id = t.id AND s.status IN ('active', 'planned')
                WHERE t.org_id = $1
                  AND t.sprint_start_date IS NOT NULL
                  AND s.id IS NULL
            `, [req.userOrgId])).rows;
            for (const team of teamsNeedingSprints) {
                try { await materialiseTeamSprints(team); }
                catch (e) { req.log.warn({ err: e, teamId: team.id }, 'Failed to auto-materialise sprints for team'); }
            }

            const orgSprints = (await req.db.query(`
                SELECT s.id, s.name, s.start_date, s.end_date, s.status, s.goal, s.team_id, t.name as team_name
                FROM sprints s
                JOIN teams t ON t.id = s.team_id
                WHERE t.org_id = $1 AND s.status IN ('active', 'planned')
                ORDER BY t.name ASC, s.start_date ASC
            `, [req.userOrgId])).rows;
            return res.json(orgSprints);
        }

        if (!req.userTeamId) return res.json([]);

        const sprints = (await req.db.query(`
            SELECT id, name, start_date, end_date, status, goal
            FROM sprints
            WHERE team_id = $1 AND status IN ('active', 'planned')
            ORDER BY start_date ASC
        `, [req.userTeamId])).rows;

        if (sprints.length === 0) {
            const team = (await req.db.query(
                'SELECT id, sprint_start_date, sprint_duration_weeks FROM teams WHERE id = $1',
                [req.userTeamId]
            )).rows[0];
            const autoSprints = await materialiseTeamSprints(team);
            return res.json(autoSprints);
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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        if (sprint_id === null || sprint_id === undefined || sprint_id === '') {
            const oldSprint = task.sprint_id ? (await req.db.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            await req.db.query('UPDATE tasks SET sprint_id = NULL WHERE id = $1', [id]);
            await logHistory(id, req.userId, 'updated', 'sprint', oldSprint?.name || 'none', 'none', null, req.db);
        } else {
            // Org admins can assign to any sprint within their org; others limited to own team.
            const isOrgAdmin = req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin';
            const sprint = isOrgAdmin
                ? (await req.db.query(
                    'SELECT s.id, s.team_id, s.name, s.end_date FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
                    [sprint_id, req.userOrgId]
                )).rows[0]
                : (await req.db.query('SELECT id, team_id, name, end_date FROM sprints WHERE id = $1', [sprint_id])).rows[0];
            if (!sprint || (!isOrgAdmin && sprint.team_id !== req.userTeamId)) {
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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        const comments = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = $1
            ORDER BY tc.created_at ASC
            LIMIT 200
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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

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
router.put('/:id/comments/:commentId', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!task || !(await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole))) {
            return res.status(404).json({ error: 'Task not found' });
        }
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
router.delete('/:id/comments/:commentId', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!task || !(await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole))) {
            return res.status(404).json({ error: 'Task not found' });
        }
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

        const isOrgAdmin = req.userOrgId && (req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin');
        if (isOrgAdmin) {
            // Org-wide backlog visibility (covers service desk tickets across teams)
        } else if (req.userTeamId) {
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
                // "My backlog" = tickets assigned to me, OR tickets I created that are still unassigned.
                // A ticket I created and reassigned to someone else should NOT show under "me".
                conditions.push(`(t.assigned_to = $${pi} OR (t.user_id = $${pi} AND t.assigned_to IS NULL))`);
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
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id,
            story_points, work_item_type_id, workflow_state_id, parent_task_id,
            acceptance_criteria, is_blocked, blocked_reason } = req.body;

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
            const isOrgAdmin = req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin';
            const sprint = isOrgAdmin
                ? (await req.db.query(
                    'SELECT s.id, s.team_id, s.end_date FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
                    [sprint_id, req.userOrgId]
                )).rows[0]
                : (await req.db.query('SELECT id, team_id, end_date FROM sprints WHERE id = $1', [sprint_id])).rows[0];
            if (sprint && (isOrgAdmin || sprint.team_id === req.userTeamId)) {
                validSprintId = sprint.id;
                if (!validDueDate) validDueDate = sprint.end_date;
            } else {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
        }

        // Agile fields
        const sp = validateStoryPoints(story_points);
        const witRow = await resolveWorkItemType(work_item_type_id, req.userOrgId, req.db);
        const wsRow = await resolveWorkflowState(workflow_state_id, req.userOrgId, req.db);
        const witId = witRow ? witRow.id : (await getDefaultWorkItemType(req.userOrgId, req.db))?.id || null;
        const initialState = wsRow || (await getInitialWorkflowState(req.userOrgId, req.db));
        const wsId = initialState ? initialState.id : null;
        const statusKey = initialState ? initialState.key : 'pending';
        const ac = normalizeAcceptanceCriteria(acceptance_criteria);
        const isBlocked = !!is_blocked;
        const blockedReason = isBlocked ? (blocked_reason ? String(blocked_reason).slice(0, 500) : null) : null;
        let parentTaskId = null;
        if (parent_task_id) {
            const parentNum = parseInt(parent_task_id, 10);
            if (!isNaN(parentNum)) {
                const parent = (await req.db.query('SELECT id, org_id FROM tasks WHERE id = $1', [parentNum])).rows[0];
                if (parent && parent.org_id === req.userOrgId) parentTaskId = parent.id;
            }
        }

        const result = await req.db.query(
            `INSERT INTO tasks
                (user_id, date, title, description, priority, status, assigned_to, due_date,
                 sprint_id, org_id, story_points, work_item_type_id, workflow_state_id,
                 parent_task_id, acceptance_criteria, is_blocked, blocked_reason, lead_started_at)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
             RETURNING id`,
            [req.userId, title.trim(), description?.trim() || null, validPriority, statusKey,
                assignedTo, validDueDate, validSprintId, req.userOrgId || null,
                sp, witId, wsId, parentTaskId, ac ? JSON.stringify(ac) : null, isBlocked, blockedReason]
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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

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
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        const history = (await req.db.query(`
            SELECT th.*, u.username, u.full_name, u.avatar
            FROM task_history th
            JOIN users u ON u.id = th.user_id
            WHERE th.task_id = $1
            ORDER BY th.created_at DESC
            LIMIT 200
        `, [req.params.id])).rows;

        res.json(history);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching task history:');
        res.status(500).json({ error: 'Failed to fetch task history' });
    }
});

// ─── Pass 2 helpers — task dependencies, acceptance criteria, blockers ──────
//
// Helper: ensure a task is visible to the caller (same org). Returns the
// task row or sends a 404/403 and returns null.
async function loadAccessibleTask(req, res, taskId) {
    const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
    if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
    // Cross-team admins (super_admin / hr_admin) and platform_admin can see anything in their org.
    const isOrgAdmin = ['super_admin', 'hr_admin', 'platform_admin'].includes(req.userRole);
    if (!isOrgAdmin && task.user_id !== req.userId && task.assigned_to !== req.userId) {
        // Fall back: if creator/assignee both outside the user's team scope → block
        // (the existing endpoints follow this pattern; replicate it here.)
        // For simplicity we allow all team-members of the same team to see the task.
        const sameTeam = (await req.db.query(
            `SELECT 1 FROM users u WHERE u.id = $1 AND u.team_id = (SELECT team_id FROM users WHERE id = $2)`,
            [req.userId, task.user_id]
        )).rowCount > 0;
        if (!sameTeam) { res.status(403).json({ error: 'Access denied' }); return null; }
    }
    return task;
}

// ── Dependencies ────────────────────────────────────────────────────────────
// GET    /tasks/:id/dependencies   — list both directions (this task blocks / is blocked by)
// POST   /tasks/:id/dependencies   — { depends_on_id, type? }   (default 'blocks')
// DELETE /tasks/:id/dependencies/:depId — remove one link
//
// We deliberately disallow self-links and exact cycles (A blocks B blocks A).
router.get('/:id/dependencies', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;

        const blocking = (await req.db.query(
            `SELECT d.id AS link_id, d.type, t.id, t.title, t.status, t.workflow_state_id, t.is_blocked
               FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
              WHERE d.task_id = $1
              ORDER BY t.id`,
            [id]
        )).rows;

        const blockedBy = (await req.db.query(
            `SELECT d.id AS link_id, d.type, t.id, t.title, t.status, t.workflow_state_id, t.is_blocked
               FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
              WHERE d.depends_on_id = $1
              ORDER BY t.id`,
            [id]
        )).rows;

        res.json({ blocks: blocking, blockedBy });
    } catch (err) {
        req.log.error({ err }, 'Error fetching dependencies');
        res.status(500).json({ error: 'Failed to fetch dependencies' });
    }
});

router.post('/:id/dependencies', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { depends_on_id, type } = req.body || {};
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const otherId = parseInt(depends_on_id, 10);
        if (isNaN(otherId)) return res.status(400).json({ error: 'depends_on_id is required' });
        if (id === otherId) return res.status(400).json({ error: 'A task cannot depend on itself' });
        const allowedTypes = ['blocks', 'relates', 'duplicates', 'clones'];
        const linkType = allowedTypes.includes(type) ? type : 'blocks';

        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const other = (await req.db.query('SELECT id FROM tasks WHERE id = $1', [otherId])).rows[0];
        if (!other) return res.status(400).json({ error: 'Linked task not found' });

        // Reject obvious 2-cycle: if other already blocks this one with same type
        if (linkType === 'blocks') {
            const reverse = (await req.db.query(
                "SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_id = $2 AND type = 'blocks'",
                [otherId, id]
            )).rowCount;
            if (reverse > 0) return res.status(400).json({ error: 'Would create a circular blocks dependency' });
        }

        const r = await req.db.query(
            `INSERT INTO task_dependencies (task_id, depends_on_id, type, created_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (task_id, depends_on_id, type) DO NOTHING
             RETURNING id`,
            [id, otherId, linkType, req.userId]
        );
        if (r.rowCount === 0) return res.status(409).json({ error: 'Dependency already exists' });

        // History trace on both ends
        await req.db.query(
            `INSERT INTO task_history (task_id, action, field, new_value, user_id)
             VALUES ($1, 'dependency_added', $2, $3, $4),
                    ($5, 'dependency_added', $6, $7, $4)`,
            [id, linkType, `→ #${otherId}`, req.userId, otherId, linkType, `← #${id}`]
        ).catch(() => { });

        res.json({ link_id: r.rows[0].id });
    } catch (err) {
        req.log.error({ err }, 'Error creating dependency');
        res.status(500).json({ error: 'Failed to create dependency' });
    }
});

router.delete('/:id/dependencies/:depId', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const linkId = parseInt(req.params.depId, 10);
        if (isNaN(id) || isNaN(linkId)) return res.status(400).json({ error: 'Invalid id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const r = await req.db.query(
            'DELETE FROM task_dependencies WHERE id = $1 AND task_id = $2 RETURNING depends_on_id, type',
            [linkId, id]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'Dependency not found' });
        await req.db.query(
            `INSERT INTO task_history (task_id, action, field, new_value, user_id)
             VALUES ($1, 'dependency_removed', $2, $3, $4)`,
            [id, r.rows[0].type, `→ #${r.rows[0].depends_on_id}`, req.userId]
        ).catch(() => { });
        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, 'Error deleting dependency');
        res.status(500).json({ error: 'Failed to delete dependency' });
    }
});

// ── Acceptance Criteria ─────────────────────────────────────────────────────
// Stored as a JSONB array on tasks: [{ id, text, done }]
// We expose targeted CRUD routes so the UI can update items without reading
// the whole task.
router.get('/:id/acceptance-criteria', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        res.json({ criteria: task.acceptance_criteria || [] });
    } catch (err) {
        req.log.error({ err }, 'Error fetching criteria');
        res.status(500).json({ error: 'Failed to fetch acceptance criteria' });
    }
});

router.put('/:id/acceptance-criteria', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const { criteria } = req.body || {};
        if (!Array.isArray(criteria)) return res.status(400).json({ error: 'criteria must be an array' });
        // Normalise — assign monotonic ids if missing, drop empty rows
        let nextId = Math.max(0, ...criteria.map(c => Number(c.id) || 0)) + 1;
        const cleaned = criteria
            .filter(c => c && typeof c.text === 'string' && c.text.trim())
            .slice(0, 100)
            .map(c => ({
                id: Number(c.id) || nextId++,
                text: String(c.text).trim().slice(0, 500),
                done: !!c.done,
            }));
        await req.db.query(
            'UPDATE tasks SET acceptance_criteria = $1::jsonb WHERE id = $2',
            [JSON.stringify(cleaned), id]
        );
        await req.db.query(
            `INSERT INTO task_history (task_id, action, field, new_value, user_id)
             VALUES ($1, 'updated', 'acceptance_criteria', $2, $3)`,
            [id, `${cleaned.length} item(s)`, req.userId]
        ).catch(() => { });
        res.json({ criteria: cleaned });
    } catch (err) {
        req.log.error({ err }, 'Error updating criteria');
        res.status(500).json({ error: 'Failed to update acceptance criteria' });
    }
});

// ── Block / Unblock ─────────────────────────────────────────────────────────
router.patch('/:id/block', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const { is_blocked, blocked_reason } = req.body || {};
        const flag = !!is_blocked;
        const reason = flag ? (typeof blocked_reason === 'string' ? blocked_reason.slice(0, 500) : null) : null;
        await req.db.query(
            'UPDATE tasks SET is_blocked = $1, blocked_reason = $2 WHERE id = $3',
            [flag, reason, id]
        );
        await req.db.query(
            `INSERT INTO task_history (task_id, action, field, new_value, user_id)
             VALUES ($1, $2, 'blocker', $3, $4)`,
            [id, flag ? 'blocked' : 'unblocked', reason || (flag ? 'No reason given' : null), req.userId]
        ).catch(() => { });
        res.json({ id, is_blocked: flag, blocked_reason: reason });
    } catch (err) {
        req.log.error({ err }, 'Error toggling blocker');
        res.status(500).json({ error: 'Failed to update blocker' });
    }
});

// ── Parent / Children (Epic ↔ Story relationships) ─────────────────────────
// GET /tasks/:id/children — list direct children of this task (any tickets
// whose parent_task_id matches). Used by the Epic detail panel.
router.get('/:id/children', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const children = (await req.db.query(
            `SELECT t.id, t.title, t.status, t.workflow_state_id, t.is_blocked,
                    t.story_points, t.work_item_type_id, t.priority, t.assigned_to,
                    u.full_name AS assignee_name, u.username AS assignee_username,
                    ws.name AS state_name, ws.color AS state_color, ws.is_terminal,
                    wit.name AS type_name, wit.color AS type_color
               FROM tasks t
          LEFT JOIN users u ON u.id = t.assigned_to
          LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
          LEFT JOIN work_item_types wit ON wit.id = t.work_item_type_id
              WHERE t.parent_task_id = $1
              ORDER BY
                CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                t.created_at ASC`,
            [id]
        )).rows;

        // Total points + completion rollup so the Epic panel can show progress.
        const num = v => (v == null ? 0 : Number(v));
        const totalPoints = children.reduce((s, c) => s + num(c.story_points), 0);
        const donePoints = children.filter(c => c.is_terminal).reduce((s, c) => s + num(c.story_points), 0);
        const doneCount = children.filter(c => c.is_terminal).length;
        res.json({
            children,
            rollup: {
                totalChildren: children.length,
                doneChildren: doneCount,
                totalPoints,
                donePoints,
                percentByPoints: totalPoints > 0 ? Math.round((donePoints / totalPoints) * 100) : 0,
                percentByCount: children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0,
            },
        });
    } catch (err) {
        req.log.error({ err }, 'Error fetching children');
        res.status(500).json({ error: 'Failed to fetch children' });
    }
});

// GET /tasks/:id/parent — fetch the parent task summary (for non-epic tickets
// to render a clickable "Part of" link).
router.get('/:id/parent', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        if (!task.parent_task_id) return res.json({ parent: null });
        const parent = (await req.db.query(
            `SELECT t.id, t.title, t.status, t.workflow_state_id, t.is_blocked, t.story_points,
                    t.work_item_type_id,
                    ws.name AS state_name, ws.color AS state_color,
                    wit.name AS type_name, wit.color AS type_color, wit.is_epic
               FROM tasks t
          LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
          LEFT JOIN work_item_types wit ON wit.id = t.work_item_type_id
              WHERE t.id = $1`,
            [task.parent_task_id]
        )).rows[0];
        res.json({ parent: parent || null });
    } catch (err) {
        req.log.error({ err }, 'Error fetching parent');
        res.status(500).json({ error: 'Failed to fetch parent' });
    }
});

// PATCH /tasks/:id/parent — set/clear the parent. Body: { parent_task_id: <id|null> }
// Validates the candidate parent exists in the same org, isn't the task itself,
// and isn't a descendant (so we don't create cycles).
router.patch('/:id/parent', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const raw = req.body?.parent_task_id;
        let newParentId = null;
        if (raw !== null && raw !== undefined && raw !== '') {
            const num = parseInt(raw, 10);
            if (isNaN(num) || num === id) return res.status(400).json({ error: 'Invalid parent_task_id' });
            const parent = (await req.db.query('SELECT id, org_id FROM tasks WHERE id = $1', [num])).rows[0];
            if (!parent || parent.org_id !== req.userOrgId) return res.status(400).json({ error: 'Parent task not found' });
            // Cycle check: walk up the ancestor chain of the candidate parent and
            // make sure we don't encounter `id`.
            let cursor = parent.id;
            for (let i = 0; i < 50 && cursor; i++) {
                if (cursor === id) return res.status(400).json({ error: 'Would create a cycle (task is an ancestor of the candidate parent)' });
                const next = (await req.db.query('SELECT parent_task_id FROM tasks WHERE id = $1', [cursor])).rows[0];
                cursor = next?.parent_task_id || null;
            }
            newParentId = parent.id;
        }
        await req.db.query('UPDATE tasks SET parent_task_id = $1 WHERE id = $2', [newParentId, id]);
        await logHistory(id, req.userId, 'updated', 'parent', task.parent_task_id || 'none', newParentId || 'none', null, req.db);
        res.json({ id, parent_task_id: newParentId });
    } catch (err) {
        req.log.error({ err }, 'Error setting parent');
        res.status(500).json({ error: 'Failed to set parent' });
    }
});

// ── Task search (lightweight, used by the dependency picker) ────────────────
// Returns up to 20 tasks matching `q` in title or id, scoped to the org.
router.get('/lookup/quicksearch', auth, loadUserContext, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 1) return res.json({ tasks: [] });
        const numericId = /^\d+$/.test(q) ? parseInt(q, 10) : null;
        // PostgreSQL cannot infer the type of a NULL parameter when used in a
        // comparison without context, so we cast both occurrences of $3 to int.
        // Without these casts the driver throws "could not determine data type
        // of parameter $3" → 500 to the client when the search term isn't a
        // pure number (e.g. "test").
        const rows = (await req.db.query(
            `SELECT t.id, t.title, t.status, t.workflow_state_id, t.is_blocked, t.story_points,
                    t.work_item_type_id
               FROM tasks t
               JOIN users u ON u.id = t.user_id
              WHERE u.org_id = $1
                AND (
                    ($3::int IS NOT NULL AND t.id = $3::int)
                    OR t.title ILIKE $2
                )
              ORDER BY t.id DESC
              LIMIT 20`,
            [req.userOrgId, `%${q}%`, numericId]
        )).rows;
        res.json({ tasks: rows });
    } catch (err) {
        req.log.error({ err }, 'Error in quicksearch');
        res.status(500).json({ error: 'Failed to search tasks' });
    }
});

module.exports = router;
