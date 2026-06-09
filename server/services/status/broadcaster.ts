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

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

interface WsModule {
    sendToUser?: (tenantId: number | null, userId: number, type: string, payload: unknown) => void;
}

interface BroadcastArgs {
    db: DbLike;
    tenantId: number | null;
    userId: number;
    payload: unknown;
}

// Lazy import to avoid circular requires during boot.
function getWs(): WsModule | null {
    try { return require("../../utils/ws") as WsModule; } catch { return null; }
}

/**
 * Broadcast the user's new effective state to themselves and to every
 * online member of their organisation.
 */
async function broadcastUserStatus({ db, tenantId, userId, payload }: BroadcastArgs): Promise<void> {
    const ws = getWs();
    if (!ws?.sendToUser) return;

    try {
        // Send to the user themselves first (multi-tab sync).
        ws.sendToUser(tenantId, userId, "user_status", payload);

        // Then to org peers. Org membership is the privacy boundary.
        // Single SQL round-trip: derive org_id from the actor row and fan
        // out to every active peer in one query (the previous version did
        // two sequential queries — one for org_id, one for peers).
        const peers = (await db.query(
            `SELECT p.id
               FROM users a
               JOIN users p ON p.org_id = a.org_id
              WHERE a.id = $1
                AND p.id <> $1
                AND p.is_active = TRUE
                AND a.org_id IS NOT NULL`,
            [userId],
        )).rows;
        for (const p of peers) {
            ws.sendToUser(tenantId, p.id, "user_status", payload);
        }
    } catch { /* best-effort */ }
}

export { broadcastUserStatus };