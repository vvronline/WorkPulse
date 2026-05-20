/**
 * Status Service — WebSocket broadcaster.
 *
 * INVARIANTS:
 *   • Only this file produces the unified `user_status` WS event.
 *   • Lazy-requires `../../utils/ws` so that requiring status service from
 *     anywhere (including tests that don't boot the WS server) is safe.
 *   • Errors are swallowed — broadcasting is best-effort.
 *
 * Event shape (frozen — version it by adding fields, never by renaming):
 *   {
 *     type: 'user_status',
 *     data: {
 *       userId,                                  // who the update is about
 *       effective,                               // resolver result
 *       presence,                                // 'online' | 'offline'
 *       manualStatus,                            // user's stored choice (or null)
 *       presencePreference,                      // 'auto' | 'invisible'
 *       statusMessage, statusMessageExpiresAt,   // custom text
 *       source                                   // why it changed
 *     }
 *   }
 */

// Lazy import to avoid circular requires during boot.
function getWs() {
    try { return require('../../utils/ws'); } catch { return null; }
}

/**
 * Broadcast the user's new effective state to themselves and to every
 * online member of their organisation.
 *
 * @param {Object} args
 * @param {Object} args.db                   tenant-scoped db
 * @param {number|null} args.tenantId
 * @param {number} args.userId
 * @param {Object} args.payload              the WS data payload (see header)
 */
async function broadcastUserStatus({ db, tenantId, userId, payload }) {
    const ws = getWs();
    if (!ws?.sendToUser) return;

    try {
        // Send to the user themselves first (multi-tab sync).
        ws.sendToUser(tenantId, userId, 'user_status', payload);

        // Then to org peers. Org membership is the privacy boundary.
        const user = (await db.query('SELECT org_id FROM users WHERE id = $1', [userId])).rows[0];
        if (!user?.org_id) return;
        const peers = (await db.query(
            `SELECT id FROM users
              WHERE org_id = $1 AND id <> $2 AND is_active = TRUE`,
            [user.org_id, userId]
        )).rows;
        for (const p of peers) {
            ws.sendToUser(tenantId, p.id, 'user_status', payload);
        }
    } catch { /* best-effort */ }
}

module.exports = { broadcastUserStatus };