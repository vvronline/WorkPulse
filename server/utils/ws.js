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
