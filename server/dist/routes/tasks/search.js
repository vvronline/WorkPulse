"use strict";
// Search endpoints for tasks.
//
//   GET /search            — global cross-date search scoped to user
//   GET /lookup/quicksearch — autocomplete for dependency picker
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const express_1 = __importDefault(require("express"));
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { enrichTasks } = require('./_helpers/enrich');
const router = express_1.default.Router();
// ─── Global search across all dates + backlog ────────────────────────────
router.get('/search', auth, loadUserContext, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || !q.trim() || q.trim().length < 2)
            return res.json([]);
        const escapedQ = q.trim().replace(/[%_]/g, c => `\\${c}`);
        const conditions = ['(t.title ILIKE $1 OR t.description ILIKE $1)'];
        const params = [`%${escapedQ}%`];
        let pi = 2;
        if (req.userOrgId) {
            conditions.push(`t.org_id = $${pi++}`);
            params.push(req.userOrgId);
        }
        else {
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
    }
    catch (err) {
        req.log.error({ err: err }, 'Error in global search:');
        res.status(500).json({ error: 'Search failed' });
    }
});
// ── Task quicksearch (lightweight, used by the dependency picker) ─────────
// Returns up to 20 tasks matching `q` in title or id, scoped to the org.
router.get('/lookup/quicksearch', auth, loadUserContext, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 1)
            return res.json({ tasks: [] });
        const numericId = /^\d+$/.test(q) ? parseInt(q, 10) : null;
        // PostgreSQL cannot infer the type of a NULL parameter when used in a
        // comparison without context, so we cast both occurrences of $3 to int.
        // Without these casts the driver throws "could not determine data type
        // of parameter $3" → 500 to the client when the search term isn't a
        // pure number (e.g. "test").
        //
        // Bug #8 (Stage 2): we used to filter on `u.org_id` from the joined
        // creator. If the creator moved orgs but the task stayed (`tasks.org_id`
        // is the canonical column), the task disappeared from search. Filter
        // on `t.org_id` directly. We still join users only to keep the column
        // list compatible for future enrichment, but it's no longer the gate.
        const rows = (await req.db.query(`SELECT t.id, t.title, t.status, t.workflow_state_id, t.is_blocked, t.story_points,
                    t.work_item_type_id
               FROM tasks t
              WHERE t.org_id = $1
                AND (
                    ($3::int IS NOT NULL AND t.id = $3::int)
                    OR t.title ILIKE $2
                )
              ORDER BY t.id DESC
              LIMIT 20`, [req.userOrgId, `%${q}%`, numericId])).rows;
        res.json({ tasks: rows });
    }
    catch (err) {
        req.log.error({ err }, 'Error in quicksearch');
        res.status(500).json({ error: 'Failed to search tasks' });
    }
});
module.exports = router;
//# sourceMappingURL=search.js.map