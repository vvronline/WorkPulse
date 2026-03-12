/**
 * WebSocket server for real-time notifications.
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
    const wss = new WebSocketServer({ server, path: '/ws' });

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
            if (!userRow || (payload.tv !== undefined && userRow.token_version !== undefined && payload.tv !== userRow.token_version)) {
                ws.close(4001, 'Token revoked');
                return;
            }
        } catch {
            ws.close(4001, 'Auth check failed');
            return;
        }

        // Register client
        if (!clients.has(userId)) clients.set(userId, new Set());
        clients.get(userId).add(ws);
        logger.debug({ userId }, 'WS client connected');

        ws.on('close', () => {
            const set = clients.get(userId);
            if (set) {
                set.delete(ws);
                if (set.size === 0) clients.delete(userId);
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

module.exports = { setupWebSocket, sendToUser, broadcast };
