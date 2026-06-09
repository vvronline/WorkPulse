/**
 * Background job scheduler using BullMQ (Redis-backed).
 * Falls back to setInterval when Redis is unavailable.
 */
import { logger } from "./utils/logger";
import { forEachTenant } from "./utils/tenantManager";
import { masterQuery } from "./db";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
interface TenantDb { query: Query; }

let Queue: any, Worker: any;
try {
    ({ Queue, Worker } = require("bullmq"));
} catch {
    // BullMQ not available — will use fallback
}

let autoClockOutQueue: any = null;
let tokenCleanupQueue: any = null;
let inspectorPruneQueue: any = null;
let retentionCleanupQueue: any = null;
let workers: any[] = [];
let fallbackIntervals: NodeJS.Timeout[] = [];

interface InitJobsOpts {
    autoClockOut: () => void | Promise<void>;
    cleanupTokens: () => void | Promise<void>;
}

/**
 * Daily housekeeping: remove synthetic Platform Inspector `users` rows that
 * have not produced any audit_logs in the last 30 days.
 *
 * Background: each (tenant, platform_admin) pair gets a dedicated synthetic
 * users row the first time a platform admin enters the tenant
 * (see `utils/impersonationApproval.getOrCreateInspectorUser`). The row is
 * hidden from every directory query (`hidden_from_directory = TRUE`) and
 * only exists so that actions during the support session have a real
 * `users.id` FK to attach to.
 *
 * Once the audit window has elapsed and the inspector has not been back,
 * the row is dead weight. Pruning is safe because:
 *   - `audit_logs.actor_id` keeps `actor_username` snapshotted at write time
 *     and the FK to `users` is `ON DELETE SET NULL`, so historical logs are
 *     not disturbed.
 *   - A future support session will simply recreate the row on demand.
 */
async function pruneStaleInspectorUsers(): Promise<number> {
    let pruned = 0;
    const result = await forEachTenant(
        async (db: TenantDb) => {
            const r = await db.query(`
                DELETE FROM users
                 WHERE hidden_from_directory = TRUE
                   AND username LIKE 'platform_inspector_%'
                   AND NOT EXISTS (
                       SELECT 1 FROM audit_logs a
                        WHERE a.actor_id = users.id
                          AND a.created_at > NOW() - INTERVAL '30 days'
                   )
            `);
            pruned += r.rowCount || 0;
        },
        { label: "pruneStaleInspectorUsers" },
    );
    if (pruned > 0) {
        logger.info({ pruned, tenantsOk: result.ok, tenantsFailed: result.failed },
            "Pruned stale Platform Inspector users");
    }
    return pruned;
}

/**
 * Data retention cleanup: purge old audit logs, expired sessions, and
 * permanently remove soft-deleted tenants past the retention window.
 * Reads retention settings from platform config (app_settings).
 */
async function runRetentionCleanup(): Promise<{ audit_logs: number; session_logs: number; tenants: number }> {
    const { getRetentionPolicy } = require("./utils/platformConfig");
    const policy = await getRetentionPolicy();
    const stats = { audit_logs: 0, session_logs: 0, tenants: 0 };

    // Purge old platform audit logs
    if (policy.auditLogRetentionDays > 0) {
        const r = await masterQuery(
            `DELETE FROM platform_audit_logs WHERE created_at < NOW() - ($1 || ' days')::interval`,
            [String(policy.auditLogRetentionDays)],
        );
        stats.audit_logs = r.rowCount || 0;
    }

    // Purge old impersonation session requests
    if (policy.sessionLogRetentionDays > 0) {
        const r = await masterQuery(
            `DELETE FROM tenant_access_requests
             WHERE status IN ('expired', 'consumed', 'denied', 'cancelled', 'revoked')
               AND created_at < NOW() - ($1 || ' days')::interval`,
            [String(policy.sessionLogRetentionDays)],
        );
        stats.session_logs = r.rowCount || 0;
    }

    // Hard-delete soft-deleted tenants past retention window
    if (policy.deletedTenantCleanupDays > 0) {
        const r = await masterQuery(
            `DELETE FROM tenants
             WHERE status = 'deleted'
               AND updated_at < NOW() - ($1 || ' days')::interval`,
            [String(policy.deletedTenantCleanupDays)],
        );
        stats.tenants = r.rowCount || 0;
    }

    // Purge per-tenant audit logs
    if (policy.auditLogRetentionDays > 0) {
        await forEachTenant(
            async (db: TenantDb) => {
                await db.query(
                    `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || ' days')::interval`,
                    [String(policy.auditLogRetentionDays)],
                );
            },
            { label: "retentionCleanup" },
        );
    }

    const total = stats.audit_logs + stats.session_logs + stats.tenants;
    if (total > 0) {
        logger.info(stats, "Data retention cleanup completed");
    }
    return stats;
}

/**
 * Initialize job queues. Must be called after Redis is connected.
 */
