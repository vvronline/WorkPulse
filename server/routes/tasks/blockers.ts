// Block / unblock toggle for a task.
//   PATCH /:id/block   { is_blocked: bool, blocked_reason?: string }

import express from "express";
import type { Request, Response } from "express";
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');

const { loadAccessibleTask } = require('./_helpers/access');

const router = express.Router();

router.patch('/:id/block', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const { is_blocked, blocked_reason } = req.body || {};
        const flag = !!is_blocked;
        const reason = flag ? (typeof blocked_reason === 'string' ? blocked_reason.slice(0, 500) : null) : null;
        await req.db!.query(
            'UPDATE tasks SET is_blocked = $1, blocked_reason = $2 WHERE id = $3',
            [flag, reason, id]
        );
        await req.db!.query(
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

export = router;