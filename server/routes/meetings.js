const express = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { sendToUser } = require('../utils/ws');
const { notifyByEmail } = require('../utils/mailer');
const redis = require('../redis');
const { requireTenant } = require('../middleware/tenant');
const { provisionBroadcast } = require('../utils/hlsBroadcast');

const router = express.Router();
router.use(auth, requireTenant);
router.use(loadUserContext);

// In-memory registry of active HLS broadcasts per meeting (single-process). For
// multi-instance deployments swap this for Redis keys: hls:meeting:<id>.
// Schema: meetingId -> { broadcastId, hlsUrl, hostId, startedAt, mediaServer }
const activeBroadcasts = new Map();

/** Generate a unique meeting code: XXX-XXXX-XXX */
async function generateMeetingCode(db) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 20; attempt++) {
        const part = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
        const code = `${part(3)}-${part(4)}-${part(3)}`;
        const exists = (await db.query('SELECT 1 FROM meetings WHERE meeting_code = $1', [code])).rows[0];
        if (!exists) return code;
    }
    throw new Error('Could not generate unique meeting code');
}

/** Insert a system message into a conversation and broadcast it */
async function insertSystemMessage(conversationId, senderId, metadata, db, tenantId) {
    const result = (await db.query(
        `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
         VALUES ($1, $2, $3, 'system', $4) RETURNING id, created_at`,
        [conversationId, senderId, metadata.text || '', JSON.stringify(metadata)]
    )).rows[0];

    const participants = (await db.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
        [conversationId]
    )).rows;

    const outMsg = {
        id: result.id,
        conversationId,
        senderId,
        content: metadata.text || '',
        formatType: 'system',
        metadata,
        createdAt: result.created_at
    };

    for (const p of participants) {
        sendToUser(tenantId, p.user_id, 'chat_message', outMsg);
    }
    return result;
}

/** Check which users have conflicting calendar events in a time range */
async function getConflictsForUsers(userIds, startTime, endTime, db) {
    if (!userIds.length) return {};
    // Batch query: fetch all conflicts in a single query instead of per-user
    const rows = (await db.query(
        `SELECT user_id, id, title, start_time, end_time
         FROM calendar_events
         WHERE user_id = ANY($1)
           AND start_time < $3::timestamptz
           AND end_time > $2::timestamptz
         ORDER BY user_id, start_time
         LIMIT 100`,
        [userIds, startTime, endTime]
    )).rows;

    const conflicts = {};
    for (const row of rows) {
        if (!conflicts[row.user_id]) conflicts[row.user_id] = [];
        if (conflicts[row.user_id].length < 3) {
            conflicts[row.user_id].push({ id: row.id, title: row.title, start_time: row.start_time, end_time: row.end_time });
        }
    }
    return conflicts;
}

// ─── Check participant conflicts for a time slot ────────────────────────────
router.post('/check-conflicts', async (req, res) => {
    try {
        const { user_ids, start_time, end_time } = req.body;
        if (!Array.isArray(user_ids) || !user_ids.length || !start_time || !end_time) {
            return res.json({ conflicts: [] });
        }
        const ids = user_ids.map(Number).filter(n => n > 0);
        if (!ids.length) return res.json({ conflicts: [] });

        // Restrict to users in the same org to prevent cross-tenant data leakage
        const orgFilteredRes = req.userOrgId
            ? await req.db.query('SELECT id FROM users WHERE id = ANY($1) AND org_id = $2', [ids, req.userOrgId])
            : { rows: [] };
        const orgIds = orgFilteredRes.rows.map(r => r.id);
        if (!orgIds.length) return res.json({ conflicts: [] });

        const conflictMap = await getConflictsForUsers(orgIds, start_time, end_time, req.db);
        const result = [];
        for (const uid of ids) {
            if (conflictMap[uid]) {
                const userInfo = (await req.db.query(
                    'SELECT full_name, username FROM users WHERE id = $1', [uid]
                )).rows[0];
                result.push({
                    userId: uid,
                    name: userInfo?.full_name || userInfo?.username || 'Unknown',
                    events: conflictMap[uid]
                });
            }
        }
        res.json({ conflicts: result });
    } catch (err) {
        req.log.error({ err }, 'Check conflicts error');
        res.status(500).json({ error: 'Failed to check conflicts' });
    }
});

