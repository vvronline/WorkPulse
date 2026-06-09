// CRUD + status transitions for tasks.
//
// Routes mounted on `/api/tasks`:
//   GET    /          — list tasks (date/sprint/range scoped)
//   POST   /          — create a dated task
//   PATCH  /:id/status — change workflow state
//   PUT    /:id        — full update
//   DELETE /:id        — creator-only delete

import express from "express";
import type { Request, Response } from "express";
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { getLocalToday } = require('../../utils/timezone');
const { notifyByEmail } = require('../../utils/mailer');
const { sendToUser } = require('../../utils/ws');
const { logAction } = require('../../utils/audit');

const { logHistory } = require('./_helpers/logHistory');
const { canAccessTask } = require('./_helpers/access');
const { enrichTasks } = require('./_helpers/enrich');
const { syncLabels } = require('./_helpers/labels');
const {
    validateStoryPoints,
    resolveWorkItemType,
    resolveWorkflowState,
    getInitialWorkflowState,
    getDefaultWorkItemType,
    normalizeAcceptanceCriteria,
} = require('./_helpers/agile');

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

const router = express.Router();

// ─── Get tasks for a specific date or date range ─────────────────────────
router.get('/', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const { date, start_date, end_date, sprint_id, scope, include_due, assignee, label, priority, status, search } = req.query as Record<string, string>;

        const conditions: string[] = [];
        const params: unknown[] = [];
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
            // Bug #17 (Stage 2): include explicit ESCAPE clause so the `\`
            // we use to escape `%` / `_` is actually honoured by Postgres.
            const escaped = search.trim().replace(/[\\%_]/g, c => `\\${c}`);
            conditions.push(`(t.title ILIKE $${pi} ESCAPE '\\' OR t.description ILIKE $${pi} ESCAPE '\\')`);
            params.push(`%${escaped}%`);
            pi++;
        }

        const tasks = (await req.db!.query(`
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
        const done = enriched.filter((t: any) => t.status === 'done').length;
        const inProgress = enriched.filter((t: any) => t.status === 'in_progress').length;

        res.json({ tasks: enriched, stats: { total, done, inProgress, percent: total > 0 ? Math.round((done / total) * 100) : 0 } });
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching tasks:');
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// ─── Add a task ──────────────────────────────────────────────────────────
router.post('/', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const { title, description, priority, date, assigned_to, due_date, label_ids, sprint_id,
            story_points, work_item_type_id, workflow_state_id, parent_task_id,
            acceptance_criteria, is_blocked, blocked_reason, project_id } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'Task title is required' });
        if (title.trim().length > 200) return res.status(400).json({ error: 'Task title must be 200 characters or less' });
        if (description && description.length > 5000) return res.status(400).json({ error: 'Task description must be 5000 characters or less' });

        // Stage 3: optional project assignment + auto issue key. We validate
        // the project here so a missing/invalid value returns 400 before we
        // open the create transaction.
        let validProjectId = null;
        if (project_id !== undefined && project_id !== null && project_id !== '') {
            const projNum = parseInt(project_id, 10);
            if (!isNaN(projNum) && req.userOrgId) {
                const proj = (await req.db!.query(
                    'SELECT id FROM projects WHERE id = $1 AND org_id = $2 AND is_archived = FALSE',
                    [projNum, req.userOrgId]
                )).rows[0];
                if (!proj) return res.status(400).json({ error: 'Invalid project or project is archived' });
                validProjectId = proj.id;
            }
        }

        const targetDate = date || getLocalToday(req);
        const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

        let assignedTo = null;
        if (assigned_to) {
            const targetUser = (await req.db!.query('SELECT id, org_id, is_active FROM users WHERE id = $1', [assigned_to])).rows[0];
            if (!targetUser || !targetUser.is_active) return res.status(400).json({ error: 'Assigned user not found or inactive' });
            if (targetUser.org_id && req.userOrgId !== targetUser.org_id) {
                return res.status(400).json({ error: 'Cannot assign tasks to users in a different organization' });
            }
            assignedTo = assigned_to;
        }

        let validDueDate = null;
        if (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
            // Bug #15 (Stage 2): reject due_date earlier than the scheduled
            // date so users can't create logically impossible tasks (e.g.
            // dated 2026-05-21 due 2024-01-01). Compared lexicographically —
            // both are YYYY-MM-DD strings so ASCII order = chronological.
            if (targetDate && due_date < targetDate) {
                return res.status(400).json({ error: 'Due date cannot be earlier than the task date' });
            }
            validDueDate = due_date;
        }

        let validSprintId = null;
        if (sprint_id) {
            const sprint = (await req.db!.query(
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
                const parent = (await req.db!.query('SELECT id, org_id FROM tasks WHERE id = $1', [parentNum])).rows[0];
                if (parent && parent.org_id === req.userOrgId) parentTaskId = parent.id;
            }
        }

        // Bug #1 (Stage 2): the INSERT + label sync + history were three
        // separate statements. A failure between them left orphan rows (e.g.
        // a task with no history entry, or labels mapped to a half-written
        // task). Wrap them in a transaction so the entire create is atomic.
        //
        // Stage 3: when a project is assigned, we also reserve the next
        // `task_number` within the project. The UPDATE … RETURNING approach
        // is concurrency-safe — the row-level lock around the project row
        // serialises competing INSERTs so two requests can't both grab the
        // same number.
        const taskId = await (req.db as DbLike).transaction(async (client: any) => {
            let taskNumber = null;
            if (validProjectId) {
                const numRes = await client.query(
                    `UPDATE projects
                        SET next_task_number = next_task_number + 1,
                            updated_at = NOW()
                      WHERE id = $1
                      RETURNING next_task_number - 1 AS task_number`,
                    [validProjectId]
                );
                taskNumber = numRes.rows[0]?.task_number || null;
            }
            const insertRes = await client.query(
                `INSERT INTO tasks
                    (user_id, date, title, description, priority, status, assigned_to, due_date,
                     sprint_id, org_id, story_points, work_item_type_id, workflow_state_id,
                     parent_task_id, acceptance_criteria, is_blocked, blocked_reason, lead_started_at,
                     project_id, task_number)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), $18, $19)
                 RETURNING id`,
                [req.userId, targetDate, title.trim(), description?.trim() || null, validPriority,
                    statusKey, assignedTo, validDueDate, validSprintId, req.userOrgId || null,
                    sp, witId, wsId, parentTaskId, ac ? JSON.stringify(ac) : null, isBlocked, blockedReason,
                    validProjectId, taskNumber]
            );
            const newId = insertRes.rows[0].id;
            if (label_ids && Array.isArray(label_ids) && label_ids.length > 0) {
                // syncLabels uses its own .query — re-bind to the tx client so
                // the deletes/inserts join the transaction.
                await syncLabels(newId, label_ids, req.userOrgId, { query: client.query.bind(client) });
            }
            await logHistory(newId, req.userId, 'created', null, null, null, client, req.db);
            return newId;
        });

        const task = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
        const enriched = await enrichTasks([task], req.db);

        // Bug #16 (Stage 2): cross-cutting audit log so org admins can trace
        // who created / updated / deleted tasks across the tenant. This is
        // independent of `task_history` (which is per-task field changes).
        logAction(req, 'create', 'task', taskId, { title: task.title, sprint_id: validSprintId });

        // Notify assigned user
        if (assignedTo && assignedTo !== req.userId) {
            const assignee = (await req.db!.query('SELECT email, full_name FROM users WHERE id = $1', [assignedTo])).rows[0];
            const assigner = (await req.db!.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
            if (assignee) {
                await req.db!.query(
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
router.patch('/:id/status', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });
        const { status, workflow_state_id } = req.body;

        const task = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        // Resolve target workflow state. Accept either a numeric workflow_state_id
        // or a status key (back-compat with default 'pending'/'in_progress'/...).
        let target = await resolveWorkflowState(workflow_state_id, req.userOrgId, req.db);
        if (!target && status) target = await resolveWorkflowState(status, req.userOrgId, req.db);
        // Bug #4 (Stage 2): if the org has *any* configured workflow_states, an
        // unknown key is invalid — don't save an inconsistent (status, NULL
        // workflow_state_id) pair that the Kanban UI then can't render.
        // Only fall through to the legacy hard-coded keys when no states
        // exist at all for the org (brand-new tenants pre-seed).
        if (!target && status && ['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
            const anyStateRow = req.userOrgId
                ? (await req.db!.query('SELECT 1 FROM workflow_states WHERE org_id = $1 AND is_active = TRUE LIMIT 1', [req.userOrgId])).rowCount
                : 0;
            if (!anyStateRow) {
                target = { id: null, key: status, is_terminal: status === 'done' };
            }
        }
        if (!target) return res.status(400).json({ error: 'Invalid status / workflow state' });

        // ── Phase 3: WIP enforcement ────────────────────────────────────────
        // If the org has WIP limits enabled and the destination state has a
        // wip_limit, refuse the move when the column is already full. We don't
        // count the task itself if it's already in the target state.
        if (target.id) {
            const settingsRow = (await req.db!.query(
                'SELECT enable_wip_limits FROM org_agile_settings WHERE org_id = $1',
                [req.userOrgId]
            )).rows[0];
            const stateRow = (await req.db!.query(
                'SELECT wip_limit, name FROM workflow_states WHERE id = $1',
                [target.id]
            )).rows[0];
            if (settingsRow?.enable_wip_limits && stateRow?.wip_limit) {
                const occupancy = (await req.db!.query(
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
        //
        // Bug #2 (Stage 2): the old check used `target.key !== 'pending'` —
        // but a tenant that renamed/added an initial state would never start
        // the cycle. Use `is_initial` + `category === 'open'` from the
        // workflow_states row so custom workflows work too. We still fall
        // back to the legacy key when no state row was resolved (very old
        // tenants where the catalog isn't seeded).
        const completedAt = target.is_terminal ? new Date().toISOString() : null;
        let cycleStartedAtClause = '';
        const wasOpen = !task.cycle_started_at;
        const targetIsStartOfWork = target.id
            ? (!target.is_terminal && !target.is_initial && (target.category ? target.category !== 'open' : true))
            : (!target.is_terminal && target.key !== 'pending');
        const startsCycle = wasOpen && targetIsStartOfWork;
        if (startsCycle) cycleStartedAtClause = ', cycle_started_at = NOW()';

        await req.db!.query(
            `UPDATE tasks SET status = $1, workflow_state_id = $2, completed_at = $3${cycleStartedAtClause}
              WHERE id = $4`,
            [target.key, target.id, completedAt, id]
        );

        if (task.status !== target.key) {
            await logHistory(id, req.userId, 'status_change', 'status', task.status, target.key, null, req.db);
            // Bug #16: audit status transitions too.
            logAction(req, 'update', 'task', id, { from: task.status, to: target.key, field: 'status' });
        }

        const updated = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);
        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error updating task status:');
        res.status(500).json({ error: 'Failed to update task status' });
    }
});

// ─── Update task details ─────────────────────────────────────────────────
router.put('/:id', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });
        const { title, description, priority, assigned_to, due_date, label_ids, sprint_id,
            story_points, work_item_type_id, workflow_state_id, parent_task_id,
            acceptance_criteria, is_blocked, blocked_reason, project_id } = req.body;

        const task = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        // Stage 3: allow assigning a task to a project *only if it has none
        // yet*. Re-keying an existing task (PROJ-12 → OTHER-7) would orphan
        // every external reference (branches, commits, links) that already
        // mention the old key, so we deliberately make this one-way. To move
        // a task to a different project, create a new one and link them.
        let newProjectId = task.project_id;
        let newTaskNumber = task.task_number;
        const wantsProjectAssign = project_id !== undefined
            && project_id !== null
            && project_id !== ''
            && !task.project_id;
        if (project_id !== undefined && task.project_id) {
            // Silently ignore attempts to change/clear an already-set project
            // so the rest of the update still succeeds.
        }
        if (wantsProjectAssign) {
            const projNum = parseInt(project_id, 10);
            if (isNaN(projNum) || !req.userOrgId) {
                return res.status(400).json({ error: 'Invalid project' });
            }
            const proj = (await req.db!.query(
                'SELECT id FROM projects WHERE id = $1 AND org_id = $2 AND is_archived = FALSE',
                [projNum, req.userOrgId]
            )).rows[0];
            if (!proj) return res.status(400).json({ error: 'Invalid project or project is archived' });
            // Reserve a task number atomically (same pattern as POST /tasks).
            const numRes = await req.db!.query(
                `UPDATE projects
                    SET next_task_number = next_task_number + 1,
                        updated_at = NOW()
                  WHERE id = $1
                  RETURNING next_task_number - 1 AS task_number`,
                [proj.id]
            );
            newProjectId = proj.id;
            newTaskNumber = numRes.rows[0]?.task_number || null;
        }

        const newTitle = title?.trim() || task.title;
        const newDesc = description !== undefined ? (description?.trim() || null) : task.description;
        const newPriority = ['low', 'medium', 'high'].includes(priority) ? priority : task.priority;

        let newAssignedTo = task.assigned_to;
        if (assigned_to !== undefined) {
            if (assigned_to === null || assigned_to === '') {
                newAssignedTo = null;
            } else {
                const targetUser = (await req.db!.query('SELECT id, org_id, is_active FROM users WHERE id = $1', [assigned_to])).rows[0];
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
            // Bug #15: reject due_date earlier than the task date.
            if (newDueDate && task.date && newDueDate < task.date) {
                return res.status(400).json({ error: 'Due date cannot be earlier than the task date' });
            }
        }

        let newSprintId = task.sprint_id;
        if (sprint_id !== undefined) {
            if (sprint_id === null || sprint_id === '') {
                newSprintId = null;
            } else {
                const sprint = (await req.db!.query(
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
            // Bug #13 (Stage 2): only stamp/clear completed_at when the state
            // actually changed. Previously, sending the same workflow_state_id
            // (or null reset → already-initial state) would wipe a real
            // completion timestamp. Compare against the existing row first.
            const stateChanged = String(newWsId ?? '') !== String(task.workflow_state_id ?? '')
                || String(newStatusKey || '') !== String(task.status || '');
            if (stateChanged) {
                newCompletedAt = newWsRow?.is_terminal ? new Date().toISOString() : null;
            }
        }
        let newParentTaskId = task.parent_task_id;
        if (parent_task_id !== undefined) {
            if (parent_task_id === null || parent_task_id === '') {
                newParentTaskId = null;
            } else {
                const parentNum = parseInt(parent_task_id, 10);
                if (isNaN(parentNum) || parentNum === id) return res.status(400).json({ error: 'Invalid parent_task_id' });
                const parent = (await req.db!.query('SELECT id, org_id FROM tasks WHERE id = $1', [parentNum])).rows[0];
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

        await req.db!.query(
            `UPDATE tasks SET title = $1, description = $2, priority = $3, assigned_to = $4,
                due_date = $5, sprint_id = $6, story_points = $7, work_item_type_id = $8,
                workflow_state_id = $9, status = $10, completed_at = $11, parent_task_id = $12,
                acceptance_criteria = $13, is_blocked = $14, blocked_reason = $15,
                project_id = $16, task_number = $17
              WHERE id = $18`,
            [newTitle, newDesc, newPriority, newAssignedTo, newDueDate, newSprintId,
                newStoryPoints, newWitId, newWsId, newStatusKey, newCompletedAt, newParentTaskId,
                newAc !== null && newAc !== undefined ? JSON.stringify(newAc) : null,
                newIsBlocked, newBlockedReason, newProjectId, newTaskNumber, id]
        );

        // Log a project assignment as a first-class history event so users
        // can see when a previously-keyless task picked up an issue key.
        if (wantsProjectAssign && newProjectId && newProjectId !== task.project_id) {
            const projRow = (await req.db!.query('SELECT key FROM projects WHERE id = $1', [newProjectId])).rows[0];
            const newKey = projRow && newTaskNumber ? `${projRow.key}-${newTaskNumber}` : null;
            await logHistory(id, req.userId, 'updated', 'project', 'none', newKey || `project #${newProjectId}`, null, req.db);
        }

        if (newTitle !== task.title) await logHistory(id, req.userId, 'updated', 'title', task.title, newTitle, null, req.db);
        if (newDesc !== task.description) await logHistory(id, req.userId, 'updated', 'description', task.description ? task.description.slice(0, 100) : null, newDesc ? newDesc.slice(0, 100) : null, null, req.db);
        if (newPriority !== task.priority) await logHistory(id, req.userId, 'updated', 'priority', task.priority, newPriority, null, req.db);
        if (String(newAssignedTo || '') !== String(task.assigned_to || '')) {
            // Bug #14 (Stage 2): the original lookup only returned `full_name`.
            // If a user had a null/empty full_name (common for SSO accounts
            // that only carry email) the history line read "null → null".
            // Pull username too and fall back to it.
            const oldUser = task.assigned_to ? (await req.db!.query('SELECT full_name, username FROM users WHERE id = $1', [task.assigned_to])).rows[0] : null;
            const newUser = newAssignedTo ? (await req.db!.query('SELECT full_name, username FROM users WHERE id = $1', [newAssignedTo])).rows[0] : null;
            const oldLabel = oldUser?.full_name || oldUser?.username || 'unassigned';
            const newLabel = newUser?.full_name || newUser?.username || 'unassigned';
            await logHistory(id, req.userId, 'updated', 'assigned_to', oldLabel, newLabel, null, req.db);
        }
        if (newDueDate !== task.due_date) await logHistory(id, req.userId, 'updated', 'due_date', task.due_date, newDueDate, null, req.db);
        if (String(newSprintId || '') !== String(task.sprint_id || '')) {
            const oldSprint = task.sprint_id ? (await req.db!.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            const newSprint = newSprintId ? (await req.db!.query('SELECT name FROM sprints WHERE id = $1', [newSprintId])).rows[0] : null;
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
            const oldWit = task.work_item_type_id ? (await req.db!.query('SELECT name FROM work_item_types WHERE id = $1', [task.work_item_type_id])).rows[0] : null;
            const newWit = newWitId ? (newWitRow || (await req.db!.query('SELECT name FROM work_item_types WHERE id = $1', [newWitId])).rows[0]) : null;
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
            const oldLabels = (await req.db!.query('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = $1 ORDER BY tl.name', [id])).rows.map(r => r.name);
            await syncLabels(id, label_ids || [], req.userOrgId, req.db);
            const newLabels = (await req.db!.query('SELECT tl.name FROM task_label_map tlm JOIN task_labels tl ON tl.id = tlm.label_id WHERE tlm.task_id = $1 ORDER BY tl.name', [id])).rows.map(r => r.name);
            if (JSON.stringify(oldLabels) !== JSON.stringify(newLabels)) {
                await logHistory(id, req.userId, 'updated', 'labels', oldLabels.join(', ') || 'none', newLabels.join(', ') || 'none', null, req.db);
            }
        }

        // Bug #16: audit log for full updates.
        logAction(req, 'update', 'task', id, { title: newTitle });

        const updated = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);

        // Notify if assignment changed to a new user
        if (newAssignedTo && String(newAssignedTo) !== String(task.assigned_to) && newAssignedTo !== req.userId) {
            const assignee = (await req.db!.query('SELECT email, full_name FROM users WHERE id = $1', [newAssignedTo])).rows[0];
            const assigner = (await req.db!.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
            if (assignee) {
                await req.db!.query(
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
router.delete('/:id', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });
        const task = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (task.user_id !== req.userId) return res.status(403).json({ error: 'Only task creator can delete task' });
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        await logHistory(id, req.userId, 'deleted', null, task.title, null, null, req.db);
        await req.db!.query('DELETE FROM tasks WHERE id = $1', [id]);
        // Bug #16: audit on delete (irreversible, especially important).
        logAction(req, 'delete', 'task', id, { title: task.title });
        res.json({ message: 'Task deleted' });
    } catch (err) {
        req.log.error({ err: err }, 'Error deleting task:');
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

export = router;