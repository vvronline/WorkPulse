/**
 * Status Service — Redis cache.
 *
 * INVARIANTS:
 *   • Only this file (within the status service) touches Redis.
 *   • Every read MUST gracefully degrade: a Redis outage never breaks the
 *     status service — callers must still receive a valid result by
 *     falling back to the resolver run against fresh DB rows.
 *   • Keys are tenant-prefixed via `redis.tk` (already enforced upstream).
 *
 * What we cache (and what we deliberately do not):
 *   ✓ The pre-resolved effective state per user (hot read in chat presence).
 *   ✗ Individual fields (manual_status, sessions) — keeping those in Redis
 *     would invite drift. Always derive on the server.
 */

const redis = require('../../redis');
const { CACHE_TTL_SEC } = require('./constants');

const KEY_NS = 'status:effective';
const TTL = CACHE_TTL_SEC;

function key(tenantId, userId) {
    // redis.tk handles the per-tenant prefix.
    return redis.KEYS
        ? `t:${tenantId || 0}:${KEY_NS}:${userId}`
        : `${KEY_NS}:${userId}`;
}

/** Get the cached effective state for one user, or null. */
async function getEffective(tenantId, userId) {
    return redis.get(key(tenantId, userId));
}

/** Get the cached effective state for many users. Returns Map<userId, value|null>. */
async function getEffectiveBulk(tenantId, userIds) {
    const out = new Map();
    if (!Array.isArray(userIds) || userIds.length === 0) return out;
    const client = redis.getClient ? redis.getClient() : null;
    if (!client) {
        // No client — return all-misses. Caller falls back to DB.
        for (const id of userIds) out.set(id, null);
        return out;
    }
    try {
        const pipeline = client.pipeline();
        for (const id of userIds) pipeline.get(key(tenantId, id));
        const results = await pipeline.exec();
        for (let i = 0; i < userIds.length; i++) {
            const [err, raw] = results[i] || [null, null];
            if (err || !raw) { out.set(userIds[i], null); continue; }
            try { out.set(userIds[i], JSON.parse(raw)); }
            catch { out.set(userIds[i], null); }
        }
    } catch {
        for (const id of userIds) out.set(id, null);
    }
    return out;
}

/** Store the effective state for a user. Best-effort. */
async function setEffective(tenantId, userId, value) {
    return redis.set(key(tenantId, userId), value, TTL);
}

/** Invalidate one user. */
async function invalidate(tenantId, userId) {
    return redis.del(key(tenantId, userId));
}

module.exports = {
    getEffective,
    getEffectiveBulk,
    setEffective,
    invalidate,
};