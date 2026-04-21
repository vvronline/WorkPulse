const express = require('express');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { getOffsetMin } = require('../utils/timezone');
const { sendToUser } = require('../utils/ws');
const { notifyByEmail } = require('../utils/mailer');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();
router.use(auth, requireTenant);
router.use(loadUserContext);

// List events for a date range
router.get('/', async (req, res) => {
    try {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to query params required' });
        const result = await req.db.query(
            `SELECT ce.*, t.title AS task_title, t.status AS task_status, t.priority AS task_priority,
                    m.meeting_code, m.status AS meeting_status, m.conversation_id AS meeting_conversation_id,
                    m.created_by AS meeting_created_by
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
        const startDate = new Date(start_time);
        const endDate = new Date(end_time);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            return res.status(400).json({ error: 'Invalid start_time or end_time' });
        }
        if (endDate <= startDate) return res.status(400).json({ error: 'end_time must be after start_time' });

        const now = new Date();
        if (all_day) {
            // Compare local dates for all-day events so "today" remains valid.
            const offsetMin = getOffsetMin(req);
            const toLocalDate = (d) => new Date(d.getTime() - offsetMin * 60000).toISOString().slice(0, 10);
            if (toLocalDate(startDate) < toLocalDate(now)) {
                return res.status(400).json({ error: 'Cannot create events in the past' });
            }
        } else if (startDate < now) {
            return res.status(400).json({ error: 'Cannot create events in the past' });
        }

        // Rate limit: max 1000 events per user (atomic check)
        const countRes = await req.db.query('SELECT COUNT(*) AS c FROM calendar_events WHERE user_id = $1 FOR SHARE', [req.userId]);
        if (parseInt(countRes.rows[0].c, 10) >= 1000) {
            return res.status(400).json({ error: 'Maximum event limit reached (1000). Delete old events first.' });
        }

        // If linked to a meeting, validate meeting belongs to user's org BEFORE creating the event
        if (meeting_id) {
            const meetingCheck = (await req.db.query(
                'SELECT id FROM meetings WHERE id = $1 AND org_id = $2',
                [meeting_id, req.userOrgId]
            )).rows[0];
            if (!meetingCheck) {
                return res.status(403).json({ error: 'Meeting not found in your organization' });
            }
        }

        const result = await req.db.query(
            `INSERT INTO calendar_events (user_id, org_id, title, description, start_time, end_time, all_day, color, task_id, meeting_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [req.userId, req.userOrgId || null, title.trim(), description || null, start_time, end_time, all_day || false, color || '#6366f1', task_id || null, meeting_id || null]
        );

        // If linked to a meeting, create events for other participants
        if (meeting_id) {
            const otherParticipants = (await req.db.query(
                `SELECT mp.user_id FROM meeting_participants mp
                 WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
                [meeting_id, req.userId]
            )).rows;
            for (const p of otherParticipants) {
                const existing = (await req.db.query(
                    'SELECT id FROM calendar_events WHERE user_id = $1 AND meeting_id = $2',
                    [p.user_id, meeting_id]
                )).rows[0];
                if (!existing) {
                    await req.db.query(
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
        const existing = await req.db.query('SELECT * FROM calendar_events WHERE id = $1 AND user_id = $2 AND (org_id = $3 OR org_id IS NULL)', [eventId, req.userId, req.userOrgId || null]);
        if (!existing.rows[0]) return res.status(404).json({ error: 'Event not found' });

        const event = existing.rows[0];

        // If this event is linked to a meeting, only the organizer can edit it
        if (event.meeting_id) {
            const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1', [event.meeting_id])).rows[0];
            if (meeting && meeting.created_by !== req.userId) {
                return res.status(403).json({ error: 'Only the meeting organizer can edit this event' });
            }
        }

        const { title, description, start_time, end_time, all_day, color, task_id } = req.body;
        // Validate time ordering against whichever value will actually be stored
        const effectiveStart = start_time ? new Date(start_time) : new Date(event.start_time);
        const effectiveEnd = end_time ? new Date(end_time) : new Date(event.end_time);
        if (effectiveEnd <= effectiveStart) {
            return res.status(400).json({ error: 'end_time must be after start_time' });
        }
        const result = await req.db.query(
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
            [title?.trim(), description, start_time, end_time, all_day, color, task_id !== undefined ? (task_id || null) : event.task_id, eventId, req.userId, req.userOrgId || null]
        );

        // If linked to a meeting, also update all other participants' calendar events and notify them
        if (event.meeting_id) {
            await req.db.query(
                `UPDATE calendar_events SET
                    title = COALESCE($1, title),
                    description = COALESCE($2, description),
                    start_time = COALESCE($3, start_time),
                    end_time = COALESCE($4, end_time),
                    all_day = COALESCE($5, all_day),
                    color = COALESCE($6, color),
                    updated_at = NOW()
                 WHERE meeting_id = $7 AND user_id != $8`,
                [title?.trim(), description, start_time, end_time, all_day, color, event.meeting_id, req.userId]
            );

            const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1', [event.meeting_id])).rows[0];
            if (meeting) {
                const organizer = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
                const participants = (await req.db.query(
                    `SELECT mp.user_id, u.full_name, u.email, u.username
                     FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
                     WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
                    [event.meeting_id, req.userId]
                )).rows;
                for (const p of participants) {
                    sendToUser(req.tenantId, p.user_id, 'meeting_updated', { meetingId: event.meeting_id, title: meeting.title });
                    notifyByEmail('meetingUpdated', p, { title: meeting.title, meeting_code: meeting.meeting_code }, organizer?.full_name || 'Someone');
                }
            }
        }

        res.json(result.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Update event error');
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// Cancel / Delete event
router.delete('/:id', async (req, res) => {
    try {
        const eventId = Number(req.params.id);
        const event = (await req.db.query('SELECT * FROM calendar_events WHERE id = $1 AND user_id = $2 AND (org_id = $3 OR org_id IS NULL)', [eventId, req.userId, req.userOrgId || null])).rows[0];
        if (!event) return res.status(404).json({ error: 'Event not found' });

        // If linked to a meeting, only the organizer can cancel it
        if (event.meeting_id) {
            const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1', [event.meeting_id])).rows[0];
            if (meeting && meeting.created_by !== req.userId) {
                return res.status(403).json({ error: 'Only the meeting organizer can cancel this event' });
            }

            if (meeting) {
                // Cancel the meeting
                await req.db.query(`UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1`, [event.meeting_id]);

                // Delete calendar events for ALL participants
                await req.db.query('DELETE FROM calendar_events WHERE meeting_id = $1', [event.meeting_id]);

                // Notify all participants
                const organizer = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
                const participants = (await req.db.query(
                    `SELECT mp.user_id, u.full_name, u.email, u.username
                     FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
                     WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
                    [event.meeting_id, req.userId]
                )).rows;
                for (const p of participants) {
                    sendToUser(req.tenantId, p.user_id, 'meeting_cancelled', { meetingId: event.meeting_id, title: meeting.title });
                    notifyByEmail('meetingCancelled', p, { title: meeting.title, meeting_code: meeting.meeting_code }, organizer?.full_name || 'Someone');
                }

                return res.json({ message: 'Event cancelled' });
            }
        }

        await req.db.query('DELETE FROM calendar_events WHERE id = $1 AND user_id = $2 AND (org_id = $3 OR org_id IS NULL)', [eventId, req.userId, req.userOrgId || null]);
        res.json({ message: 'Event cancelled' });
    } catch (err) {
        req.log.error({ err }, 'Cancel event error');
        res.status(500).json({ error: 'Failed to cancel event' });
    }
});

module.exports = router;
