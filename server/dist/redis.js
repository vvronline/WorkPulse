"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEYS = exports.TTL = void 0;
exports.initRedis = initRedis;
exports.shutdown = shutdown;
exports.get = get;
exports.set = set;
exports.del = del;
exports.delPattern = delPattern;
exports.getClient = getClient;
exports.getSubscriber = getSubscriber;
exports.publish = publish;
exports.getTokenVersion = getTokenVersion;
exports.setTokenVersion = setTokenVersion;
exports.invalidateTokenVersion = invalidateTokenVersion;
exports.getUserContext = getUserContext;
exports.setUserContext = setUserContext;
exports.invalidateUserContext = invalidateUserContext;
exports.getOrgConfig = getOrgConfig;
exports.setOrgConfig = setOrgConfig;
exports.invalidateOrgConfig = invalidateOrgConfig;
exports.getOrgRolesMap = getOrgRolesMap;
exports.setOrgRolesMap = setOrgRolesMap;
exports.invalidateOrgRolesMap = invalidateOrgRolesMap;
exports.invalidateOrgUserContexts = invalidateOrgUserContexts;
exports.getUserSessions = getUserSessions;
exports.setUserSessions = setUserSessions;
exports.invalidateUserSessions = invalidateUserSessions;
exports.setPresence = setPresence;
exports.removePresence = removePresence;
exports.isOnline = isOnline;
exports.getOnlineUsers = getOnlineUsers;
exports.incrUnread = incrUnread;
exports.resetUnread = resetUnread;
exports.getUnreadCounts = getUnreadCounts;
exports.getSearchCache = getSearchCache;
exports.setSearchCache = setSearchCache;
exports.getActiveSprint = getActiveSprint;
exports.setActiveSprint = setActiveSprint;
exports.invalidateActiveSprint = invalidateActiveSprint;
exports.getMeetingParticipants = getMeetingParticipants;
exports.setMeetingParticipants = setMeetingParticipants;
exports.invalidateMeetingParticipants = invalidateMeetingParticipants;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("./utils/logger");
let client = null;
let subscriber = null; // dedicated connection for Pub/Sub
let isReady = false;
// TTLs in seconds
const TTL = {
    TOKEN_VERSION: 5 * 60, // 5 minutes
    USER_CONTEXT: 60 * 60, // 1 hour
    ORG_CONFIG: 24 * 60 * 60, // 24 hours
    SEARCH: 2 * 60, // 2 minutes
    PRESENCE: 90, // 90 seconds (heartbeat-based)
    SPRINT: 5 * 60, // 5 minutes
    MEETING_PARTICIPANTS: 30 * 60, // 30 minutes
};
exports.TTL = TTL;
// One-shot guard so we don't print the same Redis error 1000+ times when
// the host is unreachable (every ioredis reconnect attempt fires `error`).
let redisErrorLogged = false;
/**
 * Stop a Redis client from looping forever when the host is unreachable.
 *
 * ioredis defaults are extremely aggressive: even with
 * `maxRetriesPerRequest: 1` and a custom `retryStrategy`, every TCP
 * connect attempt that times out (~30 s on Railway's private network when
 * no Redis service exists) fires an `error` event, ioredis schedules
 * another attempt, and the cycle never ends — flooding the log with
 * `Error: connect ETIMEDOUT` and consuming CPU.
 *
 * We give the cluster a small grace window for transient blips, then
 * disconnect for good and switch the in-memory fallback on. The next
 * deploy will re-attempt. This is the right trade-off for a process-per-
 * container model like Railway: failing loud at deploy time is fine,
 * silent-spam-forever at runtime isn't.
 */
