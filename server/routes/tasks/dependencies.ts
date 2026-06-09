// Task dependency graph (blocks / relates / duplicates / clones).
//   GET    /:id/dependencies
//   POST   /:id/dependencies          { depends_on_id, type? }
//   DELETE /:id/dependencies/:depId

import express from "express";
import type { Request, Response } from "express";
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');

const { loadAccessibleTask } = require('./_helpers/access');

const router = express.Router();

router.get('/:id/dependencies', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;

        const blocking = (await req.db!.query(
            `SELECT d.id AS link_id, d.type, t.id, t.title, t.status, t.workflow_state_id, t.is_blocked
               FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
              WHERE d.task_id = $1
              ORDER BY t.id`,
            [id]
        )).rows;

        const blockedBy = (await req.db!.query(
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

router.post('/:id/dependencies', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        const { depends_on_id, type } = req.body || {};
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const otherId = parseInt(depends_on_id, 10);
        if (isNaN(otherId)) return res.status(400).json({ error: 'depends_on_id is required' });
        if (id === otherId) return res.status(400).json({ error: 'A task cannot depend on itself' });
        const allowedTypes = ['blocks', 'relates', 'duplicates', 'clones'];
        const linkType = allowedTypes.includes(type) ? type : 'blocks';

        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        // Bug #6 (Stage 2): we used to fetch only `id` and never compare orgs,
        // so a user could link their task to any task ID globally. Pull org_id
        // and verify it matches the requester's org (or both are null for
        // legacy/no-org tenants — match the loaded task's org_id).
        const other = (await req.db!.query('SELECT id, org_id FROM tasks WHERE id = $1', [otherId])).rows[0];
        if (!other) return res.status(400).json({ error: 'Linked task not found' });
        if ((other.org_id || null) !== (task.org_id || null)) {
            return res.status(400).json({ error: 'Linked task is in a different organization' });
        }

        // Reject obvious 2-cycle: if other already blocks this one with same type
        if (linkType === 'blocks') {
            const reverse = (await req.db!.query(
                "SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_id = $2 AND type = 'blocks'",
                [otherId, id]
            )).rowCount;
            if (reverse > 0) return res.status(400).json({ error: 'Would create a circular blocks dependency' });
        }

        const r = await req.db!.query(
            `INSERT INTO task_dependencies (task_id, depends_on_id, type, created_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (task_id, depends_on_id, type) DO NOTHING
             RETURNING id`,
            [id, otherId, linkType, req.userId]
        );
        if (r.rowCount === 0) return res.status(409).json({ error: 'Dependency already exists' });

        // History trace on both ends
        await req.db!.query(
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

router.delete('/:id/dependencies/:depId', auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        const linkId = parseInt(String(req.params.depId), 10);
        if (isNaN(id) || isNaN(linkId)) return res.status(400).json({ error: 'Invalid id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const r = await req.db!.query(
            'DELETE FROM task_dependencies WHERE id = $1 AND task_id = $2 RETURNING depends_on_id, type',
            [linkId, id]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'Dependency not found' });
        await req.db!.query(
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

export = router;