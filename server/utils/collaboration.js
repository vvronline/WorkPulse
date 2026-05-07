/**
 * Real-time collaboration server using Hocuspocus (Yjs WebSocket provider).
 * Handles:
 *   - Per-page collaborative editing via Yjs CRDTs
 *   - Presence / awareness (colored cursors, "X is viewing" avatars)
 *   - @mention notifications
 *
 * Document naming convention: `notes:{tenantId}:{pageId}`
 * Each document maps to a single notebook page.
 */
const { Hocuspocus } = require('@hocuspocus/server');
const { Database } = require('@hocuspocus/extension-database');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { masterQuery } = require('../db');
const { getTenantPool, getTenantById } = require('./tenantManager');
const { logger } = require('./logger');
const { notifyUser } = require('./ws');

/**
 * Parse document name into components.
 * Format: "notes:{tenantId}:{pageId}"
 */
function parseDocName(documentName) {
    const parts = documentName.split(':');
    if (parts.length < 3 || parts[0] !== 'notes') return null;
    return {
        tenantId: parts[1] === '0' ? null : parseInt(parts[1], 10),
        pageId: parts.slice(2).join(':'), // pageId may contain colons
    };
}

/**
 * Get a tenant-scoped DB query function.
 */
async function getDbForTenant(tenantId) {
    if (!tenantId) return { query: masterQuery };
    const tenant = await getTenantById(tenantId);
    if (!tenant || tenant.status !== 'active') return null;
    const poolEntry = await getTenantPool(tenant.db_name, tenant.db_host);
    return { query: poolEntry.query, transaction: poolEntry.transaction };
}

/**
 * Create and configure the Hocuspocus collaboration server
 * and attach it to an existing HTTP server via WebSocket upgrade on /collab.
 */
function createCollaborationServer(httpServer) {
    const hocuspocus = new Hocuspocus({
        name: 'workpulse-collab',
        quiet: true,
        timeout: 30000,
        debounce: 2000,    // debounce DB writes by 2s
        maxDebounce: 10000,

        extensions: [
            new Database({
                /**
                 * Load Yjs document state from PostgreSQL.
                 */
                async fetch({ documentName }) {
                    const parsed = parseDocName(documentName);
                    if (!parsed) return null;

                    try {
                        const db = await getDbForTenant(parsed.tenantId);
                        if (!db) return null;

                        const row = (await db.query(
                            'SELECT yjs_state FROM notebook_pages WHERE page_id = $1',
                            [parsed.pageId]
                        )).rows[0];

                        return row?.yjs_state || null;
                    } catch (err) {
                        logger.warn({ err: err.message, documentName }, 'Collab: fetch doc failed');
                        return null;
                    }
                },

                /**
                 * Persist Yjs document state to PostgreSQL.
                 */
                async store({ documentName, state }) {
                    const parsed = parseDocName(documentName);
                    if (!parsed) return;

                    try {
                        const db = await getDbForTenant(parsed.tenantId);
                        if (!db) return;

                        await db.query(
                            `INSERT INTO notebook_pages (page_id, tenant_id, yjs_state, updated_at)
                             VALUES ($1, $2, $3, NOW())
                             ON CONFLICT (page_id) DO UPDATE
                             SET yjs_state = EXCLUDED.yjs_state, updated_at = NOW()`,
                            [parsed.pageId, parsed.tenantId || 0, Buffer.from(state)]
                        );
                    } catch (err) {
                        logger.warn({ err: err.message, documentName }, 'Collab: store doc failed');
                    }
                },
            }),
        ],

        /**
         * Authenticate WebSocket connections using JWT token from URL params.
         */
        async onAuthenticate({ token, documentName }) {
            if (!token) throw new Error('Unauthorized');

            let payload;
            try {
                payload = jwt.verify(token, process.env.JWT_SECRET);
            } catch {
                throw new Error('Invalid token');
            }

            const userId = payload.id;
            const tenantId = payload.tenant_id || null;

            // Verify document belongs to a tenant the user has access to
            const parsed = parseDocName(documentName);
            if (!parsed) throw new Error('Invalid document');

            if (parsed.tenantId && parsed.tenantId !== tenantId) {
                throw new Error('Tenant mismatch');
            }

            // Get user info for awareness/presence
            let db;
            try {
                db = await getDbForTenant(tenantId);
                if (!db) throw new Error('Tenant unavailable');
            } catch {
                throw new Error('Tenant unavailable');
            }

            const userRow = (await db.query(
                'SELECT id, full_name, avatar, email FROM users WHERE id = $1',
                [userId]
            )).rows[0];

            if (!userRow) throw new Error('User not found');

            return {
                userId,
                tenantId,
                fullName: userRow.full_name,
                avatar: userRow.avatar,
                email: userRow.email,
                db,
            };
        },

        async onConnect({ documentName, context }) {
            logger.debug({
                userId: context.userId,
                tenantId: context.tenantId,
                document: documentName,
            }, 'Collab: user connected');
        },

        async onDisconnect({ documentName, context }) {
            logger.debug({
                userId: context.userId,
                document: documentName,
            }, 'Collab: user disconnected');
        },
    });

    // Create a dedicated WebSocket server for collaboration on /collab path
    const wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests on the /collab path
    httpServer.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        if (url.pathname !== '/collab') return; // Let other WS servers handle other paths

        wss.handleUpgrade(request, socket, head, (ws) => {
            // Hocuspocus handles auth via its protocol (token sent by @hocuspocus/provider)
            hocuspocus.handleConnection(ws, request);
        });
    });

    logger.info('Collaboration WebSocket server attached on /collab');
    return hocuspocus;
}

/**
 * Handle @mention notifications.
 * Called from the REST endpoint when a user inserts a mention.
 */
async function handleMention(db, tenantId, mentionerId, mentionedUserId, pageId, pageTitle) {
    if (mentionerId === mentionedUserId) return; // don't notify self

    try {
        const mentioner = (await db.query(
            'SELECT full_name FROM users WHERE id = $1', [mentionerId]
        )).rows[0];

        const title = 'Mentioned in a note';
        const body = `${mentioner?.full_name || 'Someone'} mentioned you in "${pageTitle || 'Untitled'}"`;

        await notifyUser(db, tenantId, mentionedUserId, 'note_mention', title, body, null);
    } catch (err) {
        logger.warn({ err: err.message, mentionerId, mentionedUserId, pageId }, 'Collab: mention notification failed');
    }
}

module.exports = { createCollaborationServer, handleMention, parseDocName };
