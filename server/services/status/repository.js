/**
 * Status Service — DB I/O.
 *
 * INVARIANTS:
 *   • Only this file (within the status service) executes SQL.
 *     resolver.js stays pure; cache.js stays Redis-only; index.js composes.
 *   • Every function takes a `db` object with `.query(sql, params)`.
 *     This makes it pool-agnostic (master pool, tenant pool, or a
 *     transaction client — all conform).
 *   • (PR7) The legacy dual-write helper is removed. The columns
 *     `users.user_status` / `users.user_status_text` are dropped by
 *     migration step 8.
 */

const { isManualStatus, isPresencePreference, isActivity, isSource } = require('./constants');

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Fetch the preferences row for a user. */
async function getUserPrefs(db, userId) {
    const row = (await db.query(
        `SELECT id, manual_status, presence_preference, status_message,
                status_message_expires_at, last_activity_at
           FROM users
          WHERE id = $1`,
        [userId]
    )).rows[0];
    if (!row) return null;
    return {
        userId: row.id,
        manualStatus: row.manual_status,
        presencePreference: row.presence_preference || 'auto',
        statusMessage: row.status_message,
        statusMessageExpiresAt: row.status_message_expires_at,
        lastActivityAt: row.last_activity_at,
    };
}

/** Fetch preferences for many users at once. Returns Map<userId, prefs>. */
async function getUserPrefsBulk(db, userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
    const rows = (await db.query(
        `SELECT id, manual_status, presence_preference, status_message,
                status_message_expires_at, last_activity_at
           FROM users
          WHERE id = ANY($1::int[])`,
        [userIds]
    )).rows;
    const map = new Map();
    for (const row of rows) {
        map.set(row.id, {
            userId: row.id,
            manualStatus: row.manual_status,
            presencePreference: row.presence_preference || 'auto',
            statusMessage: row.status_message,
            statusMessageExpiresAt: row.status_message_expires_at,
            lastActivityAt: row.last_activity_at,
        });
    }
    return map;
}

/** Open sessions for one user. */
async function getOpenSessions(db, userId) {
    return (await db.query(
        `SELECT id, session_key, device_label, connected_at, last_seen_at,
                disconnected_at, activity, activity_ref_id
           FROM user_presence_sessions
          WHERE user_id = $1 AND disconnected_at IS NULL`,
        [userId]
    )).rows.map(mapSessionRow);
}

/** Open sessions for many users. Returns Map<userId, SessionInput[]>. */
async function getOpenSessionsBulk(db, userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
    const rows = (await db.query(
        `SELECT user_id, session_key, device_label, connected_at, last_seen_at,
                disconnected_at, activity, activity_ref_id
           FROM user_presence_sessions
          WHERE user_id = ANY($1::int[]) AND disconnected_at IS NULL`,
        [userIds]
    )).rows;
    const map = new Map();
    for (const id of userIds) map.set(id, []);
    for (const r of rows) {
        // r.user_id is always in `map` because we seeded it above from the
        // same id list, but guard defensively for cases where the caller
        // passes ids as strings.
        let arr = map.get(r.user_id);
        if (!arr) { arr = []; map.set(r.user_id, arr); }
        arr.push(mapSessionRow(r));
    }
    return map;
}

function mapSessionRow(r) {
    return {
        sessionKey: r.session_key,
        deviceLabel: r.device_label,
        connectedAt: r.connected_at,
        lastSeenAt: r.last_seen_at,
        disconnectedAt: r.disconnected_at,
        activity: r.activity,
        activityRefId: r.activity_ref_id,
    };
}

// ─── Writes — user preferences ───────────────────────────────────────────────

async function setManualStatus(db, userId, { status, message, messageExpiresAt }) {
    if (!isManualStatus(status)) throw new TypeError(`setManualStatus: invalid status "${status}"`);
    await db.query(
        `UPDATE users
            SET manual_status = $1,
                status_message = $2,
                status_message_expires_at = $3
          WHERE id = $4`,
        [status, message ?? null, messageExpiresAt ?? null, userId]
    );
}

async function setPresencePreference(db, userId, preference) {
    if (!isPresencePreference(preference)) {
        throw new TypeError(`setPresencePreference: invalid value "${preference}"`);
    }
    await db.query(`UPDATE users SET presence_preference = $1 WHERE id = $2`, [preference, userId]);
}

async function touchLastActivity(db, userId, when = new Date()) {
    await db.query(`UPDATE users SET last_activity_at = $1 WHERE id = $2`, [when, userId]);
}

// ─── Writes — sessions ───────────────────────────────────────────────────────

