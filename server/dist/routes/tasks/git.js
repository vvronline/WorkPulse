"use strict";
// Git refs on a task (Stage 3).
//   GET    /:id/git              — list branches, PRs, commits linked to the task
//   POST   /:id/git              — manually link a branch/PR/commit
//   DELETE /:id/git/:refId       — unlink (manager+ or creator)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const express_1 = __importDefault(require("express"));
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { loadAccessibleTask } = require('./_helpers/access');
const router = express_1.default.Router();
router.get('/:id/git', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task)
            return;
        const rows = (await req.db.query(`SELECT id, ref_type, status, external_id, title, url, repository, ref_name,
                    author_login, commit_sha, event_at, created_at, updated_at
               FROM task_git_refs
              WHERE task_id = $1
              ORDER BY event_at DESC`, [id])).rows;
        // Group by ref_type so the UI can render three sections (Branches /
        // Pull Requests / Commits) without a second pass.
        const grouped = { branches: [], pull_requests: [], commits: [] };
        for (const r of rows) {
            if (r.ref_type === 'branch')
                grouped.branches.push(r);
            else if (r.ref_type === 'pull_request')
                grouped.pull_requests.push(r);
            else if (r.ref_type === 'commit')
                grouped.commits.push(r);
        }
        res.json({ refs: rows, grouped });
    }
    catch (err) {
        req.log.error({ err }, 'Failed to list git refs');
        res.status(500).json({ error: 'Failed to list git refs' });
    }
});
router.post('/:id/git', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id))
            return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task)
            return;
        const { ref_type, external_id, title, url, repository, ref_name, status } = req.body || {};
        if (!['branch', 'pull_request', 'commit'].includes(ref_type)) {
            return res.status(400).json({ error: 'ref_type must be branch | pull_request | commit' });
        }
        const validStatus = ['open', 'merged', 'closed', 'draft', 'committed'].includes(status)
            ? status
            : (ref_type === 'commit' ? 'committed' : 'open');
        const r = await req.db.query(`INSERT INTO task_git_refs
                (task_id, ref_type, status, external_id, title, url, repository, ref_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (task_id, ref_type, external_id, repository)
             DO UPDATE SET status = EXCLUDED.status, title = EXCLUDED.title, url = EXCLUDED.url,
                           ref_name = EXCLUDED.ref_name, updated_at = NOW()
             RETURNING *`, [id, ref_type, validStatus, external_id || null, title || null, url || null,
            repository || null, ref_name || null]);
        res.json(r.rows[0]);
    }
    catch (err) {
        req.log.error({ err }, 'Failed to link git ref');
        res.status(500).json({ error: 'Failed to link git ref' });
    }
});
router.delete('/:id/git/:refId', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        const refId = parseInt(String(req.params.refId), 10);
        if (isNaN(id) || isNaN(refId))
            return res.status(400).json({ error: 'Invalid id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task)
            return;
        const r = await req.db.query('DELETE FROM task_git_refs WHERE id = $1 AND task_id = $2 RETURNING id', [refId, id]);
        if (r.rowCount === 0)
            return res.status(404).json({ error: 'Git ref not found' });
        res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, 'Failed to delete git ref');
        res.status(500).json({ error: 'Failed to delete git ref' });
    }
});
module.exports = router;
//# sourceMappingURL=git.js.map