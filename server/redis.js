const Redis = require('ioredis');
const { logger } = require('./utils/logger');

let client = null;
let subscriber = null; // dedicated connection for Pub/Sub
let isReady = false;

// TTLs in seconds
const TTL = {
    TOKEN_VERSION: 5 * 60,      // 5 minutes
    USER_CONTEXT: 60 * 60,      // 1 hour
    ORG_CONFIG: 24 * 60 * 60,   // 24 hours
    SEARCH: 2 * 60,             // 2 minutes
    PRESENCE: 90,               // 90 seconds (heartbeat-based)
    SPRINT: 5 * 60,             // 5 minutes
    MEETING_PARTICIPANTS: 30 * 60, // 30 minutes
};

function initRedis() {
    const url = process.env.REDIS_URL || null;
    if (!url) {
        logger.info('REDIS_URL not set — running without Redis cache');
        return;
    }

    const options = {
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
            if (times > 5) return null; // stop retrying after 5 attempts
            return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
    };

    client = new Redis(url, options);

    client.on('connect', () => {
        isReady = true;
        logger.info('Redis connected');
    });
    client.on('ready', () => { isReady = true; });
    client.on('error', (err) => {
        isReady = false;
        logger.warn({ err: err.message }, 'Redis error — falling back to DB');
    });
    client.on('close', () => { isReady = false; });

    client.connect().catch((err) => {
        logger.warn({ err: err.message }, 'Redis initial connection failed — running without cache');
    });

    // Dedicated subscriber connection for Pub/Sub
    subscriber = new Redis(url, { ...options, maxRetriesPerRequest: null });
    subscriber.connect().catch(() => { });
}

// -- core helpers (all gracefully degrade) --

async function get(key) {
    if (!isReady) return null;
    try {
        const val = await client.get(key);
        return val ? JSON.parse(val) : null;
    } catch { return null; }
}

async function set(key, value, ttlSeconds) {
    if (!isReady) return;
    try {
        await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch { /* ignore */ }
}

async function del(...keys) {
    if (!isReady) return;
    try {
        await client.del(...keys);
    } catch { /* ignore */ }
}

async function delPattern(pattern) {
    if (!isReady) return;
    try {
        let cursor = '0';
        do {
            const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            if (keys.length > 0) await client.del(...keys);
        } while (cursor !== '0');
    } catch { /* ignore */ }
}

// -- Pub/Sub helpers --

function getSubscriber() { return subscriber; }
function getClient() { return client; }

async function publish(channel, data) {
    if (!isReady) return;
    try {
        await client.publish(channel, JSON.stringify(data));
    } catch { /* ignore */ }
}

// -- Tenant-scoped key helper --
// All tenant-scoped data MUST include tenantId to prevent cross-tenant collisions.
// Keys are prefixed: t:<tenantId>:<originalKey>  (or just <originalKey> when tenantId is null for master context).
function tk(tenantId, ...parts) {
    const base = parts.join(':');
    return tenantId ? `t:${tenantId}:${base}` : base;
}

// -- Presence helpers --

async function setPresence(tenantId, userId, ttlSeconds) {
    if (!isReady) return;
    try {
        await client.set(tk(tenantId, 'presence', userId), '1', 'EX', ttlSeconds || TTL.PRESENCE);
    } catch { /* ignore */ }
}

async function removePresence(tenantId, userId) {
    if (!isReady) return;
    try { await client.del(tk(tenantId, 'presence', userId)); } catch { /* ignore */ }
}

async function isOnline(tenantId, userId) {
    if (!isReady) return null;
    try {
        return !!(await client.exists(tk(tenantId, 'presence', userId)));
    } catch { return null; }
}

async function getOnlineUsers(tenantId, userIds) {
    if (!isReady || !userIds.length) return null;
    try {
        const pipeline = client.pipeline();
        for (const id of userIds) pipeline.exists(tk(tenantId, 'presence', id));
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < userIds.length; i++) {
            const [err, val] = results[i];
            map[userIds[i]] = !err && val === 1 ? 'online' : 'offline';
        }
        return map;
    } catch { return null; }
}

// -- User status helpers --

async function setUserStatus(tenantId, userId, status) {
    if (!isReady) return;
    try {
        await client.set(tk(tenantId, 'user_status', userId), status, 'EX', TTL.USER_CONTEXT);
    } catch { /* ignore */ }
}

async function getUserStatus(tenantId, userId) {
    if (!isReady) return null;
    try {
        return await client.get(tk(tenantId, 'user_status', userId));
    } catch { return null; }
}

