/**
 * WebSocket server for real-time notifications and chat.
 * Attaches to the HTTP server and authenticates via the JWT cookie.
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { query } = require('../db');
const { logger } = require('./logger');

/** Map<userId, Set<WebSocket>> */
const clients = new Map();

function setupWebSocket(server) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

    wss.on('connection', async (ws, req) => {
        // Authenticate via cookie
        const cookies = cookie.parse(req.headers.cookie || '');
        const token = cookies.token;
        if (!token) {
            ws.close(4001, 'Unauthorized');
            return;
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            ws.close(4001, 'Unauthorized');
            return;
        }

        // Verify token_version hasn't been revoked (password change/reset)
        const userId = payload.id;
        try {
            const userRow = (await query('SELECT token_version FROM users WHERE id = $1', [userId])).rows[0];
            const tokenVersion = payload.tv ?? 0;
            if (!userRow || tokenVersion !== (userRow.token_version || 0)) {
                ws.close(4001, 'Token revoked');
                return;
            }
        } catch {
            ws.close(4001, 'Auth check failed');
            return;
        }

        // Register client
        const wasOffline = !clients.has(userId) || clients.get(userId).size === 0;
        if (!clients.has(userId)) clients.set(userId, new Set());
        clients.get(userId).add(ws);
        logger.debug({ userId }, 'WS client connected');

        // Presence: mark online
        if (wasOffline) {
            query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]).catch(() => { });
            broadcastPresence(userId, 'online');
        }

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                handleChatMessage(userId, msg);
            } catch { /* ignore non-JSON */ }
        });

        ws.on('close', () => {
            const set = clients.get(userId);
            if (set) {
                set.delete(ws);
                if (set.size === 0) {
                    clients.delete(userId);
                    // Presence: mark offline
                    query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]).catch(() => { });
                    broadcastPresence(userId, 'offline');
                }
            }
            logger.debug({ userId }, 'WS client disconnected');
        });

        ws.on('error', () => {
            ws.close();
        });

        // Heartbeat: keep connection alive
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
    });

    // Heartbeat interval
    const heartbeat = setInterval(() => {
        wss.clients.forEach(ws => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => clearInterval(heartbeat));

    return wss;
}

/** Handle incoming WS messages for chat */
async function handleChatMessage(senderId, msg) {
    if (msg.type === 'chat_message') {
        const { conversationId, content, replyToId, formatType, mentions } = msg.data || {};
        if (!conversationId || !content || typeof content !== 'string' || content.trim().length === 0 || content.length > 5000) return;

        // Verify sender is a participant
        const participant = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        // Insert message
        const replyId = replyToId ? parseInt(replyToId, 10) : null;
        const fmtType = (formatType === 'markdown' || formatType === 'code') ? formatType : 'text';
        const result = (await query(
            `INSERT INTO messages (conversation_id, sender_id, content, reply_to_id, format_type)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
            [conversationId, senderId, content.trim(), replyId, fmtType]
        )).rows[0];

        // Update conversation timestamp
        await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

        // Update sender's read cursor
        await query(
            `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3`,
            [conversationId, senderId, result.created_at]
        );

        // Get all participants to broadcast
        const participants = (await query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
            [conversationId]
        )).rows;

        // Get sender info
        const sender = (await query('SELECT full_name, avatar, username FROM users WHERE id = $1', [senderId])).rows[0];

        // Get reply details if replying (must belong to the same conversation)
        let replyContent = null, replySenderName = null;
        if (replyId) {
            const replyMsg = (await query(
                `SELECT m.content, u.full_name AS sender_name
                 FROM messages m JOIN users u ON u.id = m.sender_id
                 WHERE m.id = $1 AND m.conversation_id = $2`, [replyId, conversationId]
            )).rows[0];
            if (replyMsg) {
                replyContent = replyMsg.content;
                replySenderName = replyMsg.sender_name;
            }
        }

        const outMsg = {
            id: result.id,
            conversationId,
            senderId,
            senderName: sender?.full_name,
            senderAvatar: sender?.avatar,
            senderUsername: sender?.username,
            content: content.trim(),
            formatType: fmtType,
            replyToId: replyId,
            replyContent,
            replySenderName,
            createdAt: result.created_at
        };

        for (const p of participants) {
            sendToUser(p.user_id, 'chat_message', outMsg);
        }

        // Send mention notifications (only to verified conversation participants)
        if (Array.isArray(mentions) && mentions.length > 0) {
            const participantIdSet = new Set(participants.map(p => p.user_id));
            const mentionedIds = mentions.map(Number).filter(n => n > 0 && n !== senderId && participantIdSet.has(n));
            for (const uid of mentionedIds) {
                sendToUser(uid, 'chat_mention', {
                    conversationId,
                    messageId: result.id,
                    senderId,
                    senderName: sender?.full_name,
                    content: content.trim().slice(0, 100)
                });
            }
        }
    } else if (msg.type === 'chat_typing') {
        const { conversationId } = msg.data || {};
        if (!conversationId) return;

        // Verify sender is a participant
        const participant = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        // Notify other participants
        const participants = (await query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
            [conversationId, senderId]
        )).rows;

        for (const p of participants) {
            sendToUser(p.user_id, 'chat_typing', { conversationId, userId: senderId });
        }
    } else if (msg.type === 'chat_read') {
        const { conversationId } = msg.data || {};
        if (!conversationId) return;

        const participant = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        await query(
            `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
            [conversationId, senderId]
        );
    } else if (msg.type === 'call_initiate') {
        // Caller initiates a call → create call_log, notify participants
        const { conversationId, callType } = msg.data || {};
        if (!conversationId || !['voice', 'video'].includes(callType)) return;

        const participant = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        // Create call log entry
        const callLog = (await query(
            `INSERT INTO call_logs (conversation_id, caller_id, call_type, status)
             VALUES ($1, $2, $3, 'ringing') RETURNING id, created_at`,
            [conversationId, senderId, callType]
        )).rows[0];

        const caller = (await query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];

        // System message: call started
        const sysMsg = (await query(
            `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
             VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
            [conversationId, senderId, JSON.stringify({ type: 'call_started', callId: callLog.id, callType, callerName: caller?.full_name })]
        )).rows[0];

        // Notify all other participants about incoming call
        const participants = (await query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
            [conversationId, senderId]
        )).rows;

        // Get conversation info for the notification
        const conv = (await query('SELECT name, is_group FROM conversations WHERE id = $1', [conversationId])).rows[0];

        for (const p of participants) {
            sendToUser(p.user_id, 'call_incoming', {
                callId: callLog.id,
                conversationId,
                callerId: senderId,
                callerName: caller?.full_name,
                callerAvatar: caller?.avatar,
                callType,
                isGroup: conv?.is_group || false,
                groupName: conv?.name
            });
            // Broadcast system message to all
            sendToUser(p.user_id, 'chat_message', {
                id: sysMsg.id, conversationId, senderId, content: '', formatType: 'system',
                metadata: { type: 'call_started', callId: callLog.id, callType, callerName: caller?.full_name },
                createdAt: sysMsg.created_at
            });
        }

        // Confirm call started to caller
        sendToUser(senderId, 'call_started', {
            callId: callLog.id,
            conversationId,
            callType
        });

    } else if (msg.type === 'call_accept') {
        // Callee accepts → update call log, notify caller with acceptance
        const { callId, conversationId } = msg.data || {};
        if (!callId || !conversationId) return;

        const callLog = (await query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2 AND status = 'ringing'`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) return;

        const participant = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        await query(`UPDATE call_logs SET status = 'answered', started_at = NOW() WHERE id = $1`, [callId]);

        const accepter = (await query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];

        // Notify the caller that call was accepted
        sendToUser(callLog.caller_id, 'call_accepted', {
            callId,
            conversationId,
            userId: senderId,
            userName: accepter?.full_name,
            userAvatar: accepter?.avatar
        });

    } else if (msg.type === 'call_reject') {
        // Callee rejects → update call log, notify caller
        const { callId, conversationId } = msg.data || {};
        if (!callId || !conversationId) return;

        const callLog = (await query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) return;

        await query(
            `UPDATE call_logs SET status = 'declined', ended_at = NOW() WHERE id = $1 AND status = 'ringing'`,
            [callId]
        );

        const rejecter = (await query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];

        // Notify other participants
        const participants = (await query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
            [conversationId, senderId]
        )).rows;

        for (const p of participants) {
            sendToUser(p.user_id, 'call_rejected', {
                callId,
                conversationId,
                userId: senderId,
                userName: rejecter?.full_name
            });
        }

    } else if (msg.type === 'call_end') {
        // Either party ends the call → update log, notify others
        const { callId, conversationId } = msg.data || {};
        if (!callId || !conversationId) return;

        const callLog = (await query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) return;

        // Calculate duration if call was answered
        let duration = null;
        if (callLog.started_at) {
            duration = Math.round((Date.now() - new Date(callLog.started_at).getTime()) / 1000);
        }

        await query(
            `UPDATE call_logs SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END,
             ended_at = NOW(), duration = $2 WHERE id = $1`,
            [callId, duration]
        );

        const finalStatus = callLog.status === 'ringing' ? 'missed' : 'ended';
        const caller2 = (await query('SELECT full_name FROM users WHERE id = $1', [callLog.caller_id])).rows[0];

        // System message: call ended/missed
        const sysEndMsg = (await query(
            `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
             VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
            [conversationId, senderId, JSON.stringify({
                type: finalStatus === 'missed' ? 'call_missed' : 'call_ended',
                callId, callType: callLog.call_type, duration, callerName: caller2?.full_name
            })]
        )).rows[0];

        // Notify all participants
        const allParticipants = (await query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
            [conversationId]
        )).rows;

        for (const p of allParticipants) {
            if (p.user_id !== senderId) {
                sendToUser(p.user_id, 'call_ended', { callId, conversationId, endedBy: senderId, duration });
            }
            sendToUser(p.user_id, 'chat_message', {
                id: sysEndMsg.id, conversationId, senderId, content: '', formatType: 'system',
                metadata: {
                    type: finalStatus === 'missed' ? 'call_missed' : 'call_ended',
                    callId, callType: callLog.call_type, duration, callerName: caller2?.full_name
                },
                createdAt: sysEndMsg.created_at
            });
        }

    } else if (msg.type === 'call_signal') {
        // WebRTC signaling relay: offer, answer, ICE candidates
        const { conversationId, targetUserId, signal } = msg.data || {};
        if (!conversationId || !targetUserId || !signal) return;

        // Verify both sender and target are in the conversation
        const senderOk = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        const targetOk = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, targetUserId]
        )).rows[0];
        if (!senderOk || !targetOk) return;

        // Relay the signal to the target user
        sendToUser(targetUserId, 'call_signal', {
            conversationId,
            fromUserId: senderId,
            signal
        });

        // ═══════════════════════════════════════════════════════
        //  MEETING HANDLERS
        // ═══════════════════════════════════════════════════════
    } else if (msg.type === 'meeting_join') {
        const { meetingId } = msg.data || {};
        if (!meetingId) return;

        const meeting = (await query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
        if (!meeting) return;
        if (meeting.status === 'ended') return;

        // Verify participant is allowed
        const mp = (await query(
            'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
            [meetingId, senderId]
        )).rows[0];
        const isOrgMember = meeting.org_id
            ? (await query('SELECT 1 FROM users WHERE id = $1 AND org_id = $2', [senderId, meeting.org_id])).rows[0]
            : true;
        if (!mp && !isOrgMember) return;

        // Upsert participant
        await query(
            `INSERT INTO meeting_participants (meeting_id, user_id, role, status, joined_at)
             VALUES ($1, $2, 'participant', 'joined', NOW())
             ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'joined', joined_at = NOW(), left_at = NULL`,
            [meetingId, senderId]
        );

        // Mark meeting as active on first join
        if (meeting.status === 'scheduled') {
            await query(`UPDATE meetings SET status = 'active', started_at = NOW() WHERE id = $1`, [meetingId]);
        }

        const joiner = (await query('SELECT full_name, avatar, username FROM users WHERE id = $1', [senderId])).rows[0];

        // Get all current participants to notify + send system message
        const allParticipants = (await query(
            'SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = $2',
            [meetingId, 'joined']
        )).rows;

        // Get existing participants to signal new peer (mesh)
        const existingPeers = allParticipants.filter(p => p.user_id !== senderId).map(p => p.user_id);

        for (const p of allParticipants) {
            sendToUser(p.user_id, 'meeting_participant_joined', {
                meetingId,
                userId: senderId,
                fullName: joiner?.full_name,
                avatar: joiner?.avatar,
                username: joiner?.username,
                existingPeers: p.user_id === senderId ? existingPeers : undefined
            });
        }

        // System message in conversation
        if (meeting.conversation_id) {
            const sysMsg = (await query(
                `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
                 VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
                [meeting.conversation_id, senderId, JSON.stringify({
                    type: 'meeting_joined', meetingId, name: joiner?.full_name
                })]
            )).rows[0];
            const convParticipants = (await query(
                'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
                [meeting.conversation_id]
            )).rows;
            for (const p of convParticipants) {
                sendToUser(p.user_id, 'chat_message', {
                    id: sysMsg.id, conversationId: meeting.conversation_id, senderId,
                    content: '', formatType: 'system',
                    metadata: { type: 'meeting_joined', meetingId, name: joiner?.full_name },
                    createdAt: sysMsg.created_at
                });
            }
        }

    } else if (msg.type === 'meeting_leave') {
        const { meetingId } = msg.data || {};
        if (!meetingId) return;

        await query(
            `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1 AND user_id = $2`,
            [meetingId, senderId]
        );

        const activeParticipants = (await query(
            `SELECT mp.user_id FROM meeting_participants mp WHERE mp.meeting_id = $1 AND mp.status = 'joined'`,
            [meetingId]
        )).rows;

        for (const p of activeParticipants) {
            sendToUser(p.user_id, 'meeting_participant_left', { meetingId, userId: senderId });
        }

        // If no active participants, mark meeting ended
        if (activeParticipants.length === 0) {
            await query(`UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1`, [meetingId]);
        }

    } else if (msg.type === 'meeting_end') {
        const { meetingId } = msg.data || {};
        if (!meetingId) return;

        const meeting = (await query(
            'SELECT * FROM meetings WHERE id = $1 AND created_by = $2',
            [meetingId, senderId]
        )).rows[0];
        if (!meeting) return;

        const startedAt = meeting.started_at ? new Date(meeting.started_at) : null;
        const durationSecs = startedAt ? Math.round((Date.now() - startedAt.getTime()) / 1000) : null;

        await query(
            `UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1`,
            [meetingId]
        );
        await query(
            `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1`,
            [meetingId]
        );

        const activeParticipants = (await query(
            'SELECT user_id FROM meeting_participants WHERE meeting_id = $1',
            [meetingId]
        )).rows;

        for (const p of activeParticipants) {
            sendToUser(p.user_id, 'meeting_ended', { meetingId, endedBy: senderId, duration: durationSecs });
        }

        // System message in conversation
        if (meeting.conversation_id) {
            const sysMsg = (await query(
                `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
                 VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
                [meeting.conversation_id, senderId, JSON.stringify({
                    type: 'meeting_ended', meetingId, duration: durationSecs
                })]
            )).rows[0];
            const convParticipants = (await query(
                'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
                [meeting.conversation_id]
            )).rows;
            for (const p of convParticipants) {
                sendToUser(p.user_id, 'chat_message', {
                    id: sysMsg.id, conversationId: meeting.conversation_id, senderId,
                    content: '', formatType: 'system',
                    metadata: { type: 'meeting_ended', meetingId, duration: durationSecs },
                    createdAt: sysMsg.created_at
                });
            }
        }

    } else if (msg.type === 'meeting_signal') {
        // WebRTC mesh signaling between meeting participants
        const { meetingId, targetUserId, signal } = msg.data || {};
        if (!meetingId || !targetUserId || !signal) return;

        // Verify both are active participants
        const senderOk = (await query(
            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
            [meetingId, senderId]
        )).rows[0];
        if (!senderOk) return;

        sendToUser(targetUserId, 'meeting_signal', {
            meetingId,
            fromUserId: senderId,
            signal
        });

    } else if (msg.type === 'meeting_add_participant') {
        // Organizer adds someone to an active meeting
        const { meetingId, targetUserId } = msg.data || {};
        if (!meetingId || !targetUserId) return;

        const meeting = (await query(
            'SELECT * FROM meetings WHERE id = $1 AND created_by = $2',
            [meetingId, senderId]
        )).rows[0];
        if (!meeting || meeting.status === 'ended') return;

        const targetUser = (await query('SELECT full_name, avatar FROM users WHERE id = $1', [targetUserId])).rows[0];
        if (!targetUser) return;

        await query(
            `INSERT INTO meeting_participants (meeting_id, user_id, role, status)
             VALUES ($1, $2, 'participant', 'invited') ON CONFLICT (meeting_id, user_id) DO NOTHING`,
            [meetingId, targetUserId]
        );
        if (meeting.conversation_id) {
            await query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [meeting.conversation_id, targetUserId]
            );
        }

        const organizer = (await query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];
        sendToUser(targetUserId, 'meeting_invite', {
            meetingId,
            meetingCode: meeting.meeting_code,
            title: meeting.title,
            organizerName: organizer?.full_name,
            conversationId: meeting.conversation_id,
            isOngoing: true
        });

    } else if (msg.type === 'meeting_mute_participant') {
        // Organizer mutes a participant
        const { meetingId, targetUserId, muted } = msg.data || {};
        if (!meetingId || !targetUserId) return;

        const meeting = (await query('SELECT * FROM meetings WHERE id = $1 AND created_by = $2', [meetingId, senderId])).rows[0];
        if (!meeting) return;

        sendToUser(targetUserId, 'meeting_muted', { meetingId, muted: !!muted, byUserId: senderId });

    } else if (msg.type === 'meeting_raise_hand') {
        const { meetingId, raised } = msg.data || {};
        if (!meetingId) return;

        const participants = (await query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;

        const raiser = (await query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];
        for (const p of participants) {
            sendToUser(p.user_id, 'meeting_hand_raised', { meetingId, userId: senderId, name: raiser?.full_name, raised: !!raised });
        }

    } else if (msg.type === 'meeting_track_state') {
        // Participant broadcasts their muted/videoOff state
        const { meetingId, muted, videoOff, screenSharing } = msg.data || {};
        if (!meetingId) return;

        const participants = (await query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;

        for (const p of participants) {
            if (p.user_id !== senderId) {
                sendToUser(p.user_id, 'meeting_track_state', { meetingId, userId: senderId, muted: !!muted, videoOff: !!videoOff, screenSharing: !!screenSharing });
            }
        }

    } else if (msg.type === 'meeting_chat') {
        // In-meeting chat message relay
        const { meetingId, text } = msg.data || {};
        if (!meetingId || !text || !text.trim()) return;

        const sender = (await query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];
        const participants = (await query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;

        const message = {
            sender_id: senderId,
            sender_name: sender?.full_name || 'Participant',
            text: text.trim(),
            created_at: new Date().toISOString()
        };

        for (const p of participants) {
            sendToUser(p.user_id, 'meeting_message', { meetingId, message });
        }

    } else if (msg.type === 'call_add_participant') {
        // Add a participant to an ongoing 1:1 call (upgrade to group)
        const { callId, conversationId, targetUserId } = msg.data || {};
        if (!callId || !conversationId || !targetUserId) return;

        const callLog = (await query('SELECT * FROM call_logs WHERE id = $1 AND status = $2', [callId, 'answered'])).rows[0];
        if (!callLog) return;

        // Verify sender is in the call conversation
        const senderOk = (await query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!senderOk) return;

        // Add target to conversation
        await query(
            `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [conversationId, targetUserId]
        );

        const caller = (await query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];

        // Notify target as incoming call
        sendToUser(targetUserId, 'call_incoming', {
            callId,
            conversationId,
            callerId: senderId,
            callerName: caller?.full_name,
            callerAvatar: caller?.avatar,
            callType: callLog.call_type,
            isGroup: true,
            isJoining: true
        });
    }
}

/**
 * Send a message to a specific user (all their open tabs/devices).
 */
function sendToUser(userId, type, data) {
    const set = clients.get(userId);
    if (!set) return;
    const msg = JSON.stringify({ type, data });
    for (const ws of set) {
        if (ws.readyState === 1) ws.send(msg);
    }
}

/**
 * Broadcast to all connected clients.
 */
function broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const [, set] of clients) {
        for (const ws of set) {
            if (ws.readyState === 1) ws.send(msg);
        }
    }
}

/**
 * Broadcast presence change to org members who are online.
 */
async function broadcastPresence(userId, status) {
    try {
        const user = (await query('SELECT org_id, full_name FROM users WHERE id = $1', [userId])).rows[0];
        if (!user?.org_id) return;

        // Only notify online org users
        const orgUsers = (await query(
            'SELECT id FROM users WHERE org_id = $1 AND id != $2 AND is_active = TRUE',
            [user.org_id, userId]
        )).rows;

        for (const u of orgUsers) {
            if (clients.has(u.id)) {
                sendToUser(u.id, 'presence_change', { userId, status, fullName: user.full_name });
            }
        }
    } catch { /* ignore */ }
}

module.exports = { setupWebSocket, sendToUser, broadcast };
