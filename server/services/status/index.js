/**
 * Status Service — public API (façade).
 *
 * This is the ONLY surface other code may use.
 *   const statusService = require('./services/status');
 *   await statusService.setManualStatus(ctx, { status: 'dnd' });
 *
 * INVARIANTS:
 *   • Every mutator goes through `applyChange()` so that the side-effect
 *     chain (DB write → audit row → cache refresh → WS broadcast → legacy
 *     dual-write) is identical for every call site. New mutators MUST
 *     extend `applyChange`, never bypass it.
 *   • `ctx` is uniform: `{ db, tenantId, actorUserId, logger? }`.
 *     A missing `db` is a programmer error — throw, do not silently noop.
 *
 * Reading "status" elsewhere in the app:
 *   ALWAYS call `getEffective` / `getEffectiveBulk`. Never SELECT
 *   `users.user_status` or `users.manual_status` directly outside this
 *   folder — the resolver may add inputs (e.g. holiday calendar) and you
 *   would silently desync.
 */

const constants = require('./constants');
const resolver = require('./resolver');
const repo = require('./repository');
const cache = require('./cache');
const broadcaster = require('./broadcaster');

// ─── Validators (centralised so the error messages are uniform) ──────────────

function assertCtx(ctx) {
    if (!ctx || !ctx.db || typeof ctx.db.query !== 'function') {
        throw new TypeError('statusService: ctx.db is required');
    }
}

// ─── Core: re-resolve and propagate a change for one user ────────────────────

/**
 * Re-fetch prefs + open sessions for `userId`, run the resolver, then:
 *   1. Persist a `user_status_events` row (audit).
 *   2. Update Redis cache.
 *   3. Broadcast the unified `user_status` WS event.
 *   4. Legacy dual-write to `users.user_status` (best-effort, deletable).
 *
 * Returns the new payload (also the value broadcast on the WS).
 */
async function applyChange(ctx, { userId, source, sessionKey = null, previousEffective = null, metadata = null }) {
    assertCtx(ctx);
    if (!userId) throw new TypeError('applyChange: userId is required');
    if (!constants.isSource(source)) throw new TypeError(`applyChange: invalid source "${source}"`);

    const [prefs, sessions] = await Promise.all([
        repo.getUserPrefs(ctx.db, userId),
        repo.getOpenSessions(ctx.db, userId),
    ]);

    // Defensive: a deleted user could race a status update. Bail gracefully.
    if (!prefs) return null;

    const resolved = resolver.resolveEffective({
        sessions,
        manualStatus: prefs.manualStatus,
        presencePreference: prefs.presencePreference,
        lastActivityAt: prefs.lastActivityAt,
        now: new Date(),
    });

    const payload = {
        userId,
        effective: resolved.effective,
        presence: resolved.presence,
        manualStatus: prefs.manualStatus,
        presencePreference: prefs.presencePreference,
        statusMessage: prefs.statusMessage,
        statusMessageExpiresAt: prefs.statusMessageExpiresAt,
        source: resolved.source, // resolver-determined; usually equals `source` arg
    };

    // 1) Audit.
    try {
        await repo.recordEvent(ctx.db, {
            userId,
            source,                    // explicit "why we ran" (e.g. 'user', 'call')
            fromState: previousEffective,
            toState: resolved.effective,
            sessionKey,
            metadata,
        });
    } catch (err) {
        ctx.logger?.warn?.({ err: err.message, userId }, 'statusService: failed to record event');
    }

    // 2) Cache.
    await cache.setEffective(ctx.tenantId, userId, payload);

    // 3) Broadcast.
    broadcaster.broadcastUserStatus({
        db: ctx.db, tenantId: ctx.tenantId, userId, payload,
    }).catch(() => { });

    // (PR7) Legacy dual-write to users.user_status / users.user_status_text
    // was removed here. The column is dropped in PR8's migration.

    return payload;
}

// ─── Public API: preferences ─────────────────────────────────────────────────

async function setManualStatus(ctx, { status, message = null, messageExpiresAt = null }) {
    assertCtx(ctx);
    const userId = ctx.actorUserId;
    if (!userId) throw new TypeError('setManualStatus: ctx.actorUserId required');
    const previous = await peekEffective(ctx, userId);
    await repo.setManualStatus(ctx.db, userId, { status, message, messageExpiresAt });
    return applyChange(ctx, { userId, source: 'user', previousEffective: previous?.effective });
}