function initJobs({ autoClockOut, cleanupTokens }: InitJobsOpts): void {
    const redis = require("./redis");
    const redisClient = redis.getClient();

    if (!Queue || !redisClient) {
        // Fallback: use setInterval (single-instance mode)
        logger.info("BullMQ unavailable — using setInterval for background jobs");
        autoClockOut();
        fallbackIntervals.push(setInterval(autoClockOut, 5 * 60 * 1000));
        fallbackIntervals.push(setInterval(cleanupTokens, 60 * 60 * 1000));
        fallbackIntervals.push(setInterval(
            () => pruneStaleInspectorUsers().catch((err) =>
                logger.error({ err }, "Inspector prune (interval) failed")),
            24 * 60 * 60 * 1000,
        ));
        fallbackIntervals.push(setInterval(
            () => runRetentionCleanup().catch((err) =>
                logger.error({ err }, "Retention cleanup (interval) failed")),
            24 * 60 * 60 * 1000,
        ));
        return;
    }

    // BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection
    // it uses for blocking BRPOPLPUSH/XREAD commands; otherwise workers throw
    // "Connection terminated" warnings. We do NOT reuse the shared cache
    // client (which is configured with maxRetriesPerRequest: 1 for fast cache
    // failover) — instead BullMQ will instantiate its own connection from the
    // options below.
    const connection = {
        host: redisClient.options.host || "localhost",
        port: redisClient.options.port || 6379,
        password: redisClient.options.password || undefined,
        db: redisClient.options.db || 0,
        // Inherit dual-stack DNS resolution from the cache client. Railway's
        // private host (*.railway.internal) is IPv6-only, so without family: 0
        // BullMQ's own ioredis connections default to IPv4 and loop forever on
        // connect ETIMEDOUT.
        family: redisClient.options.family ?? 0,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };

    // Auto clock-out: every 5 minutes
    autoClockOutQueue = new Queue("auto-clock-out", { connection });
    autoClockOutQueue.upsertJobScheduler("auto-clock-out-schedule", {
        every: 5 * 60 * 1000, // 5 minutes
    }, {
        name: "auto-clock-out",
    }).catch((err: any) => logger.warn({ err: err.message }, "Failed to set auto-clock-out schedule"));

    const clockOutWorker = new Worker("auto-clock-out", async () => {
        await autoClockOut();
    }, { connection, concurrency: 1 });
    clockOutWorker.on("failed", (job: any, err: any) => {
        logger.error({ err, jobId: job?.id }, "Auto clock-out job failed");
    });
    workers.push(clockOutWorker);

    // Token cleanup: every hour
    tokenCleanupQueue = new Queue("token-cleanup", { connection });
    tokenCleanupQueue.upsertJobScheduler("token-cleanup-schedule", {
        every: 60 * 60 * 1000, // 1 hour
    }, {
        name: "token-cleanup",
    }).catch((err: any) => logger.warn({ err: err.message }, "Failed to set token-cleanup schedule"));

    const cleanupWorker = new Worker("token-cleanup", async () => {
        await cleanupTokens();
    }, { connection, concurrency: 1 });
    cleanupWorker.on("failed", (job: any, err: any) => {
        logger.error({ err, jobId: job?.id }, "Token cleanup job failed");
    });
    workers.push(cleanupWorker);

    // Stale inspector prune: once a day. Synthetic Platform Inspector rows
    // accumulate over time — one per (tenant, platform_admin) pair — and
    // this nightly sweep removes any whose audit-log activity has gone cold
    // (no writes in the last 30 days). Cheap and safe; see
    // `pruneStaleInspectorUsers` for the rationale.
    inspectorPruneQueue = new Queue("inspector-prune", { connection });
    inspectorPruneQueue.upsertJobScheduler("inspector-prune-schedule", {
        every: 24 * 60 * 60 * 1000, // 24 hours
    }, {
        name: "inspector-prune",
    }).catch((err: any) => logger.warn({ err: err.message }, "Failed to set inspector-prune schedule"));

    const inspectorPruneWorker = new Worker("inspector-prune", async () => {
        await pruneStaleInspectorUsers();
    }, { connection, concurrency: 1 });
    inspectorPruneWorker.on("failed", (job: any, err: any) => {
        logger.error({ err, jobId: job?.id }, "Inspector prune job failed");
    });
    workers.push(inspectorPruneWorker);

    // Data retention cleanup: once a day
    retentionCleanupQueue = new Queue("retention-cleanup", { connection });
    retentionCleanupQueue.upsertJobScheduler("retention-cleanup-schedule", {
        every: 24 * 60 * 60 * 1000,
    }, {
        name: "retention-cleanup",
    }).catch((err: any) => logger.warn({ err: err.message }, "Failed to set retention-cleanup schedule"));

    const retentionWorker = new Worker("retention-cleanup", async () => {
        await runRetentionCleanup();
    }, { connection, concurrency: 1 });
    retentionWorker.on("failed", (job: any, err: any) => {
        logger.error({ err, jobId: job?.id }, "Retention cleanup job failed");
    });
    workers.push(retentionWorker);

    // Run auto clock-out immediately on startup
    autoClockOut();

    logger.info("BullMQ job queues initialized (auto-clock-out: 5m, token-cleanup: 1h, inspector-prune: 24h, retention-cleanup: 24h)");
}

async function shutdownJobs(): Promise<void> {
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
    if (inspectorPruneQueue) {
        try { await inspectorPruneQueue.close(); } catch { /* ignore */ }
    }
    if (retentionCleanupQueue) {
        try { await retentionCleanupQueue.close(); } catch { /* ignore */ }
    }
}

export { initJobs, shutdownJobs, pruneStaleInspectorUsers, runRetentionCleanup };