// ─── List user's meetings ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { status, limit = 20, offset = 0 } = req.query;
        const statusFilter = status ? `AND m.status = $3` : '';
        const params = [req.userId, req.userOrgId || null];
        if (status) params.push(status);
        params.push(parseInt(limit, 10) || 20, parseInt(offset, 10) || 0);

        const result = await req.db.query(
            `SELECT m.*,
                    u.full_name AS organizer_name, u.avatar AS organizer_avatar,
                    ce.title AS calendar_title, ce.start_time AS calendar_start,
                    (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS participant_count,
                    (SELECT status FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = $1) AS my_status
             FROM meetings m
             JOIN users u ON u.id = m.created_by
             LEFT JOIN calendar_events ce ON ce.id = m.calendar_event_id
             WHERE m.org_id = $2
               AND (m.created_by = $1 OR EXISTS (
                   SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = $1
               ))
               ${statusFilter}
             ORDER BY m.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'List meetings error');
        res.status(500).json({ error: 'Failed to fetch meetings' });
    }
});

// ─── Get meeting by code ────────────────────────────────────────────────────
router.get('/:code', async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT m.*,
                    u.full_name AS organizer_name, u.avatar AS organizer_avatar,
                    ce.title AS calendar_title, ce.start_time AS calendar_start, ce.end_time AS calendar_end
             FROM meetings m
             JOIN users u ON u.id = m.created_by
             LEFT JOIN calendar_events ce ON ce.id = m.calendar_event_id
             WHERE m.meeting_code = $1
               AND (
                   m.org_id = $2
                   OR m.created_by = $3
                   OR EXISTS (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = $3)
               )`,
            [req.params.code, req.userOrgId, req.userId]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Meeting not found' });

        const meeting = result.rows[0];

        // Fetch participants (with Redis cache for active meetings)
        let participantRows = await redis.getMeetingParticipants(req.tenantId, meeting.id);
        if (!participantRows) {
            participantRows = (await req.db.query(
                `SELECT mp.*, u.full_name, u.avatar, u.username
                 FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
                 WHERE mp.meeting_id = $1 ORDER BY mp.id`,
                [meeting.id]
            )).rows;
            if (meeting.status === 'active' || meeting.status === 'scheduled') {
                await redis.setMeetingParticipants(req.tenantId, meeting.id, participantRows);
            }
        }
        meeting.participants = participantRows;
        res.json(meeting);
    } catch (err) {
        req.log.error({ err }, 'Get meeting error');
        res.status(500).json({ error: 'Failed to fetch meeting' });
    }
});

