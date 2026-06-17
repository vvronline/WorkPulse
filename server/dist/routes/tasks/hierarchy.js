"use strict";
// Epic ↔ Story parent / child relationships.
//   GET   /:id/children   — direct children + rollup stats
//   GET   /:id/parent     — parent summary (or null)
//   PATCH /:id/parent     — set / clear parent (with cycle check)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const express_1 = __importDefault(require("express"));
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { logHistory } = require('./_helpers/logHistory');
const { loadAccessibleTask } = require('./_helpers/access');
const router = express_1.default.Router();
// GET /tasks/:id/children — list direct children of this task (any tickets
// whose parent_task_id matches). Used by the Epic detail panel.
router.get('/:id/children', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task)
            return;
        const children = (await req.db.query(`SELECT t.id, t.title, t.status, t.workflow_state_id, t.is_blocked,
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
                t.created_at ASC`, [id])).rows;
        // Total points + completion rollup so the Epic panel can show progress.
        const num = (v) => (v == null ? 0 : Number(v));
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
    }
    catch (err) {
        req.log.error({ err }, 'Error fetching children');
        res.status(500).json({ error: 'Failed to fetch children' });
    }
});
// GET /tasks/:id/parent — fetch the parent task summary (for non-epic tickets
// to render a clickable "Part of" link).
router.get('/:id/parent', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task)
            return;
        if (!task.parent_task_id)
            return res.json({ parent: null });
        const parent = (await req.db.query(`SELECT t.id, t.title, t.status, t.workflow_state_id, t.is_blocked, t.story_points,
                    t.work_item_type_id,
                    ws.name AS state_name, ws.color AS state_color,
                    wit.name AS type_name, wit.color AS type_color, wit.is_epic
               FROM tasks t
          LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
          LEFT JOIN work_item_types wit ON wit.id = t.work_item_type_id
              WHERE t.id = $1`, [task.parent_task_id])).rows[0];
        res.json({ parent: parent || null });
    }
    catch (err) {
        req.log.error({ err }, 'Error fetching parent');
        res.status(500).json({ error: 'Failed to fetch parent' });
    }
});
// PATCH /tasks/:id/parent — set/clear the parent. Body: { parent_task_id: <id|null> }
// Validates the candidate parent exists in the same org, isn't the task itself,
// and isn't a descendant (so we don't create cycles).
router.patch('/:id/parent', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task)
            return;
        const raw = req.body?.parent_task_id;
        let newParentId = null;
        if (raw !== null && raw !== undefined && raw !== '') {
            const num = parseInt(raw, 10);
            if (isNaN(num) || num === id)
                return res.status(400).json({ error: 'Invalid parent_task_id' });
            const parent = (await req.db.query('SELECT id, org_id FROM tasks WHERE id = $1', [num])).rows[0];
            if (!parent || parent.org_id !== req.userOrgId)
                return res.status(400).json({ error: 'Parent task not found' });
            // Cycle check: walk up the ancestor chain of the candidate parent and
            // make sure we don't encounter `id`.
            let cursor = parent.id;
            for (let i = 0; i < 50 && cursor; i++) {
                if (cursor === id)
                    return res.status(400).json({ error: 'Would create a cycle (task is an ancestor of the candidate parent)' });
                const next = (await req.db.query('SELECT parent_task_id FROM tasks WHERE id = $1', [cursor])).rows[0];
                cursor = next?.parent_task_id || null;
            }
            newParentId = parent.id;
        }
        await req.db.query('UPDATE tasks SET parent_task_id = $1 WHERE id = $2', [newParentId, id]);
        await logHistory(id, req.userId, 'updated', 'parent', task.parent_task_id || 'none', newParentId || 'none', null, req.db);
        res.json({ id, parent_task_id: newParentId });
    }
    catch (err) {
        req.log.error({ err }, 'Error setting parent');
        res.status(500).json({ error: 'Failed to set parent' });
    }
});
module.exports = router;
//# sourceMappingURL=hierarchy.js.map