async function getUserStatuses(tenantId, userIds) {
    if (!isReady || !userIds.length) return null;
    try {
        const pipeline = client.pipeline();
        for (const id of userIds) pipeline.get(tk(tenantId, 'user_status', id));
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < userIds.length; i++) {
            map[userIds[i]] = results[i][1] || 'available';
        }
        return map;
    } catch { return null; }
}

// -- Unread counter helpers --

async function incrUnread(tenantId, userId, conversationId) {
    if (!isReady) return;
    try {
        await client.incr(tk(tenantId, 'unread', userId, conversationId));
    } catch { /* ignore */ }
}

async function resetUnread(tenantId, userId, conversationId) {
    if (!isReady) return;
    try {
        await client.del(tk(tenantId, 'unread', userId, conversationId));
    } catch { /* ignore */ }
}

async function getUnreadCounts(tenantId, userId, conversationIds) {
    if (!isReady || !conversationIds.length) return null;
    try {
        const pipeline = client.pipeline();
        for (const cid of conversationIds) pipeline.get(tk(tenantId, 'unread', userId, cid));
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < conversationIds.length; i++) {
            map[conversationIds[i]] = parseInt(results[i][1], 10) || 0;
        }
        return map;
    } catch { return null; }
}

// -- Search cache helpers --

function searchKey(tenantId, userId, queryStr) {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(queryStr).digest('hex');
    return tk(tenantId, 'search', userId, hash);
}

async function getSearchCache(tenantId, userId, queryStr) {
    return get(searchKey(tenantId, userId, queryStr));
}

async function setSearchCache(tenantId, userId, queryStr, results) {
    return set(searchKey(tenantId, userId, queryStr), results, TTL.SEARCH);
}

// -- Sprint cache helpers --

async function getActiveSprint(tenantId, teamId) {
    return get(tk(tenantId, 'sprint', 'active', teamId));
}

async function setActiveSprint(tenantId, teamId, sprint) {
    return set(tk(tenantId, 'sprint', 'active', teamId), sprint, TTL.SPRINT);
}

async function invalidateActiveSprint(tenantId, teamId) {
    return del(tk(tenantId, 'sprint', 'active', teamId));
}

// -- Meeting participant cache helpers --

async function getMeetingParticipants(tenantId, meetingId) {
    return get(tk(tenantId, 'meeting', meetingId, 'participants'));
}

async function setMeetingParticipants(tenantId, meetingId, participants) {
    return set(tk(tenantId, 'meeting', meetingId, 'participants'), participants, TTL.MEETING_PARTICIPANTS);
}

async function invalidateMeetingParticipants(tenantId, meetingId) {
    return del(tk(tenantId, 'meeting', meetingId, 'participants'));
}

// -- domain-specific cache helpers --

const KEYS = {
    tokenVersion: (tenantId, userId) => tk(tenantId, 'user', userId, 'tv'),
    userContext: (tenantId, userId) => tk(tenantId, 'user', userId, 'ctx'),
    orgConfig: (tenantId, orgId) => tk(tenantId, 'org', orgId, 'config'),
    userSessions: (tenantId, userId) => tk(tenantId, 'user', userId, 'sessions'),
};

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
        try { await subscriber.quit(); } catch { /* ignore */ }
    }
    if (client) {
        try { await client.quit(); } catch { /* ignore */ }
    }
}

module.exports = {
    initRedis,
    shutdown,
    TTL,
    KEYS,
    get,
    set,
    del,
    delPattern,
    getClient,
    getSubscriber,
    publish,
    // Token version
    getTokenVersion,
    setTokenVersion,
    invalidateTokenVersion,
    // User context
    getUserContext,
    setUserContext,
    invalidateUserContext,
    // Org config
    getOrgConfig,
    setOrgConfig,
    invalidateOrgConfig,
    // Sessions
    getUserSessions,
    setUserSessions,
    invalidateUserSessions,
    // Presence
    setPresence,
    removePresence,
    isOnline,
    getOnlineUsers,
    // User status
    setUserStatus,
    getUserStatus,
    getUserStatuses,
    // Unread counters
    incrUnread,
    resetUnread,
    getUnreadCounts,
    // Search cache
    getSearchCache,
    setSearchCache,
    // Sprint cache
    getActiveSprint,
    setActiveSprint,
    invalidateActiveSprint,
    // Meeting participants
    getMeetingParticipants,
    setMeetingParticipants,
    invalidateMeetingParticipants,
};