function attachFailFast(c, label) {
    let attempts = 0;
    let killed = false;
    c.on("connect", () => { attempts = 0; });
    c.on("error", (err) => {
        attempts++;
        if (!redisErrorLogged) {
            logger_1.logger.warn({ err: err.message, label }, "Redis unreachable — falling back to in-memory cache");
            redisErrorLogged = true;
        }
        if (attempts >= 3 && !killed) {
            killed = true;
            try {
                c.disconnect();
            }
            catch { /* ignore */ }
            // Mark as not-ready forever; the rest of the app silently uses
            // its in-memory fallbacks (rate-limit MemoryStore, in-proc
            // cache for org config + user context, etc.).
        }
    });
}
function initRedis() {
    const url = process.env.REDIS_URL || null;
    if (!url) {
        logger_1.logger.info("REDIS_URL not set — running without Redis cache");
        return;
    }
    const options = {
        // Railway private networking (*.railway.internal) resolves to IPv6
        // ONLY. ioredis defaults to family: 4 (IPv4), so the DNS lookup
        // returns an AAAA record the IPv4 socket can't reach → connect
        // ETIMEDOUT (retried forever). family: 0 lets Node pick whichever
        // address family DNS returns (IPv4 or IPv6), which is required for
        // the internal Redis host and harmless for public hosts.
        family: 0,
        // Short per-request retry budget so the API doesn't stall behind a
        // dead Redis.
        maxRetriesPerRequest: 1,
        // Short TCP connect timeout so failures surface quickly instead
        // of waiting for the OS default ~30 s ETIMEDOUT.
        connectTimeout: 4_000,
        // Don't buffer commands while the connection is down — return
        // immediately so callers fall through to the in-memory fallback.
        enableOfflineQueue: false,
        // Cap retry attempts in the initial connect / reconnect loop.
        // After 3 attempts we stop trying forever (see attachFailFast).
        retryStrategy(times) {
            if (times >= 3)
                return null;
            return Math.min(times * 500, 2_000);
        },
        // Reconnect on transient READONLY/ETIMEDOUT-style errors but bail
        // on auth/host errors.
        reconnectOnError(err) {
            const msg = String(err && err.message || "");
            return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE/.test(msg);
        },
        lazyConnect: true,
    };
    client = new ioredis_1.default(url, options);
    client.on("connect", () => {
        isReady = true;
        redisErrorLogged = false;
        logger_1.logger.info("Redis connected");
    });
    client.on("ready", () => { isReady = true; });
    client.on("close", () => { isReady = false; });
    client.on("end", () => { isReady = false; });
    attachFailFast(client, "client");
    client.connect().catch((err) => {
        if (!redisErrorLogged) {
            logger_1.logger.warn({ err: err.message }, "Redis initial connection failed — running without cache");
            redisErrorLogged = true;
        }
    });
    // Dedicated subscriber connection for Pub/Sub.
    //
    // Subscribers in ioredis intentionally allow infinite per-request
    // retries (`maxRetriesPerRequest: null`) because subscribe state
    // can't be replayed by the caller. We still want to stop the
    // *reconnect loop* though, so we apply the same fail-fast guard.
    subscriber = new ioredis_1.default(url, { ...options, maxRetriesPerRequest: null });
    attachFailFast(subscriber, "subscriber");
    subscriber.connect().catch(() => { });
}
// -- core helpers (all gracefully degrade) --
async function get(key) {
    if (!isReady || !client)
        return null;
    try {
        const val = await client.get(key);
        return val ? JSON.parse(val) : null;
    }
    catch {
        return null;
    }
}
async function set(key, value, ttlSeconds) {
    if (!isReady || !client)
        return;
    try {
        await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    }
    catch { /* ignore */ }
}
async function del(...keys) {
    if (!isReady || !client)
        return;
    try {
        await client.del(...keys);
    }
    catch { /* ignore */ }
}
async function delPattern(pattern) {
    if (!isReady || !client)
        return;
    try {
        let cursor = "0";
        do {
            const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = nextCursor;
            if (keys.length > 0)
                await client.del(...keys);
        } while (cursor !== "0");
    }
    catch { /* ignore */ }
}
// -- Pub/Sub helpers --
function getSubscriber() { return subscriber; }
function getClient() { return client; }
async function publish(channel, data) {
    if (!isReady || !client)
        return;
    try {
        await client.publish(channel, JSON.stringify(data));
    }
    catch { /* ignore */ }
}
// -- Tenant-scoped key helper --
// All tenant-scoped data MUST include tenantId to prevent cross-tenant collisions.
// Keys are prefixed: t:<tenantId>:<originalKey>  (or just <originalKey> when tenantId is null for master context).
function tk(tenantId, ...parts) {
    const base = parts.join(":");
    return tenantId ? `t:${tenantId}:${base}` : base;
}
// -- Presence helpers --
async function setPresence(tenantId, userId, ttlSeconds) {
    if (!isReady || !client)
        return;
    try {
        await client.set(tk(tenantId, "presence", userId), "1", "EX", ttlSeconds || TTL.PRESENCE);
    }
    catch { /* ignore */ }
}
async function removePresence(tenantId, userId) {
    if (!isReady || !client)
        return;
    try {
        await client.del(tk(tenantId, "presence", userId));
    }
    catch { /* ignore */ }
}
async function isOnline(tenantId, userId) {
    if (!isReady || !client)
        return null;
    try {
        return !!(await client.exists(tk(tenantId, "presence", userId)));
    }
    catch {
        return null;
    }
}
async function getOnlineUsers(tenantId, userIds) {
    if (!isReady || !client || !userIds.length)
        return null;
    try {
        const pipeline = client.pipeline();
        for (const id of userIds)
            pipeline.exists(tk(tenantId, "presence", id));
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < userIds.length; i++) {
            // Pipeline can return undefined / null entries when the
            // connection drops mid-flight. Destructuring those crashes
            // — fall back to 'offline'.
            const entry = results?.[i];
            if (!entry) {
                map[userIds[i]] = "offline";
                continue;
            }
            const [err, val] = entry;
            map[userIds[i]] = !err && val === 1 ? "online" : "offline";
        }
        return map;
    }
    catch {
        return null;
    }
}
// -- User status helpers --
//
// PR8 / ADR-0001 step 8: the per-user `user_status` Redis cache was a v1
// fallback for the legacy `users.user_status` column. The v2 status service
// owns its own cache in services/status/cache.js (keyed on tenantId+userId,
// containing the full resolved payload). The old helpers (setUserStatus /
// getUserStatus / getUserStatuses) were deleted; no callers remain.
// -- Unread counter helpers --
async function incrUnread(tenantId, userId, conversationId) {
    if (!isReady || !client)
        return;
    try {
        await client.incr(tk(tenantId, "unread", userId, conversationId));
    }
    catch { /* ignore */ }
}
async function resetUnread(tenantId, userId, conversationId) {
    if (!isReady || !client)
        return;
    try {
        await client.del(tk(tenantId, "unread", userId, conversationId));
    }
    catch { /* ignore */ }
}
async function getUnreadCounts(tenantId, userId, conversationIds) {
    if (!isReady || !client || !conversationIds.length)
        return null;
    try {
        const pipeline = client.pipeline();
        for (const cid of conversationIds)
            pipeline.get(tk(tenantId, "unread", userId, cid));
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < conversationIds.length; i++) {
            // Defensive: see comment in getOnlineUsers — pipeline entries
            // may be missing if the connection is torn down mid-flight.
            const entry = results?.[i];
            map[conversationIds[i]] = entry && !entry[0] ? (parseInt(entry[1], 10) || 0) : 0;
        }
        return map;
    }
    catch {
        return null;
    }
}
// -- Search cache helpers --
function searchKey(tenantId, userId, queryStr) {
    const crypto = require("crypto");
    const hash = crypto.createHash("md5").update(queryStr).digest("hex");
    return tk(tenantId, "search", userId, hash);
}
async function getSearchCache(tenantId, userId, queryStr) {
    return get(searchKey(tenantId, userId, queryStr));
}
async function setSearchCache(tenantId, userId, queryStr, results) {
    return set(searchKey(tenantId, userId, queryStr), results, TTL.SEARCH);
}
// -- Sprint cache helpers --
async function getActiveSprint(tenantId, teamId) {
    return get(tk(tenantId, "sprint", "active", teamId));
}
async function setActiveSprint(tenantId, teamId, sprint) {
    return set(tk(tenantId, "sprint", "active", teamId), sprint, TTL.SPRINT);
}
async function invalidateActiveSprint(tenantId, teamId) {
    return del(tk(tenantId, "sprint", "active", teamId));
}
// -- Meeting participant cache helpers --
async function getMeetingParticipants(tenantId, meetingId) {
    return get(tk(tenantId, "meeting", meetingId, "participants"));
}
async function setMeetingParticipants(tenantId, meetingId, participants) {
    return set(tk(tenantId, "meeting", meetingId, "participants"), participants, TTL.MEETING_PARTICIPANTS);
}
async function invalidateMeetingParticipants(tenantId, meetingId) {
    return del(tk(tenantId, "meeting", meetingId, "participants"));
}
// -- domain-specific cache helpers --
const KEYS = {
    tokenVersion: (tenantId, userId) => tk(tenantId, "user", userId, "tv"),
    userContext: (tenantId, userId) => tk(tenantId, "user", userId, "ctx"),
    orgConfig: (tenantId, orgId) => tk(tenantId, "org", orgId, "config"),
    orgRolesMap: (tenantId, orgId) => tk(tenantId, "org", orgId, "roles"),
    userSessions: (tenantId, userId) => tk(tenantId, "user", userId, "sessions"),
};
exports.KEYS = KEYS;
async function getTokenVersion(tenantId, userId) {
    return get(KEYS.tokenVersion(tenantId, userId));
}
async function setTokenVersion(tenantId, userId, version) {
    return set(KEYS.tokenVersion(tenantId, userId), version, TTL.TOKEN_VERSION);
}
async function invalidateTokenVersion(tenantId, userId) {
    return del(KEYS.tokenVersion(tenantId, userId));
}
async function getUserContext(tenantId, userId) {
    return get(KEYS.userContext(tenantId, userId));
}
async function setUserContext(tenantId, userId, context) {
    return set(KEYS.userContext(tenantId, userId), context, TTL.USER_CONTEXT);
}
async function invalidateUserContext(tenantId, userId) {
    return del(KEYS.userContext(tenantId, userId));
}
async function getOrgConfig(tenantId, orgId) {
    return get(KEYS.orgConfig(tenantId, orgId));
}
async function setOrgConfig(tenantId, orgId, config) {
    return set(KEYS.orgConfig(tenantId, orgId), config, TTL.ORG_CONFIG);
}
async function invalidateOrgConfig(tenantId, orgId) {
    return del(KEYS.orgConfig(tenantId, orgId));
}
// -- Org tenant_roles map cache (used by rbac.js / tenant role admin endpoints) --
async function getOrgRolesMap(tenantId, orgId) {
    return get(KEYS.orgRolesMap(tenantId, orgId));
}
async function setOrgRolesMap(tenantId, orgId, map) {
    return set(KEYS.orgRolesMap(tenantId, orgId), map, 5 * 60);
}
async function invalidateOrgRolesMap(tenantId, orgId) {
    return del(KEYS.orgRolesMap(tenantId, orgId));
}
/**
 * Drop every cached user-context row scoped to this tenant. Called after a
 * tenant_roles mutation so the next request recomputes role_level from the
 * fresh map. This is a coarse SCAN — fine for the low frequency of role
 * config edits.
 */
async function invalidateOrgUserContexts(tenantId /* , orgId */) {
    if (!isReady || !tenantId)
        return;
    return delPattern(`t:${tenantId}:user:*:ctx`);
}
// -- Session helpers (max-2-device enforcement) --
async function getUserSessions(tenantId, userId) {
    return get(KEYS.userSessions(tenantId, userId));
}
async function setUserSessions(tenantId, userId, sessionIds) {
    return set(KEYS.userSessions(tenantId, userId), sessionIds, TTL.USER_CONTEXT);
}
async function invalidateUserSessions(tenantId, userId) {
    return del(KEYS.userSessions(tenantId, userId));
}
async function shutdown() {
    if (subscriber) {
        try {
            await subscriber.quit();
        }
        catch { /* ignore */ }
    }
    if (client) {
        try {
            await client.quit();
        }
        catch { /* ignore */ }
    }
}
//# sourceMappingURL=redis.js.map