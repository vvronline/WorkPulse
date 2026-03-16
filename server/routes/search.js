/**
 * Global full-text search endpoint.
 * Searches tasks, the user's own notes, org members, and audit logs (hr_admin+).
 */
const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, ROLE_LEVEL } = require('../middleware/rbac');

const router = express.Router();
router.use(auth, loadUserContext);

/**
 * GET /api/search?q=<term>
 * Returns matched tasks, notes, users, and audit logs grouped by type.
 * Minimum query length: 2 characters.
 */
router.get('/', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim().length < 2) {
            return res.json({ tasks: [], notes: [], users: [], logs: [] });
        }

        const term = q.trim().slice(0, 200); // cap length to avoid excessive DB load

        // Build a prefix-matching tsquery: each word gets :* for partial matching
        const tsQuery = term
            .split(/\s+/)
            .filter(Boolean)
            .map(w => w.replace(/[^a-zA-Z0-9]/g, '') + ':*')
            .filter(p => p.length > 1)
            .join(' & ');

        // ILIKE pattern — escape SQL wildcards to prevent injection
        const ilikePat = `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`;

        // ── Tasks: tsvector search scoped to user's visible tasks ──────────────
        let taskRows = [];
        if (tsQuery) {
            taskRows = (await query(
                `SELECT id, title, description, status, priority, date, due_date, sprint_id,
                        ts_headline('english',
                            title || ' ' || COALESCE(description, ''),
                            to_tsquery('english', $2),
                            'MaxFragments=1, MaxWords=10, MinWords=3'
                        ) AS snippet
                 FROM tasks
                 WHERE (user_id = $1 OR assigned_to = $1)
                   AND to_tsvector('english', title || ' ' || COALESCE(description, ''))
                       @@ to_tsquery('english', $2)
                 ORDER BY created_at DESC
                 LIMIT 20`,
                [req.userId, tsQuery]
            )).rows;
        }

        // ── Notes: user's own notebook pages (stored as JSON blob) ────────────
        let noteResults = [];
        const notebookRow = (await query(
            'SELECT data FROM notebooks WHERE user_id = $1', [req.userId]
        )).rows[0];
        if (notebookRow) {
            let nb = null;
            try { nb = JSON.parse(notebookRow.data); } catch { /* ignore */ }
            const lower = term.toLowerCase();
            if (nb?.pages) {
                noteResults = nb.pages
                    .filter(p =>
                        (p.title || '').toLowerCase().includes(lower) ||
                        (p.content || '').replace(/<[^>]*>/g, '').toLowerCase().includes(lower)
                    )
                    .slice(0, 10)
                    .map(p => ({
                        id: p.id,
                        title: p.title || 'Untitled',
                        snippet: (p.content || '').replace(/<[^>]*>/g, '').slice(0, 120),
                    }));
            }
        }

        // ── Users: same org, active, name/username/email ILIKE ────────────────
        let userRows = [];
        if (req.userOrgId) {
            userRows = (await query(
                `SELECT id, username, full_name, email, avatar, role
                 FROM users
                 WHERE org_id = $1 AND id != $2 AND is_active = TRUE
                   AND (full_name ILIKE $3 OR username ILIKE $3 OR email ILIKE $3)
                 ORDER BY full_name ASC
                 LIMIT 10`,
                [req.userOrgId, req.userId, ilikePat]
            )).rows;
        }

        // ── Audit logs: hr_admin+ only, ILIKE on action/entity_type/details ───
        let logRows = [];
        const userLevel = ROLE_LEVEL[req.userRole] || 1;
        if (userLevel >= ROLE_LEVEL['hr_admin']) {
            const orgId = req.userRole === 'super_admin' ? null : req.userOrgId;
            logRows = (await query(
                `SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.created_at,
                        u.full_name AS actor_name
                 FROM audit_logs al
                 LEFT JOIN users u ON u.id = al.actor_id
                 WHERE ($1::integer IS NULL OR al.org_id = $1)
                   AND (al.action ILIKE $2 OR al.entity_type ILIKE $2 OR al.details ILIKE $2)
                 ORDER BY al.created_at DESC
                 LIMIT 10`,
                [orgId, ilikePat]
            )).rows;
        }

        res.json({ tasks: taskRows, notes: noteResults, users: userRows, logs: logRows });
    } catch (err) {
        req.log.error({ err }, 'Global search error');
        res.status(500).json({ error: 'Search failed' });
    }
});

module.exports = router;
