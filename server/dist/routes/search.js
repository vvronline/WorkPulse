"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
/**
 * Global full-text search endpoint.
 * Searches tasks, the user's own notes, org members, and audit logs (hr_admin+).
 */
const express_1 = __importDefault(require("express"));
const auth = require("../middleware/auth");
const { loadUserContext, ROLE_LEVEL } = require("../middleware/rbac");
const redis = require("../redis");
const router = express_1.default.Router();
const { requireTenant } = require("../middleware/tenant");
router.use(auth, loadUserContext, requireTenant);
/**
 * GET /api/search?q=<term>
 * Returns matched tasks, notes, users, and audit logs grouped by type.
 * Minimum query length: 2 characters.
 */
router.get("/", async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim().length < 2) {
            return res.json({ tasks: [], notes: [], users: [], logs: [] });
        }
        const term = q.trim().slice(0, 100); // cap length to prevent expensive queries
        // Check Redis cache first
        const cached = await redis.getSearchCache(req.tenantId, req.userId, term);
        if (cached)
            return res.json(cached);
        // Build a prefix-matching tsquery: each word gets :* for partial matching
        const tsQuery = term
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => w.replace(/[^a-zA-Z0-9]/g, "") + ":*")
            .filter((p) => p.length > 1)
            .join(" & ");
        // ILIKE pattern — escape SQL wildcards to prevent injection
        const ilikePat = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        // ── Tasks: tsvector search scoped to user's visible tasks ──────────────
        let taskRows = [];
        if (tsQuery) {
            taskRows = (await req.db.query(`SELECT id, title, description, status, priority, date, due_date, sprint_id,
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
                 LIMIT 20`, [req.userId, tsQuery])).rows;
        }
        // ── Notes: user's own notebook pages (stored as JSON blob) ────────────
        let noteResults = [];
        const notebookRow = (await req.db.query("SELECT data FROM notebooks WHERE user_id = $1", [req.userId])).rows[0];
        if (notebookRow) {
            let nb = null;
            try {
                nb = JSON.parse(notebookRow.data);
            }
            catch { /* ignore */ }
            const lower = term.toLowerCase();
            if (nb?.pages) {
                noteResults = nb.pages
                    .filter((p) => (p.title || "").toLowerCase().includes(lower) ||
                    (p.content || "").replace(/<[^>]*>/g, "").toLowerCase().includes(lower) ||
                    (p.tags || []).some((t) => t.toLowerCase().includes(lower)))
                    .slice(0, 15)
                    .map((p) => {
                    // Generate a context snippet around the match
                    const plainText = (p.content || "").replace(/<[^>]*>/g, "");
                    let snippet = plainText.slice(0, 120);
                    const matchIdx = plainText.toLowerCase().indexOf(lower);
                    if (matchIdx > 20) {
                        const start = Math.max(0, matchIdx - 40);
                        snippet = "…" + plainText.slice(start, start + 120);
                    }
                    return {
                        id: p.id,
                        title: p.title || "Untitled",
                        snippet,
                        tags: (p.tags || []).slice(0, 5),
                        pinned: !!p.pinned,
                        folderId: p.folderId || null,
                        updatedAt: p.updatedAt || null,
                    };
                });
            }
        }
        // ── Users: same org, active, name/username/email ILIKE ────────────────
        let userRows = [];
        if (req.userOrgId) {
            userRows = (await req.db.query(`SELECT id, username, full_name, email, avatar, role
                 FROM users
                 WHERE org_id = $1 AND id != $2 AND is_active = TRUE
                   AND (full_name ILIKE $3 OR username ILIKE $3 OR email ILIKE $3)
                 ORDER BY full_name ASC
                 LIMIT 10`, [req.userOrgId, req.userId, ilikePat])).rows;
        }
        // ── Calendar events: user's own, title/description ILIKE ─────────────
        const eventRows = (await req.db.query(`SELECT id, title, description, start_time, end_time, all_day
             FROM calendar_events
             WHERE user_id = $1 AND (title ILIKE $2 OR description ILIKE $2)
             ORDER BY start_time ASC
             LIMIT 7`, [req.userId, ilikePat])).rows;
        // ── Leaves: user's own, leave_type/reason ILIKE ───────────────────────
        const leaveRows = (await req.db.query(`SELECT id, date, leave_type, duration, status, reason
             FROM leaves
             WHERE user_id = $1 AND (leave_type ILIKE $2 OR COALESCE(reason, '') ILIKE $2)
             ORDER BY date DESC
             LIMIT 7`, [req.userId, ilikePat])).rows;
        // ── Sprints: user's team, name/goal ILIKE ─────────────────────────────
        let sprintRows = [];
        const teamRow = (await req.db.query("SELECT team_id FROM users WHERE id = $1", [req.userId])).rows[0];
        if (teamRow?.team_id) {
            sprintRows = (await req.db.query(`SELECT id, name, goal, status, start_date, end_date
                 FROM sprints
                 WHERE team_id = $1 AND (name ILIKE $2 OR COALESCE(goal, '') ILIKE $2)
                 ORDER BY start_date DESC
                 LIMIT 7`, [teamRow.team_id, ilikePat])).rows;
        }
        // ── Audit logs: hr_admin+ only, ILIKE on action/entity_type/details ───
        let logRows = [];
        const userLevel = ROLE_LEVEL[req.userRole] || 1;
        if (userLevel >= ROLE_LEVEL["hr_admin"]) {
            // Platform admins must have a tenant context to search audit logs;
            // without it return empty to prevent cross-tenant data leakage.
            const orgId = req.userOrgId || null;
            if (!orgId) {
                logRows = [];
            }
            else {
                logRows = (await req.db.query(`SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.created_at,
                            u.full_name AS actor_name
                     FROM audit_logs al
                     LEFT JOIN users u ON u.id = al.actor_id
                     WHERE al.org_id = $1
                       AND (al.action ILIKE $2 OR al.entity_type ILIKE $2 OR al.details ILIKE $2)
                     ORDER BY al.created_at DESC
                     LIMIT 10`, [orgId, ilikePat])).rows;
            }
        }
        const results = {
            tasks: taskRows,
            notes: noteResults,
            users: userRows,
            events: eventRows,
            leaves: leaveRows,
            sprints: sprintRows,
            logs: logRows,
        };
        // Cache results in Redis (2-min TTL)
        await redis.setSearchCache(req.tenantId, req.userId, term, results);
        res.json(results);
    }
    catch (err) {
        req.log.error({ err }, "Global search error");
        res.status(500).json({ error: "Search failed" });
    }
});
module.exports = router;
//# sourceMappingURL=search.js.map