// ─── Create meeting ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { title, description, required_participant_ids, optional_participant_ids, participant_ids, calendar_event_id, settings, start_time, end_time } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
        if (title.trim().length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' });
        if (!req.userOrgId) return res.status(403).json({ error: 'You must belong to an organization to create meetings' });

        const code = await generateMeetingCode(req.db);

        // Support both new (required/optional) and legacy (participant_ids) formats
        const requiredIds = Array.isArray(required_participant_ids)
            ? required_participant_ids.map(Number).filter(n => n > 0 && n !== req.userId)
            : [];
        const optionalIds = Array.isArray(optional_participant_ids)
            ? optional_participant_ids.map(Number).filter(n => n > 0 && n !== req.userId && !requiredIds.includes(n))
            : [];
        // Legacy fallback
        const legacyIds = (!required_participant_ids && !optional_participant_ids && Array.isArray(participant_ids))
            ? participant_ids.map(Number).filter(n => n > 0 && n !== req.userId)
            : [];
        const inviteeIds = legacyIds.length > 0 ? legacyIds : [...requiredIds, ...optionalIds];

        const result = await req.db.transaction(async (client) => {
            // 1. Create group conversation for the meeting
            const conv = (await client.query(
                `INSERT INTO conversations (org_id, name, is_group, created_at, updated_at)
                 VALUES ($1, $2, TRUE, NOW(), NOW()) RETURNING id`,
                [req.userOrgId, `Meeting: ${title.trim()}`]
            )).rows[0];

            // 2. Add creator as participant of conversation
            const allParticipantIds = [req.userId, ...inviteeIds];
            for (const uid of allParticipantIds) {
                await client.query(
                    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [conv.id, uid]
                );
            }

            // 3. Create the meeting record
            const meetingSettings = { muteOnJoin: false, allowScreenShare: true, ...(settings || {}) };
            const meeting = (await client.query(
                `INSERT INTO meetings (org_id, title, description, meeting_code, created_by, conversation_id, calendar_event_id, settings)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [req.userOrgId, title.trim(), description || null, code, req.userId, conv.id, calendar_event_id || null, JSON.stringify(meetingSettings)]
            )).rows[0];

            // 4. Add organizer to meeting_participants
            await client.query(
                `INSERT INTO meeting_participants (meeting_id, user_id, role, status) VALUES ($1, $2, 'organizer', 'invited')`,
                [meeting.id, req.userId]
            );

            // 5. Add invitees with their participant_type
            for (const uid of requiredIds.length > 0 || optionalIds.length > 0 ? requiredIds : legacyIds) {
                await client.query(
                    `INSERT INTO meeting_participants (meeting_id, user_id, role, status, participant_type) VALUES ($1, $2, 'participant', 'invited', 'required')`,
                    [meeting.id, uid]
                );
            }
            for (const uid of optionalIds) {
                await client.query(
                    `INSERT INTO meeting_participants (meeting_id, user_id, role, status, participant_type) VALUES ($1, $2, 'participant', 'invited', 'optional')`,
                    [meeting.id, uid]
                );
            }

            // 6. Link calendar event if provided
            if (calendar_event_id) {
                await client.query(
                    `UPDATE calendar_events SET meeting_id = $1 WHERE id = $2 AND user_id = $3`,
                    [meeting.id, calendar_event_id, req.userId]
                );
            }

            return { meeting, conversationId: conv.id };
        });

        const { meeting, conversationId } = result;

        // Get organizer info
        const organizer = (await req.db.query('SELECT full_name, avatar FROM users WHERE id = $1', [req.userId])).rows[0];

        // Insert meeting card message + system message
        await insertSystemMessage(conversationId, req.userId, {
            type: 'meeting_created',
            meetingId: meeting.id,
            meetingCode: code,
            title: meeting.title,
            text: `Meeting "${meeting.title}" created`
        }, req.db, req.tenantId);

        // Check conflicts for all invitees if time range provided
        const conflictMap = (start_time && end_time)
            ? await getConflictsForUsers(inviteeIds, start_time, end_time, req.db)
            : {};

        // Send notifications to invitees
        for (const uid of inviteeIds) {
            const conflictEvents = conflictMap[uid] || [];
            const hasConflict = conflictEvents.length > 0;
            const conflictTitle = hasConflict ? conflictEvents[0].title : null;
            const notifBody = hasConflict
                ? `${organizer?.full_name || 'Someone'} invited you to "${meeting.title}" — ⚠️ Conflicts with "${conflictTitle}"`
                : `${organizer?.full_name || 'Someone'} invited you to "${meeting.title}"`;

            await req.db.query(
                `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'meeting_invite', $2, $3)`,
                [uid, `Meeting invitation`, notifBody]
            );
            sendToUser(req.tenantId, uid, 'meeting_invite', {
                meetingId: meeting.id,
                meetingCode: code,
                title: meeting.title,
                organizerName: organizer?.full_name,
                organizerAvatar: organizer?.avatar,
                conversationId,
                hasConflict,
                conflictTitle,
            });

            // Send email notification to participant
            const inviteeUser = (await req.db.query('SELECT id, full_name, email, username FROM users WHERE id = $1', [uid])).rows[0];
            if (inviteeUser) {
                notifyByEmail('meetingScheduled', inviteeUser, { title: meeting.title, meeting_code: code, start_time, end_time }, organizer?.full_name || 'Someone');
            }
        }

        res.json({ ...meeting, conversation_id: conversationId });
    } catch (err) {
        req.log.error({ err }, 'Create meeting error');
        res.status(500).json({ error: 'Failed to create meeting' });
    }
});

// ─── Update meeting settings ────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
    try {
        const meetingId = Number(req.params.id);
        const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1 AND created_by = $2', [meetingId, req.userId])).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found or not organizer' });
        if (meeting.org_id !== req.userOrgId) return res.status(403).json({ error: 'Access denied' });
        if (meeting.status === 'ended') return res.status(400).json({ error: 'Cannot update ended meeting' });

        const { title, description, settings } = req.body;
        const newSettings = settings ? { ...meeting.settings, ...settings } : meeting.settings;

        const result = await req.db.query(
            `UPDATE meetings SET
                title = COALESCE($1, title),
                description = COALESCE($2, description),
                settings = $3
             WHERE id = $4 RETURNING *`,
            [title?.trim() || null, description ?? null, JSON.stringify(newSettings), meetingId]
        );

        const updatedMeeting = result.rows[0];

        // Notify participants about meeting update via WS and email
        const organizer = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];
        const participants = (await req.db.query(
            `SELECT mp.user_id, u.full_name, u.email, u.username
             FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
             WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
            [meetingId, req.userId]
        )).rows;

        for (const p of participants) {
            sendToUser(p.user_id, 'meeting_updated', { meetingId, title: updatedMeeting.title });
            notifyByEmail('meetingUpdated', p, { title: updatedMeeting.title, meeting_code: updatedMeeting.meeting_code }, organizer?.full_name || 'Someone');
        }

        if (meeting.conversation_id) {
            await insertSystemMessage(meeting.conversation_id, req.userId, {
                type: 'meeting_updated',
                meetingId,
                text: `Meeting "${updatedMeeting.title}" was updated`
            }, req.db, req.tenantId);
        }

        res.json(updatedMeeting);
    } catch (err) {
        req.log.error({ err }, 'Update meeting error');
        res.status(500).json({ error: 'Failed to update meeting' });
    }
});

