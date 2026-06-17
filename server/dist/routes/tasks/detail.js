"use strict";
// Task detail + history endpoints:
//   GET /:id/detail   — task + comments in one shot (used by modal)
//   GET /:id/history  — change-log entries
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const express_1 = __importDefault(require("express"));
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { canAccessTask } = require('./_helpers/access');
const { enrichTasks } = require('./_helpers/enrich');
const router = express_1.default.Router();
// ─── Get single task detail ───────────────────────────────────────────────
router.get('/:id/detail', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole))
            return res.status(404).json({ error: 'Task not found' });
        const enriched = await enrichTasks([task], req.db);
        const comments = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = $1
            ORDER BY tc.created_at ASC
        `, [task.id])).rows;
        res.json({ ...enriched[0], comments });
    }
    catch (err) {
        req.log.error({ err: err }, 'Error fetching task detail:');
        res.status(500).json({ error: 'Failed to fetch task detail' });
    }
});
// ─── Get task history ─────────────────────────────────────────────────────
router.get('/:id/history', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!task)
            return res.status(404).json({ error: 'Task not found' });
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole))
            return res.status(404).json({ error: 'Task not found' });
        const history = (await req.db.query(`
            SELECT th.*, u.username, u.full_name, u.avatar
            FROM task_history th
            JOIN users u ON u.id = th.user_id
            WHERE th.task_id = $1
            ORDER BY th.created_at DESC
            LIMIT 200
        `, [req.params.id])).rows;
        res.json(history);
    }
    catch (err) {
        req.log.error({ err: err }, 'Error fetching task history:');
        res.status(500).json({ error: 'Failed to fetch task history' });
    }
});
module.exports = router;
//# sourceMappingURL=detail.js.map