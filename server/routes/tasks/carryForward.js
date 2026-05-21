// POST /api/tasks/carry-forward
//
// Auto-promotes incomplete tasks from the user's most recent task-day (within
// the last 7 days) to today. Uses a transaction so labels and history copy
// atomically with the new task row.

const express = require('express');
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { getLocalToday } = require('../../utils/timezone');

const { logHistory } = require('./_helpers/logHistory');

const router = express.Router();

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

        // Bug #3 (Stage 2): the SELECT used to grab only title/desc/priority/
        // assignee/due_date, dropping every agile field (story_points,
        // work_item_type_id, workflow_state_id, sprint_id, parent_task_id,
        // acceptance_criteria, is_blocked, blocked_reason) on carry-forward.
        // Also includes the row id so we don't need a second query to copy
        // labels.
        const incomplete = (await req.db.query(`
            SELECT id, title, description, priority, assigned_to, due_date,
                   story_points, work_item_type_id, workflow_state_id, status,
                   parent_task_id, acceptance_criteria, is_blocked, blocked_reason
              FROM tasks
             WHERE (user_id = $1 OR assigned_to = $1)
               AND date = $2
               AND status != 'done'
               AND ((org_id = $3) OR (org_id IS NULL AND $3::integer IS NULL))
        `, [req.userId, lastTaskDay.date, req.userOrgId || null])).rows;

        if (incomplete.length === 0) return res.json({ message: 'No tasks to carry forward', carried: 0 });

        const carried = await req.db.transaction(async (client) => {
            let count = 0;
            for (const t of incomplete) {
                // Bug #3: the dup-check used to ignore org_id, meaning two users
                // in different orgs with the same task title would collide.
                // Filter by org so the check is tenant-correct.
                const exists = (await client.query(
                    `SELECT id FROM tasks
                      WHERE (user_id = $1 OR assigned_to = $1)
                        AND date = $2
                        AND LOWER(TRIM(title)) = LOWER(TRIM($3))
                        AND ((org_id = $4) OR (org_id IS NULL AND $4::integer IS NULL))`,
                    [req.userId, today, t.title, req.userOrgId || null]
                )).rows[0];
                if (!exists) {
                    const dueDate = t.due_date && t.due_date < today ? today : t.due_date;
                    // Preserve every agile field. lead_started_at is reset to
                    // NOW() because the new dated instance is effectively a
                    // fresh "queued" copy for today.
                    const insertRes = await client.query(
                        `INSERT INTO tasks
                            (user_id, date, title, description, priority, assigned_to, due_date, org_id,
                             story_points, work_item_type_id, workflow_state_id, status,
                             parent_task_id, acceptance_criteria, is_blocked, blocked_reason, lead_started_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
                         RETURNING id`,
                        [req.userId, today, t.title, t.description, t.priority, t.assigned_to, dueDate, req.userOrgId || null,
                        t.story_points, t.work_item_type_id, t.workflow_state_id, t.status,
                        t.parent_task_id,
                        t.acceptance_criteria ? JSON.stringify(t.acceptance_criteria) : null,
                        !!t.is_blocked, t.blocked_reason]
                    );
                    const newTaskId = insertRes.rows[0].id;
                    // We already have the origin row's id from the SELECT — copy
                    // its labels directly without re-querying by title (which
                    // could match the wrong row).
                    const origLabels = (await client.query('SELECT label_id FROM task_label_map WHERE task_id = $1', [t.id])).rows;
                    for (const lbl of origLabels) {
                        await client.query(
                            'INSERT INTO task_label_map (task_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                            [newTaskId, lbl.label_id]
                        );
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

module.exports = router;