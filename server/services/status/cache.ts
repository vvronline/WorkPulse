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

import * as redis from "../../redis";
import { CACHE_TTL_SEC } from "./constants";

const KEY_NS = "status:effective";
const TTL = CACHE_TTL_SEC;

/**
 * Tenant-prefixed key. Format mirrors `redis.tk` so a flat KEYS scan in
 * ops tooling can group every per-tenant key under `t:<id>:...`.
 */
function key(tenantId: number | null | undefined, userId: number): string {
    return tenantId
        ? `t:${tenantId}:${KEY_NS}:${userId}`
        : `${KEY_NS}:${userId}`;
}

/** Get the cached effective state for one user, or null. */
async function getEffective<T = unknown>(tenantId: number | null | undefined, userId: number): Promise<T | null> {
    return redis.get<T>(key(tenantId, userId));
}

/** Get the cached effective state for many users. Returns Map<userId, value|null>. */
async function getEffectiveBulk<T = unknown>(
    tenantId: number | null | undefined,
    userIds: number[],
): Promise<Map<number, T | null>> {
    const out = new Map<number, T | null>();
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
            const [err, raw] = results?.[i] || [null, null];
            if (err || !raw) { out.set(userIds[i], null); continue; }
            try { out.set(userIds[i], JSON.parse(raw as string) as T); }
            catch { out.set(userIds[i], null); }
        }
    } catch {
        for (const id of userIds) out.set(id, null);
    }
    return out;
}

/** Store the effective state for a user. Best-effort. */
async function setEffective(tenantId: number | null | undefined, userId: number, value: unknown): Promise<void> {
    return redis.set(key(tenantId, userId), value, TTL);
}

/** Invalidate one user. */
async function invalidate(tenantId: number | null | undefined, userId: number): Promise<void> {
    return redis.del(key(tenantId, userId));
}

export {
    getEffective,
    getEffectiveBulk,
    setEffective,
    invalidate,
};