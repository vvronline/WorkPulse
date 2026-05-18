/**
 * WebSocket server for real-time notifications and chat.
 * Attaches to the HTTP server and authenticates via the JWT cookie.
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { masterQuery } = require('../db');
const { getTenantPool, getTenantById } = require('./tenantManager');
const { logger } = require('./logger');
const redis = require('../redis');

/** Map<clientKey, Set<WebSocket>> — local instance connections, keyed by tenantId:userId */
const clients = new Map();

/** Max WebSocket connections a single user may hold per server instance.
 *  Each browser tab uses ~4 WS connections (chat, calls, status, notifications)
 *  so allow enough for 2-3 tabs or a browser + desktop app. */
const MAX_CONNECTIONS_PER_USER = 12;

/** Unique instance ID for Pub/Sub dedup */
const INSTANCE_ID = `ws-${process.pid}-${Date.now()}`;

/** Composite key for the clients Map to prevent cross-tenant collisions */
function clientKey(tenantId, userId) {
    return `${tenantId || 0}:${userId}`;
}

function setupWebSocket(server) {
    const wss = new WebSocketServer({
        server,
        path: '/ws',
        maxPayload: 64 * 1024,
        verifyClient: ({ req }, done) => {
            // Prevent Cross-Site WebSocket Hijacking (CSWSH)
            const origin = req.headers.origin;
            if (!origin) return done(true); // non-browser clients (Electron, curl) have no Origin

            const host = req.headers.host;
            if (host && (origin === `https://${host}` || origin === `http://${host}`)) return done(true);

            if (origin.startsWith('workpulse://')) return done(true);

            if (process.env.CORS_ORIGIN) {
                const allowed = process.env.CORS_ORIGIN.split(',').map(s => s.trim());
                if (allowed.includes(origin)) return done(true);
            }

            if (process.env.NODE_ENV !== 'production') {
                const devOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173', 'http://localhost:5000'];
                if (devOrigins.includes(origin)) return done(true);
            }

            logger.warn({ origin }, 'WebSocket connection rejected: invalid origin');
            done(false, 403, 'Origin not allowed');
        },
    });

    // ── Redis Pub/Sub: subscribe to user message channels ──
    const sub = redis.getSubscriber();
    if (sub) {
        sub.subscribe('ws:broadcast', (err) => {
            if (err) logger.warn({ err: err.message }, 'Redis subscribe failed for ws:broadcast');
        });
        sub.on('message', (channel, raw) => {
            try {
                const envelope = JSON.parse(raw);
                if (envelope._from === INSTANCE_ID) return; // ignore own publishes
                if (channel === 'ws:broadcast') {
                    deliverLocal(envelope.tenantId, envelope.userId, envelope.type, envelope.data);
                }
            } catch { /* ignore */ }
        });
    }

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
        const tenantId = payload.tenant_id;

        // Resolve tenant DB
        let db;
        if (tenantId) {
            try {
                const tenant = await getTenantById(tenantId);
                if (!tenant || tenant.status !== 'active') { ws.close(4003, 'Tenant unavailable'); return; }
                const poolEntry = await getTenantPool(tenant.db_name, tenant.db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            } catch (e) {
                logger.warn({ err: e.message, tenantId }, 'WS tenant pool failed');
                ws.close(4003, 'Tenant unavailable');
                return;
            }
        } else {
            db = { query: masterQuery };
        }
        ws.db = db;
        ws.tenantId = tenantId || null;

        try {
            const tokenVersion = payload.tv ?? 0;
            let dbTokenVersion = await redis.getTokenVersion(tenantId, userId);
            if (dbTokenVersion === null) {
                const userRow = (await db.query('SELECT token_version FROM users WHERE id = $1', [userId])).rows[0];
                if (!userRow) { ws.close(4001, 'Token revoked'); return; }
                dbTokenVersion = userRow.token_version || 0;
                await redis.setTokenVersion(tenantId, userId, dbTokenVersion);
            }
            if (tokenVersion !== dbTokenVersion) {
                ws.close(4001, 'Token revoked');
                return;
            }
        } catch {
            ws.close(4001, 'Auth check failed');
            return;
        }

        // Register client (enforce per-user connection limit)
        const ck = clientKey(tenantId, userId);
        const wasOffline = !clients.has(ck) || clients.get(ck).size === 0;
        if (!clients.has(ck)) clients.set(ck, new Set());
        const userConns = clients.get(ck);
        if (userConns.size >= MAX_CONNECTIONS_PER_USER) {
            ws.close(4029, 'Too many connections');
            return;
        }
        userConns.add(ws);
        logger.debug({ userId, tenantId }, 'WS client connected');

        // Presence: mark online
        if (wasOffline) {
            redis.setPresence(tenantId, userId, redis.TTL.PRESENCE);
            db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]).catch(err => { logger.warn({ err: err.message, userId }, 'Failed to update last_seen_at on connect'); });
            broadcastPresence(db, tenantId, userId, 'online');
        }

        ws.on('message', (raw) => {
            // Per-connection rate limiting: max 60 messages per second
            // (WebRTC ICE candidate trickling can burst during call setup)
            const now = Date.now();
            if (!ws._rlWindow || now - ws._rlWindow > 1000) {
                ws._rlWindow = now;
                ws._rlCount = 0;
            }
            if (++ws._rlCount > 60) {
                logger.warn({ userId, tenantId, count: ws._rlCount }, 'WS rate limit exceeded, dropping message');
                return;
            }

            try {
                const msg = JSON.parse(raw);
                handleChatMessage(db, userId, tenantId, msg, ws).catch(err => {
                    logger.error({ err: err?.message, stack: err?.stack, userId, tenantId, type: msg?.type }, 'WS message handler error');
                });
            } catch { /* ignore non-JSON */ }
        });

        ws.on('close', () => {
            const set = clients.get(ck);
            if (set) {
                set.delete(ws);
                if (set.size === 0) {
                    clients.delete(ck);
                    // Presence: mark offline
                    redis.removePresence(tenantId, userId);
                    db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]).catch(err => { logger.warn({ err: err.message, userId }, 'Failed to update last_seen_at on disconnect'); });
                    broadcastPresence(db, tenantId, userId, 'offline');
                }
            }

            // Clean up meeting if user was in one and didn't explicitly leave
            if (ws._activeMeetingId) {
                const mid = ws._activeMeetingId;
                ws._activeMeetingId = null;
                (async () => {
                    try {
                        const isJoined = (await db.query(
                            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
                            [mid, userId]
                        )).rows[0];
                        if (!isJoined) return;

                        await db.query(
                            `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1 AND user_id = $2`,
                            [mid, userId]
                        );

                        const activeParticipants = (await db.query(
                            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
                            [mid]
                        )).rows;

                        for (const p of activeParticipants) {
                            sendToUser(tenantId, p.user_id, 'meeting_participant_left', { meetingId: mid, userId });
                        }

                        if (activeParticipants.length === 0) {
                            await db.query(`UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1 AND status != 'ended'`, [mid]);
                        }
                    } catch (err) {
                        logger.warn({ err: err.message, userId, meetingId: mid }, 'Meeting cleanup on disconnect failed');
                    }
                })();
            }

            logger.debug({ userId, tenantId }, 'WS client disconnected');
        });

        ws.on('error', (err) => {
            logger.warn({ err: err?.message, userId }, 'WebSocket error');
            ws.close();
        });

        // Heartbeat: keep connection alive
        ws.isAlive = true;
        ws.userId = userId;
        ws.tenantId = tenantId || null;
        ws.on('pong', () => {
            ws.isAlive = true;
            // Refresh Redis presence TTL on every pong so users don't appear offline
            redis.setPresence(ws.tenantId, ws.userId, redis.TTL.PRESENCE);
        });
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
async function handleChatMessage(db, senderId, tenantId, msg, ws) {
    if (msg.type === 'chat_message') {
        const { conversationId, content, replyToId, formatType, mentions, clientMsgId } = msg.data || {};
        if (!conversationId || !content || typeof content !== 'string' || content.trim().length === 0 || content.length > 5000) return;

        // Defense-in-depth: reject messages with obvious script injection patterns
        if (/<script[\s>]|javascript:|on\w+\s*=/i.test(content)) {
            logger.warn({ senderId, conversationId }, 'chat_message: rejected content with script-like pattern');
            return;
        }

        // Verify sender is a participant
        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        // Insert message
        const replyId = replyToId ? parseInt(replyToId, 10) : null;
        const fmtType = (formatType === 'markdown' || formatType === 'code') ? formatType : 'text';
        const result = (await db.query(
            `INSERT INTO messages (conversation_id, sender_id, content, reply_to_id, format_type)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
            [conversationId, senderId, content.trim(), replyId, fmtType]
        )).rows[0];

        // Update conversation timestamp
        await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

        // Update sender's read cursor
        await db.query(
            `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3`,
            [conversationId, senderId, result.created_at]
        );

        // Get all participants to broadcast
        const participants = (await db.query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
            [conversationId]
        )).rows;

        // Get sender info
        const sender = (await db.query('SELECT full_name, avatar, username FROM users WHERE id = $1', [senderId])).rows[0];

        // Get reply details if replying (must belong to the same conversation)
        let replyContent = null, replySenderName = null;
        if (replyId) {
            const replyMsg = (await db.query(
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
            createdAt: result.created_at,
            clientMsgId: clientMsgId || null
        };

        for (const p of participants) {
            sendToUser(tenantId, p.user_id, 'chat_message', outMsg);
            // Increment unread counter for recipients (not sender)
            if (p.user_id !== senderId) {
                redis.incrUnread(tenantId, p.user_id, conversationId);
            }
        }
        if (Array.isArray(mentions) && mentions.length > 0) {
            const participantIdSet = new Set(participants.map(p => p.user_id));
            const mentionedIds = mentions.map(Number).filter(n => n > 0 && n !== senderId && participantIdSet.has(n));
            for (const uid of mentionedIds) {
                sendToUser(tenantId, uid, 'chat_mention', {
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
        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        // Notify other participants
        const participants = (await db.query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
            [conversationId, senderId]
        )).rows;

        for (const p of participants) {
            sendToUser(tenantId, p.user_id, 'chat_typing', { conversationId, userId: senderId });
        }
    } else if (msg.type === 'chat_read') {
        const { conversationId } = msg.data || {};
        if (!conversationId) return;

        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        await db.query(
            `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
            [conversationId, senderId]
        );
        redis.resetUnread(tenantId, senderId, conversationId);
    } else if (msg.type === 'call_initiate') {
        // Caller initiates a call → create call_log, notify participants
        const { conversationId, callType } = msg.data || {};
        if (!conversationId || !['voice', 'video'].includes(callType)) return;

        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) {
            logger.warn({ senderId, conversationId }, 'call_initiate: sender not a participant');
            return;
        }

        // Create call log entry
        const callLog = (await db.query(
            `INSERT INTO call_logs (conversation_id, caller_id, call_type, status)
             VALUES ($1, $2, $3, 'ringing') RETURNING id, created_at`,
            [conversationId, senderId, callType]
        )).rows[0];

        const caller = (await db.query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];

        // Get conversation info for the notification
        const conv = (await db.query('SELECT name, is_group FROM conversations WHERE id = $1', [conversationId])).rows[0];

        // Notify all other participants about incoming call.
        //
        // For NON-group (1:1) conversations we ring at most ONE other user —
        // the earliest-added counterpart. This protects against legacy 1:1
        // chats that were silently corrupted by the old "add participant"
        // bug, which permanently injected a 3rd member into the
        // conversation_participants table. Without this guard, every 1:1
        // call would auto-ring that ghost 3rd participant.
        const participantsQuery = conv?.is_group
            ? `SELECT user_id FROM conversation_participants
               WHERE conversation_id = $1 AND user_id != $2`
            : `SELECT user_id FROM conversation_participants
               WHERE conversation_id = $1 AND user_id != $2
               ORDER BY user_id ASC
               LIMIT 1`;
        const participants = (await db.query(participantsQuery, [conversationId, senderId])).rows;

        logger.info({ senderId, callId: callLog.id, conversationId, callType, participantCount: participants.length, tenantId }, 'call_initiate: notifying participants');

        for (const p of participants) {
            sendToUser(tenantId, p.user_id, 'call_incoming', {
                callId: callLog.id,
                conversationId,
                callerId: senderId,
                callerName: caller?.full_name,
                callerAvatar: caller?.avatar,
                callType,
                isGroup: conv?.is_group || false,
                groupName: conv?.name
            });
        }

        // Confirm call started to caller
        sendToUser(tenantId, senderId, 'call_started', {
            callId: callLog.id,
            conversationId,
            callType
        });

    } else if (msg.type === 'call_accept') {
        // Callee accepts → update call log, notify caller with acceptance
        const { callId, conversationId } = msg.data || {};
        if (!callId || !conversationId) return;

        const callLog = (await db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2 AND status = 'ringing'`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) {
            logger.warn({ senderId, callId, conversationId }, 'call_accept: no ringing call found');
            return;
        }

        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) {
            logger.warn({ senderId, callId, conversationId }, 'call_accept: sender not a participant');
            return;
        }

        await db.query(`UPDATE call_logs SET status = 'answered', started_at = NOW() WHERE id = $1`, [callId]);

        const accepter = (await db.query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];

        logger.info({ senderId, callerId: callLog.caller_id, callId, conversationId, tenantId }, 'call_accept: notifying caller');

        // Notify the caller that call was accepted
        sendToUser(tenantId, callLog.caller_id, 'call_accepted', {
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

        // Verify sender is a participant in this conversation
        const isParticipant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!isParticipant) return;

        const callLog = (await db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) return;

        await db.query(
            `UPDATE call_logs SET status = 'declined', ended_at = NOW() WHERE id = $1 AND status = 'ringing'`,
            [callId]
        );

        const rejecter = (await db.query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];

        // Notify other participants
        const participants = (await db.query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
            [conversationId, senderId]
        )).rows;

        for (const p of participants) {
            sendToUser(tenantId, p.user_id, 'call_rejected', {
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

        // Verify sender is a participant in this conversation
        const isParticipant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!isParticipant) return;

        const callLog = (await db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) return;

        // Calculate duration if call was answered
        let duration = null;
        if (callLog.started_at) {
            duration = Math.round((Date.now() - new Date(callLog.started_at).getTime()) / 1000);
        }

        await db.query(
            `UPDATE call_logs SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END,
             ended_at = NOW(), duration = $2 WHERE id = $1`,
            [callId, duration]
        );

        // Notify all participants about call end
        const allParticipants = (await db.query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
            [conversationId]
        )).rows;

        for (const p of allParticipants) {
            if (p.user_id !== senderId) {
                sendToUser(tenantId, p.user_id, 'call_ended', { callId, conversationId, endedBy: senderId, duration });
            }
        }

    } else if (msg.type === 'call_signal') {
        // WebRTC signaling relay: offer, answer, ICE candidates
        const { conversationId, targetUserId, signal } = msg.data || {};
        if (!conversationId || !targetUserId || !signal) return;

        // Validate signal type against whitelist
        const VALID_SIGNAL_TYPES = ['offer', 'answer', 'ice-candidate', 'video-state', 'audio-state', 'screen-share-state'];
        if (!signal.type || !VALID_SIGNAL_TYPES.includes(signal.type)) {
            logger.warn({ senderId, signalType: signal?.type }, 'call_signal: rejected unknown signal type');
            return;
        }

        // Validate signal payload per type
        if (signal.type === 'offer' || signal.type === 'answer') {
            if (typeof signal.sdp !== 'string' || signal.sdp.length === 0 || signal.sdp.length > 100000) {
                logger.warn({ senderId, signalType: signal.type, sdpLen: signal.sdp?.length }, 'call_signal: invalid SDP');
                return;
            }
        } else if (signal.type === 'ice-candidate') {
            if (signal.candidate != null && (typeof signal.candidate !== 'object' || typeof signal.candidate.candidate !== 'string')) {
                logger.warn({ senderId }, 'call_signal: invalid ICE candidate structure');
                return;
            }
        } else if (signal.type === 'video-state') {
            if (typeof signal.videoOff !== 'boolean') return;
        }

        // For offer/answer: verify both sender and target are in the conversation.
        // For ICE candidates: skip DB checks to avoid pool exhaustion during rapid trickle.
        // (Both parties were already verified during call_initiate / call_accept.)
        if (signal.type === 'offer' || signal.type === 'answer') {
            const senderOk = (await db.query(
                'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
                [conversationId, senderId]
            )).rows[0];
            const targetOk = (await db.query(
                'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
                [conversationId, targetUserId]
            )).rows[0];
            if (!senderOk || !targetOk) {
                logger.warn({ senderId, targetUserId, conversationId, senderOk: !!senderOk, targetOk: !!targetOk, signalType: signal.type }, 'call_signal: participant check failed');
                return;
            }
        }

        logger.debug({ senderId, targetUserId, conversationId, signalType: signal.type, tenantId }, 'call_signal: relaying');

        // Relay the signal to the target user
        sendToUser(tenantId, targetUserId, 'call_signal', {
            conversationId,
            fromUserId: senderId,
            signal
        });

    } else if (msg.type === 'call_reconnect') {
        // User refreshed the page during an active call — notify the other party to re-offer
        const { callId, conversationId } = msg.data || {};
        if (!callId || !conversationId) return;

        const callLog = (await db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2 AND status = 'answered'`,
            [callId, conversationId]
        )).rows[0];
        if (!callLog) return;

        // Verify sender is in the conversation
        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;

        // Find the other participant(s) and tell them to re-offer
        const others = (await db.query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
            [conversationId, senderId]
        )).rows;

        for (const p of others) {
            sendToUser(tenantId, p.user_id, 'call_reconnect', {
                callId,
                conversationId,
                userId: senderId
            });
        }

    } else if (msg.type === 'call_reaction') {
        const { conversationId, targetUserId, emoji } = msg.data || {};
        if (!conversationId || !targetUserId || !emoji) return;
        const allowedEmojis = ['\u{1F44D}', '\u{1F44F}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F389}', '\u{1F914}'];
        if (!allowedEmojis.includes(emoji)) return;
        const participant = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!participant) return;
        sendToUser(tenantId, targetUserId, 'call_reaction', {
            conversationId,
            fromUserId: senderId,
            emoji
        });
        // ═══════════════════════════════════════════════════════
        //  MEETING HANDLERS
        // ═══════════════════════════════════════════════════════
    } else if (msg.type === 'meeting_join') {
        const { meetingId } = msg.data || {};
        if (!meetingId) return;

        const meeting = (await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
        if (!meeting) return;

        // Allow rejoining ended meetings — reactivate the meeting
        if (meeting.status === 'ended') {
            await db.query(`UPDATE meetings SET status = 'active', ended_at = NULL WHERE id = $1`, [meetingId]);
        }

        // Verify participant is allowed
        const mp = (await db.query(
            'SELECT status FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
            [meetingId, senderId]
        )).rows[0];
        const isOrgMember = meeting.org_id
            ? (await db.query('SELECT 1 FROM users WHERE id = $1 AND org_id = $2', [senderId, meeting.org_id])).rows[0]
            : true;
        if (!mp && !isOrgMember) return;

        // Track if this is a rejoin (already had status 'joined') to skip duplicate system messages
        const wasAlreadyJoined = mp?.status === 'joined';

        // Upsert participant
        await db.query(
            `INSERT INTO meeting_participants (meeting_id, user_id, role, status, joined_at)
             VALUES ($1, $2, 'participant', 'joined', NOW())
             ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'joined', joined_at = NOW(), left_at = NULL`,
            [meetingId, senderId]
        );

        // Tag this WS connection so we can clean up on disconnect
        ws._activeMeetingId = meetingId;

        // Determine if we should notify other participants
        const isRestart = meeting.status === 'ended';
        const isFirstStart = meeting.status === 'scheduled';
        // For active meetings, notify if no one else is currently in the meeting
        let isFirstJoinActive = false;
        if (meeting.status === 'active' && !isFirstStart) {
            const currentlyJoined = (await db.query(
                `SELECT COUNT(*) as cnt FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined' AND user_id != $2`,
                [meetingId, senderId]
            )).rows[0];
            isFirstJoinActive = parseInt(currentlyJoined.cnt) === 0;
        }

        // Mark meeting as active on first join
        if (isFirstStart) {
            await db.query(`UPDATE meetings SET status = 'active', started_at = NOW() WHERE id = $1`, [meetingId]);
        }

        if (isFirstStart || isRestart || isFirstJoinActive) {
            // Notify all invited participants that the meeting has started/restarted
            const allInvited = (await db.query(
                `SELECT mp.user_id FROM meeting_participants mp
                 WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
                [meetingId, senderId]
            )).rows;
            const starter = (await db.query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];
            const starterName = starter?.full_name || 'Someone';
            const notifType = isRestart ? 'meeting_restarted' : 'meeting_started';
            const notifTitle = isRestart
                ? `Meeting Restarted: ${meeting.title || 'Untitled'}`
                : `Meeting Started: ${meeting.title || 'Untitled'}`;
            const notifBody = isRestart
                ? `${starterName} restarted the meeting`
                : `${starterName} started the meeting`;

            for (const p of allInvited) {
                try {
                    await db.query(
                        `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`,
                        [p.user_id, notifType, notifTitle, notifBody]
                    );
                } catch { /* ignore duplicate or constraint errors */ }

                sendToUser(tenantId, p.user_id, 'meeting_started', {
                    meetingId,
                    meetingCode: meeting.meeting_code,
                    title: meeting.title,
                    organizerName: starterName,
                    organizerAvatar: starter?.avatar,
                    startedBy: senderId,
                    restarted: isRestart,
                });
                sendToUser(tenantId, p.user_id, 'notification', {
                    title: notifTitle,
                    body: notifBody,
                });
            }
        }

        const joiner = (await db.query('SELECT full_name, avatar, username FROM users WHERE id = $1', [senderId])).rows[0];

        // Get all current participants with user info (for sending to the new joiner)
        const allParticipants = (await db.query(
            `SELECT mp.user_id, u.full_name, u.avatar, u.username
             FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
             WHERE mp.meeting_id = $1 AND mp.status = $2`,
            [meetingId, 'joined']
        )).rows;

        // Build existingPeers with full user info so the joiner can display names
        const existingPeers = allParticipants
            .filter(p => p.user_id !== senderId)
            .map(p => ({ userId: p.user_id, fullName: p.full_name, avatar: p.avatar, username: p.username }));

        for (const p of allParticipants) {
            sendToUser(tenantId, p.user_id, 'meeting_participant_joined', {
                meetingId,
                userId: senderId,
                fullName: joiner?.full_name,
                avatar: joiner?.avatar,
                username: joiner?.username,
                existingPeers: p.user_id === senderId ? existingPeers : undefined
            });
        }

        // System message in conversation (skip on PiP rejoin to avoid duplicates)
        if (meeting.conversation_id && !wasAlreadyJoined) {
            const sysMsg = (await db.query(
                `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
                 VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
                [meeting.conversation_id, senderId, JSON.stringify({
                    type: 'meeting_joined', meetingId, name: joiner?.full_name
                })]
            )).rows[0];
            const convParticipants = (await db.query(
                'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
                [meeting.conversation_id]
            )).rows;
            for (const p of convParticipants) {
                sendToUser(tenantId, p.user_id, 'chat_message', {
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

        // Clear the tag so disconnect handler doesn't double-leave
        ws._activeMeetingId = null;

        // Verify sender is actually a joined participant
        const isJoined = (await db.query(
            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
            [meetingId, senderId]
        )).rows[0];
        if (!isJoined) return;

        await db.query(
            `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1 AND user_id = $2`,
            [meetingId, senderId]
        );

        const activeParticipants = (await db.query(
            `SELECT mp.user_id FROM meeting_participants mp WHERE mp.meeting_id = $1 AND mp.status = 'joined'`,
            [meetingId]
        )).rows;

        for (const p of activeParticipants) {
            sendToUser(tenantId, p.user_id, 'meeting_participant_left', { meetingId, userId: senderId });
        }

        // If no active participants, mark meeting ended (use WHERE to prevent double-update race)
        if (activeParticipants.length === 0) {
            await db.query(`UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1 AND status != 'ended'`, [meetingId]);
        }

    } else if (msg.type === 'meeting_end') {
        const { meetingId } = msg.data || {};
        if (!meetingId) return;

        ws._activeMeetingId = null;

        const meeting = (await db.query(
            'SELECT * FROM meetings WHERE id = $1 AND created_by = $2',
            [meetingId, senderId]
        )).rows[0];
        if (!meeting) return;

        const startedAt = meeting.started_at ? new Date(meeting.started_at) : null;
        const durationSecs = startedAt ? Math.round((Date.now() - startedAt.getTime()) / 1000) : null;

        await db.query(
            `UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1`,
            [meetingId]
        );
        await db.query(
            `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1`,
            [meetingId]
        );

        const activeParticipants = (await db.query(
            'SELECT user_id FROM meeting_participants WHERE meeting_id = $1',
            [meetingId]
        )).rows;

        for (const p of activeParticipants) {
            sendToUser(tenantId, p.user_id, 'meeting_ended', { meetingId, endedBy: senderId, duration: durationSecs });
        }

        // System message in conversation
        if (meeting.conversation_id) {
            const sysMsg = (await db.query(
                `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
                 VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
                [meeting.conversation_id, senderId, JSON.stringify({
                    type: 'meeting_ended', meetingId, duration: durationSecs
                })]
            )).rows[0];
            const convParticipants = (await db.query(
                'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
                [meeting.conversation_id]
            )).rows;
            for (const p of convParticipants) {
                sendToUser(tenantId, p.user_id, 'chat_message', {
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

        // For offer/answer: verify sender is a joined participant.
        // For ICE candidates: skip DB checks to avoid pool exhaustion during rapid trickle.
        // (Both parties were verified during meeting_join.)
        if (signal.type === 'offer' || signal.type === 'answer') {
            const senderOk = (await db.query(
                `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
                [meetingId, senderId]
            )).rows[0];
            if (!senderOk) {
                logger.warn({ senderId, targetUserId, meetingId, signalType: signal.type }, 'meeting_signal: sender not joined');
                return;
            }
        }

        logger.debug({ senderId, targetUserId, meetingId, signalType: signal.type, tenantId }, 'meeting_signal: relaying');

        sendToUser(tenantId, targetUserId, 'meeting_signal', {
            meetingId,
            fromUserId: senderId,
            signal
        });

    } else if (msg.type === 'meeting_add_participant') {
        // Organizer adds someone to an active meeting
        const { meetingId, targetUserId } = msg.data || {};
        if (!meetingId || !targetUserId) return;

        const meeting = (await db.query(
            'SELECT * FROM meetings WHERE id = $1 AND created_by = $2',
            [meetingId, senderId]
        )).rows[0];
        if (!meeting || meeting.status === 'ended') return;

        const targetUser = (await db.query('SELECT full_name, avatar FROM users WHERE id = $1', [targetUserId])).rows[0];
        if (!targetUser) return;

        await db.query(
            `INSERT INTO meeting_participants (meeting_id, user_id, role, status)
             VALUES ($1, $2, 'participant', 'invited') ON CONFLICT (meeting_id, user_id) DO NOTHING`,
            [meetingId, targetUserId]
        );
        if (meeting.conversation_id) {
            await db.query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [meeting.conversation_id, targetUserId]
            );
        }

        const organizer = (await db.query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];
        sendToUser(tenantId, targetUserId, 'meeting_invite', {
            meetingId,
            meetingCode: meeting.meeting_code,
            title: meeting.title,
            organizerName: organizer?.full_name,
            conversationId: meeting.conversation_id,
            isOngoing: true
        });

    } else if (msg.type === 'meeting_mute_participant') {
        // Organizer mutes/unmutes a participant
        const { meetingId, targetUserId, muted } = msg.data || {};
        if (!meetingId || !targetUserId) return;

        const meeting = (await db.query('SELECT * FROM meetings WHERE id = $1 AND created_by = $2', [meetingId, senderId])).rows[0];
        if (!meeting) return;

        // Notify the target to mute/unmute themselves
        sendToUser(tenantId, targetUserId, 'meeting_muted', { meetingId, muted: muted !== false, byUserId: senderId });

        // Broadcast updated mute state to all participants so UI reflects change
        const participants = (await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;
        for (const p of participants) {
            if (p.user_id !== targetUserId) {
                sendToUser(tenantId, p.user_id, 'meeting_track_state', { meetingId, userId: targetUserId, muted: muted !== false, videoOff: null, screenSharing: null });
            }
        }

    } else if (msg.type === 'meeting_raise_hand') {
        const { meetingId, raised } = msg.data || {};
        if (!meetingId) return;

        // Verify sender is an active participant
        const senderOk = (await db.query(
            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
            [meetingId, senderId]
        )).rows[0];
        if (!senderOk) return;

        const participants = (await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;

        const raiser = (await db.query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];
        for (const p of participants) {
            sendToUser(tenantId, p.user_id, 'meeting_hand_raised', { meetingId, userId: senderId, name: raiser?.full_name, raised: !!raised });
        }

    } else if (msg.type === 'meeting_track_state') {
        // Participant broadcasts their muted/videoOff state
        const { meetingId, muted, videoOff, screenSharing } = msg.data || {};
        if (!meetingId) return;

        // Verify sender is an active participant
        const senderOk = (await db.query(
            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
            [meetingId, senderId]
        )).rows[0];
        if (!senderOk) return;

        const participants = (await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;

        // Only include explicitly-sent fields to avoid coercing undefined to false
        const trackState = { meetingId, userId: senderId };
        if (muted !== undefined) trackState.muted = !!muted;
        if (videoOff !== undefined) trackState.videoOff = !!videoOff;
        if (screenSharing !== undefined) trackState.screenSharing = !!screenSharing;

        for (const p of participants) {
            if (p.user_id !== senderId) {
                sendToUser(tenantId, p.user_id, 'meeting_track_state', trackState);
            }
        }

    } else if (msg.type === 'meeting_screen_track_id') {
        // Sender is announcing which of the tracks they sent over their
        // peer connection is the screen share. Client-side `useMeetingState`
        // uses this to route the incoming track from the camera stream
        // (shown in the participant tile) to a dedicated screen stream
        // (shown in PresenterView). Server only relays — no DB checks
        // needed since both peers were already verified at meeting_join.
        const { meetingId, targetUserId, sharing, trackId } = msg.data || {};
        if (!meetingId || !targetUserId) return;
        sendToUser(tenantId, targetUserId, 'meeting_screen_track_id', {
            meetingId,
            fromUserId: senderId,
            sharing: !!sharing,
            trackId: trackId || null,
        });

    } else if (msg.type === 'meeting_chat') {
        // In-meeting chat message relay (text or file)
        const { meetingId, text, file_url, file_name, file_size } = msg.data || {};
        if (!meetingId) return;
        if (!file_url && (!text || typeof text !== 'string' || !text.trim() || text.length > 5000)) return;

        // Verify sender is an active participant
        const senderOk = (await db.query(
            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
            [meetingId, senderId]
        )).rows[0];
        if (!senderOk) return;

        const sender = (await db.query('SELECT full_name FROM users WHERE id = $1', [senderId])).rows[0];
        const participants = (await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId]
        )).rows;

        const message = {
            sender_id: senderId,
            sender_name: sender?.full_name || 'Participant',
            text: text ? text.trim() : null,
            created_at: new Date().toISOString(),
        };
        if (file_url) {
            message.file_url = file_url;
            message.file_name = file_name || 'File';
            message.file_size = file_size || null;
        }

        for (const p of participants) {
            sendToUser(tenantId, p.user_id, 'meeting_message', { meetingId, message });
        }

    } else if (msg.type === 'status_change') {
        // User manually sets their status or auto-status from client
        const { status, statusText } = msg.data || {};
        const validStatuses = ['available', 'busy', 'dnd', 'away', 'offline', 'in_call', 'in_meeting'];
        if (!status || !validStatuses.includes(status)) return;
        const safeText = typeof statusText === 'string' ? statusText.trim().slice(0, 100) : null;
        // Persist to DB + Redis
        await db.query('UPDATE users SET user_status = $1, user_status_text = $2 WHERE id = $3', [status, safeText, senderId]);
        redis.setUserStatus(tenantId, senderId, status);
        // Broadcast to org members
        broadcastStatus(db, tenantId, senderId, status, safeText);

    } else if (msg.type === 'call_add_participant') {
        // Add a participant to an ongoing call.
        //
        // IMPORTANT: This is ONLY allowed when the underlying conversation is
        // already a group conversation. The previous behaviour permanently
        // inserted the target into `conversation_participants` for any chat —
        // including 1:1 DMs — which had two awful side-effects:
        //
        //   1. The 1:1 WebRTC peer connection has no mesh/SFU plumbing, so
        //      the 3rd person could never actually hear/see anyone.
        //   2. The conversation was now a 3-person group forever, so the
        //      next call from that DM would auto-ring the 3rd person too.
        //
        // For n-way calls users should start a Meeting (which has proper
        // group support). We hard-reject the request here so old / mobile
        // clients that still expose the button cannot corrupt the chat.
        const { callId, conversationId, targetUserId } = msg.data || {};
        if (!callId || !conversationId || !targetUserId) return;

        const callLog = (await db.query('SELECT * FROM call_logs WHERE id = $1 AND status = $2', [callId, 'answered'])).rows[0];
        if (!callLog) return;

        // Verify sender is in the call conversation
        const senderOk = (await db.query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [conversationId, senderId]
        )).rows[0];
        if (!senderOk) return;

        // Refuse to upgrade a 1:1 conversation into a group via this path.
        const conv = (await db.query(
            'SELECT is_group FROM conversations WHERE id = $1',
            [conversationId]
        )).rows[0];
        if (!conv || !conv.is_group) {
            logger.warn({ senderId, callId, conversationId, targetUserId }, 'call_add_participant: rejected — conversation is not a group');
            return;
        }

        // Add target to conversation (no-op if they were already a member)
        await db.query(
            `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [conversationId, targetUserId]
        );

        const caller = (await db.query('SELECT full_name, avatar FROM users WHERE id = $1', [senderId])).rows[0];

        // Notify target as incoming call
        sendToUser(tenantId, targetUserId, 'call_incoming', {
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
 * Deliver a message to a user's local WebSocket connections (this instance only).
 * When tenantId is provided, only delivers to connections belonging to that tenant.
 */
function deliverLocal(tenantId, userId, type, data) {
    const ck = clientKey(tenantId, userId);
    const set = clients.get(ck);
    if (!set) {
        if (type === 'call_signal' || type === 'call_accepted' || type === 'call_incoming' || type === 'meeting_signal' || type === 'meeting_participant_joined' || type === 'meeting_started') {
            logger.warn({ tenantId, userId, type, clientKey: ck, totalKeys: clients.size }, 'deliverLocal: no connections found for user');
        }
        return;
    }
    const msg = JSON.stringify({ type, data });
    let delivered = 0;
    for (const ws of set) {
        if (ws.readyState === 1) { ws.send(msg); delivered++; }
    }
    if (delivered === 0 && (type === 'call_signal' || type === 'call_accepted' || type === 'call_incoming' || type === 'meeting_signal' || type === 'meeting_participant_joined' || type === 'meeting_started')) {
        logger.warn({ tenantId, userId, type, clientKey: ck, connections: set.size }, 'deliverLocal: user has connections but none are open');
    }
}

/**
 * Send a message to a specific user (all their open tabs/devices, across all instances).
 * tenantId ensures messages are only delivered to connections in the correct tenant.
 */
function sendToUser(tenantId, userId, type, data) {
    // Always deliver locally first
    deliverLocal(tenantId, userId, type, data);
    // Publish to Redis for other instances (include tenantId for cross-instance filtering)
    redis.publish('ws:broadcast', { _from: INSTANCE_ID, tenantId, userId, type, data });
}

/**
 * Broadcast to all connected clients of a specific tenant (local instance).
 * tenantId is required to prevent cross-tenant data leaks.
 */
function broadcast(tenantId, type, data) {
    const msg = JSON.stringify({ type, data });
    for (const [key, set] of clients) {
        // Only deliver to connections belonging to the specified tenant
        const keyTenant = key.split(':')[0];
        if (String(tenantId || 0) !== keyTenant) continue;
        for (const ws of set) {
            if (ws.readyState === 1) ws.send(msg);
        }
    }
}

/**
 * Broadcast presence change to org members who are online.
 */
async function broadcastPresence(db, tenantId, userId, status) {
    try {
        const user = (await db.query('SELECT org_id, full_name, user_status FROM users WHERE id = $1', [userId])).rows[0];
        if (!user?.org_id) return;

        // Only notify online org users
        const orgUsers = (await db.query(
            'SELECT id FROM users WHERE org_id = $1 AND id != $2 AND is_active = TRUE',
            [user.org_id, userId]
        )).rows;

        for (const u of orgUsers) {
            sendToUser(tenantId, u.id, 'presence_change', { userId, status, fullName: user.full_name, userStatus: user.user_status });
        }
    } catch { /* ignore */ }
}

/**
 * Broadcast user status change (available/busy/dnd/away/in_call/in_meeting/offline) to org members.
 */
async function broadcastStatus(db, tenantId, userId, userStatus, statusText) {
    try {
        const user = (await db.query('SELECT org_id, full_name FROM users WHERE id = $1', [userId])).rows[0];
        if (!user?.org_id) return;

        const orgUsers = (await db.query(
            'SELECT id FROM users WHERE org_id = $1 AND id != $2 AND is_active = TRUE',
            [user.org_id, userId]
        )).rows;

        for (const u of orgUsers) {
            sendToUser(tenantId, u.id, 'status_change', { userId, userStatus, statusText, fullName: user.full_name });
        }
    } catch { /* ignore */ }
}

/**
 * Create a notification in the DB and push it to the user via WebSocket.
 * Drop-in wrapper: call this instead of raw INSERT INTO notifications.
 */
async function notifyUser(db, tenantId, userId, type, title, body, linkTaskId) {
    try {
        const sql = linkTaskId
            ? 'INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at'
            : 'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4) RETURNING id, created_at';
        const params = linkTaskId
            ? [userId, type, title, body, linkTaskId]
            : [userId, type, title, body];
        const row = (await db.query(sql, params)).rows[0];
        if (row) {
            sendToUser(tenantId, userId, 'notification', {
                id: row.id, type, title, body,
                link_task_id: linkTaskId || null,
                created_at: row.created_at, is_read: false,
            });
        }
    } catch { /* ignore — notification delivery is best-effort */ }
}

module.exports = { setupWebSocket, sendToUser, broadcast, notifyUser };