// ─── Cancel meeting ─────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const meetingId = Number(req.params.id);
        const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1 AND created_by = $2', [meetingId, req.userId])).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found or not organizer' });

        await req.db.query(`UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1`, [meetingId]);

        // Delete calendar events for ALL participants (including organizer)
        await req.db.query('DELETE FROM calendar_events WHERE meeting_id = $1', [meetingId]);

        // Get organizer info for email
        const organizer = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];

        // Notify participants via WS and email
        const participants = (await req.db.query(
            `SELECT mp.user_id, u.full_name, u.email, u.username
             FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
             WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
            [meetingId, req.userId]
        )).rows;
        for (const p of participants) {
            sendToUser(p.user_id, 'meeting_cancelled', { meetingId, title: meeting.title });
            notifyByEmail('meetingCancelled', p, { title: meeting.title, meeting_code: meeting.meeting_code }, organizer?.full_name || 'Someone');
        }

        if (meeting.conversation_id) {
            await insertSystemMessage(meeting.conversation_id, req.userId, {
                type: 'meeting_cancelled',
                meetingId,
                text: `Meeting "${meeting.title}" was cancelled`
            }, req.db, req.tenantId);
        }

        res.json({ message: 'Meeting cancelled' });
    } catch (err) {
        req.log.error({ err }, 'Cancel meeting error');
        res.status(500).json({ error: 'Failed to cancel meeting' });
    }
});

// ─── Get participants ───────────────────────────────────────────────────────
router.get('/:id/participants', async (req, res) => {
    try {
        const meetingId = Number(req.params.id);
        const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        // Verify the meeting belongs to the user's org
        if (meeting.org_id && meeting.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Must be a participant or organizer
        const access = (await req.db.query(
            'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
            [meetingId, req.userId]
        )).rows[0];
        if (!access && meeting.created_by !== req.userId) return res.status(403).json({ error: 'Access denied' });

        const result = await req.db.query(
            `SELECT mp.*, u.full_name, u.avatar, u.username, u.role
             FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
             WHERE mp.meeting_id = $1 ORDER BY mp.role DESC, mp.id`,
            [meetingId]
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'Get participants error');
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
});

// ─── Add participant to meeting ─────────────────────────────────────────────
router.post('/:id/participants', async (req, res) => {
    try {
        const meetingId = Number(req.params.id);
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });

        const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
        if (meeting.created_by !== req.userId) return res.status(403).json({ error: 'Only organizer can add participants' });
        if (meeting.status === 'ended') return res.status(400).json({ error: 'Meeting has ended' });

        const targetUser = (await req.db.query('SELECT id, full_name, avatar, username, org_id FROM users WHERE id = $1', [user_id])).rows[0];
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        if (meeting.org_id && targetUser.org_id !== meeting.org_id) return res.status(403).json({ error: 'Cannot add participants from a different organization' });

        // Add to meeting_participants
        await req.db.query(
            `INSERT INTO meeting_participants (meeting_id, user_id, role, status)
             VALUES ($1, $2, 'participant', 'invited') ON CONFLICT (meeting_id, user_id) DO NOTHING`,
            [meetingId, user_id]
        );
        await redis.invalidateMeetingParticipants(req.tenantId, meetingId);

        // Add to conversation
        if (meeting.conversation_id) {
            await req.db.query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [meeting.conversation_id, user_id]
            );
        }

        const organizer = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.userId])).rows[0];

        // Check if new participant has a conflict with this meeting's calendar event
        let hasConflict = false;
        let conflictTitle = null;
        const calEvent = (await req.db.query(
            'SELECT start_time, end_time FROM calendar_events WHERE meeting_id = $1 AND user_id = $2 LIMIT 1',
            [meetingId, meeting.created_by]
        )).rows[0];
        if (calEvent) {
            const overlapping = (await req.db.query(
                `SELECT title FROM calendar_events
                 WHERE user_id = $1
                   AND start_time < $3::timestamptz
                   AND end_time > $2::timestamptz
                   AND meeting_id IS DISTINCT FROM $4
                 LIMIT 1`,
                [user_id, calEvent.start_time, calEvent.end_time, meetingId]
            )).rows;
            if (overlapping.length > 0) {
                hasConflict = true;
                conflictTitle = overlapping[0].title;
            }
        }

        // Notify invitee
        const notifBody = hasConflict
            ? `${organizer?.full_name || 'Someone'} invited you to "${meeting.title}" — ⚠️ Conflicts with "${conflictTitle}"`
            : `${organizer?.full_name || 'Someone'} invited you to "${meeting.title}"`;
        await req.db.query(
            `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'meeting_invite', $2, $3)`,
            [user_id, `Meeting invitation`, notifBody]
        );
        sendToUser(req.tenantId, user_id, 'meeting_invite', {
            meetingId,
            meetingCode: meeting.meeting_code,
            title: meeting.title,
            organizerName: organizer?.full_name,
            conversationId: meeting.conversation_id,
            isOngoing: meeting.status === 'active',
            hasConflict,
            conflictTitle,
        });

        res.json({ message: 'Participant added', user: targetUser, hasConflict, conflictTitle });
    } catch (err) {
        req.log.error({ err }, 'Add participant error');
        res.status(500).json({ error: 'Failed to add participant' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// HLS BROADCAST — videosdk-hls-style large-meeting mode
// ─────────────────────────────────────────────────────────────────────────────
// Provisions an HLS broadcast slot on the configured media server (see
// server/utils/hlsBroadcast.js for the supported back-ends). One broadcast
// per meeting; only the meeting organizer (or any participant with the
// `canBroadcast` flag) may start one. The publisher uploads chunks via
// useHlsBroadcast on the client; viewers stream the m3u8 via <HlsViewer />.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:code/hls/start', async (req, res) => {
    try {
        const code = req.params.code;
        const meeting = (await req.db.query(
            'SELECT * FROM meetings WHERE meeting_code = $1', [code]
        )).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        // Only organizer may start the broadcast (allow any participant if
        // the meeting settings explicitly opt-in via `allowAnyBroadcaster`).
        const settings = meeting.settings || {};
        const isOrganizer = meeting.created_by === req.userId;
        if (!isOrganizer && !settings.allowAnyBroadcaster) {
            return res.status(403).json({ error: 'Only the meeting organizer can start a broadcast' });
        }

        // Must be a participant
        const isParticipant = (await req.db.query(
            'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
            [meeting.id, req.userId]
        )).rows[0];
        if (!isParticipant && !isOrganizer) {
            return res.status(403).json({ error: 'Not a participant' });
        }

        // Already broadcasting? Return existing info (idempotent).
        const existing = activeBroadcasts.get(meeting.id);
        if (existing) {
            // Same publisher — return existing creds
            if (existing.hostId === req.userId) {
                return res.json(existing);
            }
            return res.status(409).json({
                error: 'A broadcast is already active for this meeting',
                hlsUrl: existing.hlsUrl,
            });
        }

        const broadcast = provisionBroadcast({ meetingId: meeting.id, userId: req.userId });
        if (!broadcast) {
            return res.status(501).json({
                error: 'HLS broadcasting is not configured on this server. Set HLS_MEDIA_SERVER, HLS_INGEST_BASE_URL and HLS_PLAYBACK_BASE_URL.',
            });
        }

        const record = {
            ...broadcast,
            hostId: req.userId,
            startedAt: new Date().toISOString(),
        };
        activeBroadcasts.set(meeting.id, record);

        // Notify all participants so HlsViewer can mount automatically.
        const parts = (await req.db.query(
            'SELECT user_id FROM meeting_participants WHERE meeting_id = $1', [meeting.id]
        )).rows;
        for (const p of parts) {
            sendToUser(req.tenantId, p.user_id, 'meeting_hls_started', {
                meetingId: meeting.id,
                meetingCode: code,
                hlsUrl: broadcast.hlsUrl,
                hostId: req.userId,
            });
        }

        // Return ingest creds ONLY to the publisher; viewers get hlsUrl via WS event.
        res.json({
            broadcastId: broadcast.broadcastId,
            ingestUrl: broadcast.ingestUrl,
            hlsUrl: broadcast.hlsUrl,
            mediaServer: broadcast.mediaServer,
            expiresAt: broadcast.expiresAt,
        });
    } catch (err) {
        req.log.error({ err }, 'HLS start error');
        res.status(500).json({ error: 'Failed to start broadcast' });
    }
});

router.post('/:code/hls/stop', async (req, res) => {
    try {
        const code = req.params.code;
        const meeting = (await req.db.query(
            'SELECT id, created_by FROM meetings WHERE meeting_code = $1', [code]
        )).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        const existing = activeBroadcasts.get(meeting.id);
        if (!existing) return res.json({ ok: true, alreadyStopped: true });

        // Allow either the host who started it, or the meeting organizer, to stop it.
        if (existing.hostId !== req.userId && meeting.created_by !== req.userId) {
            return res.status(403).json({ error: 'Only the broadcasting host or organizer can stop' });
        }
        // Optional broadcastId check prevents stopping a different broadcast that was
        // started after a quick restart.
        if (req.body?.broadcastId && req.body.broadcastId !== existing.broadcastId) {
            return res.status(409).json({ error: 'broadcastId does not match the active broadcast' });
        }

        activeBroadcasts.delete(meeting.id);

        const parts = (await req.db.query(
            'SELECT user_id FROM meeting_participants WHERE meeting_id = $1', [meeting.id]
        )).rows;
        for (const p of parts) {
            sendToUser(req.tenantId, p.user_id, 'meeting_hls_stopped', {
                meetingId: meeting.id,
                meetingCode: code,
                broadcastId: existing.broadcastId,
            });
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, 'HLS stop error');
        res.status(500).json({ error: 'Failed to stop broadcast' });
    }
});

router.get('/:code/hls/status', async (req, res) => {
    try {
        const code = req.params.code;
        const meeting = (await req.db.query(
            'SELECT id FROM meetings WHERE meeting_code = $1', [code]
        )).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        const isParticipant = (await req.db.query(
            'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
            [meeting.id, req.userId]
        )).rows[0];
        if (!isParticipant) return res.status(403).json({ error: 'Not a participant' });

        const existing = activeBroadcasts.get(meeting.id);
        if (!existing) return res.json({ live: false });

        // Viewers only need hlsUrl; never leak ingest creds to non-publishers.
        const isHost = existing.hostId === req.userId;
        res.json({
            live: true,
            hlsUrl: existing.hlsUrl,
            hostId: existing.hostId,
            startedAt: existing.startedAt,
            mediaServer: existing.mediaServer,
            ...(isHost ? { ingestUrl: existing.ingestUrl, broadcastId: existing.broadcastId } : {}),
        });
    } catch (err) {
        req.log.error({ err }, 'HLS status error');
        res.status(500).json({ error: 'Failed to get broadcast status' });
    }
});

// ─── Remove participant ─────────────────────────────────────────────────────
router.delete('/:id/participants/:userId', async (req, res) => {
    try {
        const meetingId = Number(req.params.id);
        const targetId = Number(req.params.userId);

        const meeting = (await req.db.query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        // Organizer can remove anyone; user can remove themselves
        if (meeting.created_by !== req.userId && req.userId !== targetId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await req.db.query('DELETE FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2', [meetingId, targetId]);
        await redis.invalidateMeetingParticipants(req.tenantId, meetingId);
        sendToUser(req.tenantId, targetId, 'meeting_removed', { meetingId, title: meeting.title });

        res.json({ message: 'Participant removed' });
    } catch (err) {
        req.log.error({ err }, 'Remove participant error');
        res.status(500).json({ error: 'Failed to remove participant' });
    }
});

module.exports = router;