async function openSession(db, userId, { sessionKey, deviceLabel = null }) {
    if (!sessionKey) throw new TypeError('openSession: sessionKey is required');
    // ON CONFLICT re-opens a session that had been marked disconnected
    // (e.g. brief network blip producing a duplicate WS connect).
    await db.query(
        `INSERT INTO user_presence_sessions (user_id, session_key, device_label, connected_at, last_seen_at)
              VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (session_key) DO UPDATE
                SET disconnected_at = NULL,
                    last_seen_at = NOW(),
                    user_id = EXCLUDED.user_id,
                    device_label = COALESCE(EXCLUDED.device_label, user_presence_sessions.device_label)`,
        [userId, sessionKey, deviceLabel]
    );
}

async function touchSession(db, sessionKey) {
    if (!sessionKey) return;
    await db.query(
        `UPDATE user_presence_sessions SET last_seen_at = NOW()
          WHERE session_key = $1 AND disconnected_at IS NULL`,
        [sessionKey]
    );
}

async function closeSession(db, sessionKey) {
    if (!sessionKey) return null;
    const row = (await db.query(
        `UPDATE user_presence_sessions
            SET disconnected_at = NOW(), activity = NULL, activity_ref_id = NULL
          WHERE session_key = $1 AND disconnected_at IS NULL
          RETURNING user_id`,
        [sessionKey]
    )).rows[0];
    return row?.user_id ?? null;
}

async function closeAllSessionsForUser(db, userId) {
    await db.query(
        `UPDATE user_presence_sessions
            SET disconnected_at = NOW(), activity = NULL, activity_ref_id = NULL
          WHERE user_id = $1 AND disconnected_at IS NULL`,
        [userId]
    );
}

async function setSessionActivity(db, sessionKey, activity, refId = null) {
    if (!sessionKey) throw new TypeError('setSessionActivity: sessionKey is required');
    // `isActivity(null)` is true (null is a valid "no activity" sentinel
    // for the clear path), but setSessionActivity requires a concrete
    // activity — reject null explicitly.
    if (activity === null || !isActivity(activity)) {
        throw new TypeError(`setSessionActivity: invalid activity "${activity}"`);
    }
    const row = (await db.query(
        `UPDATE user_presence_sessions
            SET activity = $2, activity_ref_id = $3, last_seen_at = NOW()
          WHERE session_key = $1 AND disconnected_at IS NULL
          RETURNING user_id`,
        [sessionKey, activity, refId]
    )).rows[0];
    return row?.user_id ?? null;
}

async function clearSessionActivity(db, sessionKey, only = null) {
    if (!sessionKey) return null;
    // `only` lets a "call ended" handler avoid stomping on a meeting activity
    // started in parallel.
    const sql = only
        ? `UPDATE user_presence_sessions
              SET activity = NULL, activity_ref_id = NULL, last_seen_at = NOW()
            WHERE session_key = $1 AND disconnected_at IS NULL AND activity = $2
            RETURNING user_id`
        : `UPDATE user_presence_sessions
              SET activity = NULL, activity_ref_id = NULL, last_seen_at = NOW()
            WHERE session_key = $1 AND disconnected_at IS NULL
            RETURNING user_id`;
    const params = only ? [sessionKey, only] : [sessionKey];
    const row = (await db.query(sql, params)).rows[0];
    return row?.user_id ?? null;
}

/**
 * Clear `activity` from every open session that references this (activity, refId)
 * pair. Used by server-side call_end / meeting_end handlers to drop activity
 * for ALL participants in one go (their own session_key isn't visible here).
 *
 * Returns the list of distinct affected user_ids so the service can re-resolve
 * + broadcast a `user_status` event for each one.
 */
async function clearActivityByRef(db, activity, refId) {
    if (!activity || refId == null) return [];
    if (!isActivity(activity)) {
        throw new TypeError(`clearActivityByRef: invalid activity "${activity}"`);
    }
    const rows = (await db.query(
        `UPDATE user_presence_sessions
            SET activity = NULL, activity_ref_id = NULL, last_seen_at = NOW()
          WHERE activity = $1 AND activity_ref_id = $2 AND disconnected_at IS NULL
          RETURNING user_id`,
        [activity, refId]
    )).rows;
    // Deduplicate — a user may have multiple sessions on the same call.
    return [...new Set(rows.map(r => r.user_id))];
}

// ─── Writes — audit log ──────────────────────────────────────────────────────

async function recordEvent(db, { userId, source, fromState, toState, sessionKey, metadata }) {
    if (!isSource(source)) throw new TypeError(`recordEvent: invalid source "${source}"`);
    await db.query(
        `INSERT INTO user_status_events (user_id, source, from_state, to_state, session_key, metadata)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, source, fromState ?? null, toState ?? null, sessionKey ?? null, metadata ? JSON.stringify(metadata) : null]
    );
}

module.exports = {
    getUserPrefs,
    getUserPrefsBulk,
    getOpenSessions,
    getOpenSessionsBulk,
    setManualStatus,
    setPresencePreference,
    touchLastActivity,
    openSession,
    touchSession,
    closeSession,
    closeAllSessionsForUser,
    setSessionActivity,
    clearSessionActivity,
    clearActivityByRef,
    recordEvent,
};