async function setPresencePreference(ctx, preference) {
    assertCtx(ctx);
    const userId = ctx.actorUserId;
    if (!userId) throw new TypeError('setPresencePreference: ctx.actorUserId required');
    const previous = await peekEffective(ctx, userId);
    await repo.setPresencePreference(ctx.db, userId, preference);
    return applyChange(ctx, { userId, source: 'user', previousEffective: previous?.effective });
}

async function recordActivityPing(ctx) {
    assertCtx(ctx);
    const userId = ctx.actorUserId;
    if (!userId) return null;
    await repo.touchLastActivity(ctx.db, userId);
    // No broadcast: a single key-press shouldn't spam the org. The next
    // status read picks up the new `last_activity_at`. If the user was
    // resolved as 'away', the next event-driven re-resolve flips them back.
    await cache.invalidate(ctx.tenantId, userId);
    return null;
}

// ─── Public API: sessions ────────────────────────────────────────────────────

async function openSession(ctx, { userId, sessionKey, deviceLabel = null }) {
    assertCtx(ctx);
    if (!userId || !sessionKey) throw new TypeError('openSession: userId and sessionKey required');
    const previous = await peekEffective(ctx, userId);
    await repo.openSession(ctx.db, userId, { sessionKey, deviceLabel });
    await repo.touchLastActivity(ctx.db, userId);
    return applyChange(ctx, {
        userId, source: 'session_open', sessionKey,
        previousEffective: previous?.effective,
    });
}

async function touchSession(ctx, sessionKey) {
    assertCtx(ctx);
    if (!sessionKey) return null;
    await repo.touchSession(ctx.db, sessionKey);
    // No broadcast — pong heartbeats are too frequent. The resolver picks
    // up the fresh `last_seen_at` next time anything else triggers a refresh.
    return null;
}

async function closeSession(ctx, sessionKey) {
    assertCtx(ctx);
    if (!sessionKey) return null;
    const userId = await repo.closeSession(ctx.db, sessionKey);
    if (!userId) return null;
    const previous = await peekEffective(ctx, userId);
    return applyChange(ctx, {
        userId, source: 'session_close', sessionKey,
        previousEffective: previous?.effective,
    });
}

async function closeAllSessions(ctx, userId, { source = 'logout' } = {}) {
    assertCtx(ctx);
    if (!userId) throw new TypeError('closeAllSessions: userId required');
    if (!constants.isSource(source)) throw new TypeError(`closeAllSessions: invalid source "${source}"`);
    const previous = await peekEffective(ctx, userId);
    await repo.closeAllSessionsForUser(ctx.db, userId);
    return applyChange(ctx, { userId, source, previousEffective: previous?.effective });
}

// ─── Public API: per-session activity (calls / meetings) ─────────────────────

async function setSessionActivity(ctx, sessionKey, activity, refId = null) {
    assertCtx(ctx);
    const userId = await repo.setSessionActivity(ctx.db, sessionKey, activity, refId);
    if (!userId) return null;
    const previous = await peekEffective(ctx, userId);
    const source = activity === 'in_call' ? 'call' : 'meeting';
    return applyChange(ctx, { userId, source, sessionKey, previousEffective: previous?.effective });
}

async function clearSessionActivity(ctx, sessionKey, only = null) {
    assertCtx(ctx);
    const userId = await repo.clearSessionActivity(ctx.db, sessionKey, only);
    if (!userId) return null;
    const previous = await peekEffective(ctx, userId);
    const source = only === 'in_meeting' ? 'meeting' : 'call';
    return applyChange(ctx, { userId, source, sessionKey, previousEffective: previous?.effective });
}

/**
 * Drop the given (activity, refId) for ALL participants of a call/meeting.
 *
 * Used when a call_end / meeting_end event arrives server-side: the handler
 * knows the callId/meetingId but not each participant's session_key. This
 * sweeps every open session matching the ref and broadcasts a
 * `user_status` event per affected user.
 */
async function clearActivityForRef(ctx, activity, refId) {
    assertCtx(ctx);
    const source = activity === 'in_meeting' ? 'meeting' : 'call';
    const userIds = await repo.clearActivityByRef(ctx.db, activity, refId);
    const results = [];
    for (const userId of userIds) {
        const previous = await peekEffective(ctx, userId);
        const payload = await applyChange(ctx, {
            userId, source,
            previousEffective: previous?.effective,
            metadata: { activity, refId },
        });
        if (payload) results.push(payload);
    }
    return results;
}

