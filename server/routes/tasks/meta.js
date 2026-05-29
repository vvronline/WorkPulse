// Lightweight read endpoints for client-side dropdowns:
//   GET /assignable-users — users in the requester's org
//   GET /labels           — labels in the requester's org (used by filters)

const express = require('express');
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');

const router = express.Router();

// ─── Get assignable users (same org) ─────────────────────────────────────
router.get('/assignable-users', auth, loadUserContext, async (req, res) => {
    try {
        let users;
        if (req.userOrgId) {
            // Exclude synthetic Platform Inspector users so they never
            // appear as assignees in the task editor / @mention picker.
            // They have org_id=NULL anyway, but the explicit filter is
            // defence-in-depth in case the model evolves.
            users = (await req.db.query(
                'SELECT id, username, full_name, avatar FROM users WHERE org_id = $1 AND is_active = TRUE AND hidden_from_directory = FALSE ORDER BY full_name ASC',
                [req.userOrgId]
            )).rows;
        } else {
            users = (await req.db.query('SELECT id, username, full_name, avatar FROM users WHERE id = $1', [req.userId])).rows;
        }
        res.json(users);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching assignable users:');
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ─── Get labels for current user's org ───────────────────────────────────
router.get('/labels', auth, loadUserContext, async (req, res) => {
    try {
        let labels = [];
        if (req.userOrgId) {
            labels = (await req.db.query('SELECT id, name, color FROM task_labels WHERE org_id = $1 ORDER BY name ASC', [req.userOrgId])).rows;
        }
        res.json(labels);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching labels:');
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
});

module.exports = router;