const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { logger } = require('../utils/logger');

const router = express.Router();

router.get('/', auth, async (req, res) => {
    try {
        const rows = (await query(`
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

router.post('/read-all', auth, async (req, res) => {
    try {
        await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark notifications read' });
    }
});

router.post('/:id/read', auth, async (req, res) => {
    try {
        await query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark notification read' });
    }
});

router.delete('/:id', auth, async (req, res) => {
    try {
        await query('DELETE FROM notifications WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

module.exports = router;