// ─── Public API: reads ───────────────────────────────────────────────────────

/**
 * Get the effective state for one user. Uses cache; falls back to a fresh
 * resolve on miss.
 */
async function getEffective(ctx, userId) {
    assertCtx(ctx);
    if (!userId) return null;
    const cached = await cache.getEffective(ctx.tenantId, userId);
    if (cached) return cached;
    return resolveAndCache(ctx, userId);
}

/**
 * Bulk variant. Single pipeline call to Redis, single SQL round-trip for
 * the misses.
 */
async function getEffectiveBulk(ctx, userIds) {
    assertCtx(ctx);
    if (!Array.isArray(userIds) || userIds.length === 0) return {};

    const ids = [...new Set(userIds.map(Number).filter(Boolean))];
    const cacheMap = await cache.getEffectiveBulk(ctx.tenantId, ids);

    const out = {};
    const misses = [];
    for (const id of ids) {
        const v = cacheMap.get(id);
        if (v) out[id] = v;
        else misses.push(id);
    }

    if (misses.length > 0) {
        const [prefsMap, sessionsMap] = await Promise.all([
            repo.getUserPrefsBulk(ctx.db, misses),
            repo.getOpenSessionsBulk(ctx.db, misses),
        ]);
        const now = new Date();
        for (const id of misses) {
            const prefs = prefsMap.get(id);
            if (!prefs) { out[id] = offlinePayload(id); continue; }
            const sessions = sessionsMap.get(id) || [];
            const resolved = resolver.resolveEffective({
                sessions,
                manualStatus: prefs.manualStatus,
                presencePreference: prefs.presencePreference,
                lastActivityAt: prefs.lastActivityAt,
                now,
            });
            const payload = toPayload(id, prefs, resolved);
            out[id] = payload;
            cache.setEffective(ctx.tenantId, id, payload).catch(() => { });
        }
    }
    return out;
}

// ─── Internals ───────────────────────────────────────────────────────────────

/** Resolve from DB and prime the cache. Used on cache miss. */
async function resolveAndCache(ctx, userId) {
    const [prefs, sessions] = await Promise.all([
        repo.getUserPrefs(ctx.db, userId),
        repo.getOpenSessions(ctx.db, userId),
    ]);
    if (!prefs) return offlinePayload(userId);
    const resolved = resolver.resolveEffective({
        sessions,
        manualStatus: prefs.manualStatus,
        presencePreference: prefs.presencePreference,
        lastActivityAt: prefs.lastActivityAt,
        now: new Date(),
    });
    const payload = toPayload(userId, prefs, resolved);
    cache.setEffective(ctx.tenantId, userId, payload).catch(() => { });
    return payload;
}

/** Cheap "what's the current value?" read used only for audit `from_state`. */
async function peekEffective(ctx, userId) {
    try {
        const cached = await cache.getEffective(ctx.tenantId, userId);
        return cached || null;
    } catch { return null; }
}

function toPayload(userId, prefs, resolved) {
    return {
        userId,
        effective: resolved.effective,
        presence: resolved.presence,
        manualStatus: prefs.manualStatus,
        presencePreference: prefs.presencePreference,
        statusMessage: prefs.statusMessage,
        statusMessageExpiresAt: prefs.statusMessageExpiresAt,
        source: resolved.source,
    };
}

function offlinePayload(userId) {
    return {
        userId,
        effective: 'offline',
        presence: 'offline',
        manualStatus: null,
        presencePreference: 'auto',
        statusMessage: null,
        statusMessageExpiresAt: null,
        source: 'system',
    };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    // Preferences
    setManualStatus,
    setPresencePreference,
    recordActivityPing,
    // Sessions
    openSession,
    touchSession,
    closeSession,
    closeAllSessions,
    // Activity
    setSessionActivity,
    clearSessionActivity,
    clearActivityForRef,
    // Reads
    getEffective,
    getEffectiveBulk,
    // Constants — re-exported for ergonomic imports
    MANUAL_STATUSES: constants.MANUAL_STATUSES,
    PRESENCE_PREFERENCES: constants.PRESENCE_PREFERENCES,
    ACTIVITIES: constants.ACTIVITIES,
    EFFECTIVE_STATUSES: constants.EFFECTIVE_STATUSES,
};