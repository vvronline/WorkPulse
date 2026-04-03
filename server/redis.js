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
        const keys = await client.keys(pattern);
        if (keys.length > 0) await client.del(...keys);
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

// -- Presence helpers --

async function setPresence(userId, ttlSeconds) {
    if (!isReady) return;
    try {
        await client.set(`presence:${userId}`, '1', 'EX', ttlSeconds || TTL.PRESENCE);
    } catch { /* ignore */ }
}

async function removePresence(userId) {
    if (!isReady) return;
    try { await client.del(`presence:${userId}`); } catch { /* ignore */ }
}

async function isOnline(userId) {
    if (!isReady) return null;
    try {
        return !!(await client.exists(`presence:${userId}`));
    } catch { return null; }
}

async function getOnlineUsers(userIds) {
    if (!isReady || !userIds.length) return null;
    try {
        const pipeline = client.pipeline();
        for (const id of userIds) pipeline.exists(`presence:${id}`);
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < userIds.length; i++) {
            map[userIds[i]] = results[i][1] === 1 ? 'online' : 'offline';
        }
        return map;
    } catch { return null; }
}

// -- Unread counter helpers --

async function incrUnread(userId, conversationId) {
    if (!isReady) return;
    try {
        await client.incr(`unread:${userId}:${conversationId}`);
    } catch { /* ignore */ }
}

async function resetUnread(userId, conversationId) {
    if (!isReady) return;
    try {
        await client.del(`unread:${userId}:${conversationId}`);
    } catch { /* ignore */ }
}

async function getUnreadCounts(userId, conversationIds) {
    if (!isReady || !conversationIds.length) return null;
    try {
        const pipeline = client.pipeline();
        for (const cid of conversationIds) pipeline.get(`unread:${userId}:${cid}`);
        const results = await pipeline.exec();
        const map = {};
        for (let i = 0; i < conversationIds.length; i++) {
            map[conversationIds[i]] = parseInt(results[i][1], 10) || 0;
        }
        return map;
    } catch { return null; }
}

// -- Search cache helpers --

function searchKey(userId, queryStr) {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(queryStr).digest('hex');
    return `search:${userId}:${hash}`;
}

async function getSearchCache(userId, queryStr) {
    return get(searchKey(userId, queryStr));
}

async function setSearchCache(userId, queryStr, results) {
    return set(searchKey(userId, queryStr), results, TTL.SEARCH);
}

// -- Sprint cache helpers --

async function getActiveSprint(teamId) {
    return get(`sprint:active:${teamId}`);
}

async function setActiveSprint(teamId, sprint) {
    return set(`sprint:active:${teamId}`, sprint, TTL.SPRINT);
}

async function invalidateActiveSprint(teamId) {
    return del(`sprint:active:${teamId}`);
}

// -- Meeting participant cache helpers --

async function getMeetingParticipants(meetingId) {
    return get(`meeting:${meetingId}:participants`);
}

async function setMeetingParticipants(meetingId, participants) {
    return set(`meeting:${meetingId}:participants`, participants, TTL.MEETING_PARTICIPANTS);
}

async function invalidateMeetingParticipants(meetingId) {
    return del(`meeting:${meetingId}:participants`);
}

// -- domain-specific cache helpers --

const KEYS = {
    tokenVersion: (userId) => `user:${userId}:tv`,
    userContext: (userId) => `user:${userId}:ctx`,
    orgConfig: (orgId) => `org:${orgId}:config`,
};

async function getTokenVersion(userId) {
    return get(KEYS.tokenVersion(userId));
}

async function setTokenVersion(userId, version) {
    return set(KEYS.tokenVersion(userId), version, TTL.TOKEN_VERSION);
}

async function invalidateTokenVersion(userId) {
    return del(KEYS.tokenVersion(userId));
}

async function getUserContext(userId) {
    return get(KEYS.userContext(userId));
}

async function setUserContext(userId, context) {
    return set(KEYS.userContext(userId), context, TTL.USER_CONTEXT);
}

async function invalidateUserContext(userId) {
    return del(KEYS.userContext(userId));
}

async function getOrgConfig(orgId) {
    return get(KEYS.orgConfig(orgId));
}

async function setOrgConfig(orgId, config) {
    return set(KEYS.orgConfig(orgId), config, TTL.ORG_CONFIG);
}

async function invalidateOrgConfig(orgId) {
    return del(KEYS.orgConfig(orgId));
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
    // Presence
    setPresence,
    removePresence,
    isOnline,
    getOnlineUsers,
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
