const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { logger } = require('../utils/logger');

const router = express.Router();
const { requireTenant } = require('../middleware/tenant');
router.use(auth, loadUserContext, requireTenant);

router.get('/', async (req, res) => {
    try {
        const rows = (await req.db.query(`
            SELECT n.*, t.title AS task_title
            FROM notifications n
            LEFT JOIN tasks t ON t.id = n.link_task_id
            WHERE n.user_id = $1
            ORDER BY n.created_at DESC
            LIMIT 50
        `, [req.userId])).rows;
        const unread = rows.filter(r => !r.is_read).length;
        res.json({ notifications: rows, unread });
    } catch (err) {
        req.log.error({ err }, 'Error fetching notifications');
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

router.post('/read-all', async (req, res) => {
    try {
        await req.db.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark notifications read' });
    }
});

router.post('/:id/read', async (req, res) => {
    try {
        await req.db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark notification read' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await req.db.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

router.get('/announcements', async (req, res) => {
    try {
        const rows = (await req.db.query(`
            SELECT a.id, a.message, a.type, a.created_at, u.full_name AS author
            FROM announcements a
            LEFT JOIN users u ON u.id = a.created_by
            WHERE a.is_active = TRUE AND (a.org_id IS NULL OR a.org_id = $1)
              AND (a.expires_at IS NULL OR a.expires_at > NOW())
            ORDER BY a.created_at DESC LIMIT 20
        `, [req.userOrgId])).rows;
        res.json({ data: rows });
    } catch (err) {
        req.log.error({ err }, 'Error fetching announcements');
        res.status(500).json({ error: 'Failed to fetch announcements' });
    }
});

module.exports = router;