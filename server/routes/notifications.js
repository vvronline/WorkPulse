const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — fetch recent notifications for current user
router.get('/', auth, (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT n.*, t.title AS task_title
            FROM notifications n
            LEFT JOIN tasks t ON t.id = n.link_task_id
            WHERE n.user_id = ?
            ORDER BY n.created_at DESC
            LIMIT 50
        `).all(req.userId);
        const unread = rows.filter(r => !r.is_read).length;
        res.json({ notifications: rows, unread });
    } catch (err) {
        console.error('Error fetching notifications:', err.message);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', auth, (req, res) => {
    try {
        db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.userId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark notifications read' });
    }
});

// POST /api/notifications/:id/read — mark one as read
router.post('/:id/read', auth, (req, res) => {
    try {
        db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
            .run(req.params.id, req.userId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark notification read' });
    }
});

// DELETE /api/notifications/:id — delete one notification
router.delete('/:id', auth, (req, res) => {
    try {
        db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
            .run(req.params.id, req.userId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

module.exports = router;
