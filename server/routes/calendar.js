const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');

const router = express.Router();
router.use(auth);
router.use(loadUserContext);

// List events for a date range
router.get('/', async (req, res) => {
    try {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to query params required' });
        const result = await query(
            `SELECT ce.*, t.title AS task_title, t.status AS task_status, t.priority AS task_priority,
                    m.meeting_code, m.status AS meeting_status, m.conversation_id AS meeting_conversation_id
             FROM calendar_events ce
             LEFT JOIN tasks t ON t.id = ce.task_id
             LEFT JOIN meetings m ON m.id = ce.meeting_id
             WHERE ce.user_id = $1 AND (ce.org_id = $2 OR ce.org_id IS NULL)
               AND ce.start_time < $4::timestamptz AND ce.end_time > $3::timestamptz
             ORDER BY ce.start_time`,
            [req.userId, req.userOrgId || null, from, to]
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'List events error');
        res.status(500).json({ error: 'Failed to fetch events' });
    }
});

// Create event
router.post('/', async (req, res) => {
    try {
        const { title, description, start_time, end_time, all_day, color, task_id, meeting_id } = req.body;
        if (!title || !start_time || !end_time) return res.status(400).json({ error: 'title, start_time, end_time required' });
        if (title.trim().length > 200) return res.status(400).json({ error: 'Title must be 200 characters or less' });
        if (description && description.length > 2000) return res.status(400).json({ error: 'Description must be 2000 characters or less' });
        if (new Date(end_time) <= new Date(start_time)) return res.status(400).json({ error: 'end_time must be after start_time' });

        // Rate limit: max 100 events per user
        const countRes = await query('SELECT COUNT(*) AS c FROM calendar_events WHERE user_id = $1', [req.userId]);
        if (parseInt(countRes.rows[0].c, 10) >= 1000) {
            return res.status(400).json({ error: 'Maximum event limit reached (1000). Delete old events first.' });
        }

        const result = await query(
            `INSERT INTO calendar_events (user_id, org_id, title, description, start_time, end_time, all_day, color, task_id, meeting_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [req.userId, req.userOrgId || null, title.trim(), description || null, start_time, end_time, all_day || false, color || '#6366f1', task_id || null, meeting_id || null]
        );

        // If linked to a meeting, also create calendar events for all other participants
        if (meeting_id) {
            const otherParticipants = (await query(
                `SELECT mp.user_id FROM meeting_participants mp
                 WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
                [meeting_id, req.userId]
            )).rows;
            for (const p of otherParticipants) {
                const existing = (await query(
                    'SELECT id FROM calendar_events WHERE user_id = $1 AND meeting_id = $2',
                    [p.user_id, meeting_id]
                )).rows[0];
                if (!existing) {
                    await query(
                        `INSERT INTO calendar_events (user_id, org_id, title, description, start_time, end_time, all_day, color, meeting_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                        [p.user_id, req.userOrgId || null, title.trim(), description || null, start_time, end_time, all_day || false, color || '#6366f1', meeting_id]
                    );
                }
            }
        }

        res.json(result.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Create event error');
        res.status(500).json({ error: 'Failed to create event' });
    }
});

// Update event
router.put('/:id', async (req, res) => {
    try {
        const eventId = Number(req.params.id);
        const existing = await query('SELECT * FROM calendar_events WHERE id = $1 AND user_id = $2 AND (org_id = $3 OR org_id IS NULL)', [eventId, req.userId, req.userOrgId || null]);
        if (!existing.rows[0]) return res.status(404).json({ error: 'Event not found' });

        const { title, description, start_time, end_time, all_day, color, task_id } = req.body;
        // Validate time ordering against whichever value will actually be stored
        const effectiveStart = start_time ? new Date(start_time) : new Date(existing.rows[0].start_time);
        const effectiveEnd = end_time ? new Date(end_time) : new Date(existing.rows[0].end_time);
        if (effectiveEnd <= effectiveStart) {
            return res.status(400).json({ error: 'end_time must be after start_time' });
        }
        const result = await query(
            `UPDATE calendar_events SET
                title = COALESCE($1, title),
                description = COALESCE($2, description),
                start_time = COALESCE($3, start_time),
                end_time = COALESCE($4, end_time),
                all_day = COALESCE($5, all_day),
                color = COALESCE($6, color),
                task_id = $7,
                updated_at = NOW()
             WHERE id = $8 AND user_id = $9 AND (org_id = $10 OR org_id IS NULL) RETURNING *`,
            [title?.trim(), description, start_time, end_time, all_day, color, task_id !== undefined ? (task_id || null) : existing.rows[0].task_id, eventId, req.userId, req.userOrgId || null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Update event error');
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// Delete event
router.delete('/:id', async (req, res) => {
    try {
        const eventId = Number(req.params.id);
        const result = await query('DELETE FROM calendar_events WHERE id = $1 AND user_id = $2 AND (org_id = $3 OR org_id IS NULL) RETURNING id', [eventId, req.userId, req.userOrgId || null]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Event not found' });
        res.json({ message: 'Event deleted' });
    } catch (err) {
        req.log.error({ err }, 'Delete event error');
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

module.exports = router;
