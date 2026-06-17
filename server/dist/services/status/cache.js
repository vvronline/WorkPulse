"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEffective = getEffective;
exports.getEffectiveBulk = getEffectiveBulk;
exports.setEffective = setEffective;
exports.invalidate = invalidate;
const redis = __importStar(require("../../redis"));
const constants_1 = require("./constants");
const KEY_NS = "status:effective";
const TTL = constants_1.CACHE_TTL_SEC;
/**
 * Tenant-prefixed key. Format mirrors `redis.tk` so a flat KEYS scan in
 * ops tooling can group every per-tenant key under `t:<id>:...`.
 */
function key(tenantId, userId) {
    return tenantId
        ? `t:${tenantId}:${KEY_NS}:${userId}`
        : `${KEY_NS}:${userId}`;
}
/** Get the cached effective state for one user, or null. */
async function getEffective(tenantId, userId) {
    return redis.get(key(tenantId, userId));
}
/** Get the cached effective state for many users. Returns Map<userId, value|null>. */
async function getEffectiveBulk(tenantId, userIds) {
    const out = new Map();
    if (!Array.isArray(userIds) || userIds.length === 0)
        return out;
    const client = redis.getClient ? redis.getClient() : null;
    if (!client) {
        // No client — return all-misses. Caller falls back to DB.
        for (const id of userIds)
            out.set(id, null);
        return out;
    }
    try {
        const pipeline = client.pipeline();
        for (const id of userIds)
            pipeline.get(key(tenantId, id));
        const results = await pipeline.exec();
        for (let i = 0; i < userIds.length; i++) {
            const [err, raw] = results?.[i] || [null, null];
            if (err || !raw) {
                out.set(userIds[i], null);
                continue;
            }
            try {
                out.set(userIds[i], JSON.parse(raw));
            }
            catch {
                out.set(userIds[i], null);
            }
        }
    }
    catch {
        for (const id of userIds)
            out.set(id, null);
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
//# sourceMappingURL=cache.js.map