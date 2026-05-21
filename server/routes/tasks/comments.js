// Task comments — list/add/edit/delete plus @mention notifications.
//   GET    /:id/comments
//   POST   /:id/comments
//   PUT    /:id/comments/:commentId
//   DELETE /:id/comments/:commentId

const express = require('express');
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { notifyByEmail } = require('../../utils/mailer');
const { sendToUser } = require('../../utils/ws');

const { logHistory } = require('./_helpers/logHistory');
const { canAccessTask } = require('./_helpers/access');

const router = express.Router();

// ─── Get comments for a task ──────────────────────────────────────────────
router.get('/:id/comments', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        const comments = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id = $1
            ORDER BY tc.created_at ASC
            LIMIT 200
        `, [req.params.id])).rows;

        res.json(comments);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching comments:');
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// ─── Add comment ──────────────────────────────────────────────────────────
router.post('/:id/comments', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (content.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or less' });

        const result = await req.db.query(
            'INSERT INTO task_comments (task_id, user_id, content) VALUES ($1, $2, $3) RETURNING id',
            [req.params.id, req.userId, content.trim()]
        );
        await logHistory(req.params.id, req.userId, 'comment_added', null, null, null, null, req.db);

        const comment = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.id = $1
        `, [result.rows[0].id])).rows[0];

        try {
            const mentionRegex = /data-user-id="(\d+)"/g;
            const mentionedIds = new Set();
            let m;
            while ((m = mentionRegex.exec(content)) !== null) {
                const uid = parseInt(m[1]);
                if (uid !== req.userId) mentionedIds.add(uid);
            }
            if (mentionedIds.size > 0) {
                const commenter = (await req.db.query('SELECT username, full_name FROM users WHERE id = $1', [req.userId])).rows[0];
                const commenterName = commenter?.full_name || commenter?.username || 'Someone';
                const orgMentionRows = req.userOrgId
                    ? (await req.db.query(
                        'SELECT id FROM users WHERE id = ANY($1) AND org_id = $2 AND is_active = TRUE',
                        [[...mentionedIds], req.userOrgId]
                    )).rows
                    : [];

                for (const row of orgMentionRows) {
                    const uid = row.id;
                    // Bug #5 (Stage 2): we previously omitted the requesterRole
                    // here, so org admins who were @-mentioned (but weren't the
                    // creator/assignee/team-mate) silently failed the access
                    // check and got no notification. Pass through the mentioned
                    // user's role lookup so admins can be mentioned anywhere.
                    const mentionRole = (await req.db.query('SELECT role FROM users WHERE id = $1', [uid])).rows[0]?.role || null;
                    if (!await canAccessTask(task, uid, req.userOrgId, req.db, mentionRole)) continue;
                    await req.db.query(
                        'INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5)',
                        [uid, 'mention', `${commenterName} mentioned you`, `In task: ${task.title}`, task.id]
                    );
                    // Email + WS notification for mention
                    const mentioned = (await req.db.query('SELECT email, full_name FROM users WHERE id = $1', [uid])).rows[0];
                    if (mentioned) {
                        notifyByEmail('mention', mentioned, commenterName, task.title);
                        sendToUser(req.tenantId, uid, 'notification', { type: 'mention', title: `${commenterName} mentioned you`, body: `In task: ${task.title}` });
                    }
                }
            }
        } catch (mentionErr) {
            req.log.error({ err: mentionErr }, 'Mention notification error:');
        }

        res.json(comment);
    } catch (err) {
        req.log.error({ err: err }, 'Error adding comment:');
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// ─── Edit comment (author only) ───────────────────────────────────────────
router.put('/:id/comments/:commentId', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!task || !(await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole))) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const comment = (await req.db.query('SELECT * FROM task_comments WHERE id = $1 AND task_id = $2', [req.params.commentId, req.params.id])).rows[0];
        if (!comment || comment.user_id !== req.userId) return res.status(404).json({ error: 'Comment not found' });

        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (content.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or less' });

        await req.db.query('UPDATE task_comments SET content = $1, updated_at = $2 WHERE id = $3',
            [content.trim(), new Date().toISOString(), req.params.commentId]);

        const updated = (await req.db.query(`
            SELECT tc.*, u.username, u.full_name, u.avatar
            FROM task_comments tc
            JOIN users u ON u.id = tc.user_id
            WHERE tc.id = $1
        `, [req.params.commentId])).rows[0];

        res.json(updated);
    } catch (err) {
        req.log.error({ err: err }, 'Error updating comment:');
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// ─── Delete comment (author or task creator) ──────────────────────────────
router.delete('/:id/comments/:commentId', auth, loadUserContext, async (req, res) => {
    try {
        const task = (await req.db.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
        if (!task || !(await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole))) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const comment = (await req.db.query('SELECT * FROM task_comments WHERE id = $1 AND task_id = $2', [req.params.commentId, req.params.id])).rows[0];
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.user_id !== req.userId && (!task || task.user_id !== req.userId)) {
            return res.status(403).json({ error: 'Cannot delete this comment' });
        }

        await req.db.query('DELETE FROM task_comments WHERE id = $1', [req.params.commentId]);
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        req.log.error({ err: err }, 'Error deleting comment:');
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;