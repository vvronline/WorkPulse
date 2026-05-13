/**
 * Background job scheduler using BullMQ (Redis-backed).
 * Falls back to setInterval when Redis is unavailable.
 */
const { logger } = require('./utils/logger');

let Queue, Worker;
try {
    ({ Queue, Worker } = require('bullmq'));
} catch {
    // BullMQ not available — will use fallback
}

let autoClockOutQueue = null;
let tokenCleanupQueue = null;
let workers = [];
let fallbackIntervals = [];

/**
 * Initialize job queues. Must be called after Redis is connected.
 * @param {Object} opts
 * @param {Function} opts.autoClockOut - The auto clock-out function
 * @param {Function} opts.cleanupTokens - The token cleanup function
 */
function initJobs({ autoClockOut, cleanupTokens }) {
    const redis = require('./redis');
    const redisClient = redis.getClient();

    if (!Queue || !redisClient) {
        // Fallback: use setInterval (single-instance mode)
        logger.info('BullMQ unavailable — using setInterval for background jobs');
        autoClockOut();
        fallbackIntervals.push(setInterval(autoClockOut, 5 * 60 * 1000));
        fallbackIntervals.push(setInterval(cleanupTokens, 60 * 60 * 1000));
        return;
    }

    // BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection
    // it uses for blocking BRPOPLPUSH/XREAD commands; otherwise workers throw
    // "Connection terminated" warnings. We do NOT reuse the shared cache
    // client (which is configured with maxRetriesPerRequest: 1 for fast cache
    // failover) — instead BullMQ will instantiate its own connection from the
    // options below.
    const connection = {
        host: redisClient.options.host || 'localhost',
        port: redisClient.options.port || 6379,
        password: redisClient.options.password || undefined,
        db: redisClient.options.db || 0,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };

    // Auto clock-out: every 5 minutes
    autoClockOutQueue = new Queue('auto-clock-out', { connection });
    autoClockOutQueue.upsertJobScheduler('auto-clock-out-schedule', {
        every: 5 * 60 * 1000, // 5 minutes
    }, {
        name: 'auto-clock-out',
    }).catch((err) => logger.warn({ err: err.message }, 'Failed to set auto-clock-out schedule'));

    const clockOutWorker = new Worker('auto-clock-out', async () => {
        await autoClockOut();
    }, { connection, concurrency: 1 });
    clockOutWorker.on('failed', (job, err) => {
        logger.error({ err, jobId: job?.id }, 'Auto clock-out job failed');
    });
    workers.push(clockOutWorker);

    // Token cleanup: every hour
    tokenCleanupQueue = new Queue('token-cleanup', { connection });
    tokenCleanupQueue.upsertJobScheduler('token-cleanup-schedule', {
        every: 60 * 60 * 1000, // 1 hour
    }, {
        name: 'token-cleanup',
    }).catch((err) => logger.warn({ err: err.message }, 'Failed to set token-cleanup schedule'));

    const cleanupWorker = new Worker('token-cleanup', async () => {
        await cleanupTokens();
    }, { connection, concurrency: 1 });
    cleanupWorker.on('failed', (job, err) => {
        logger.error({ err, jobId: job?.id }, 'Token cleanup job failed');
    });
    workers.push(cleanupWorker);

    // Run auto clock-out immediately on startup
    autoClockOut();

    logger.info('BullMQ job queues initialized (auto-clock-out: 5m, token-cleanup: 1h)');
}

async function shutdownJobs() {
    for (const id of fallbackIntervals) clearInterval(id);
    fallbackIntervals = [];
    for (const w of workers) {
        try { await w.close(); } catch { /* ignore */ }
    }
    if (autoClockOutQueue) {
        try { await autoClockOutQueue.close(); } catch { /* ignore */ }
    }
    if (tokenCleanupQueue) {
        try { await tokenCleanupQueue.close(); } catch { /* ignore */ }
    }
}

module.exports = { initJobs, shutdownJobs };
