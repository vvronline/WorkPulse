/**
 * Background job scheduler using BullMQ (Redis-backed).
 * Falls back to setInterval when Redis is unavailable.
 */
import { logger } from "./utils/logger";
import { forEachTenant, getTenantPool } from "./utils/tenantManager";
import { masterQuery } from "./db";
import { sendToUser, emitCallHistoryMessage } from "./utils/ws";
import { pushNotifications } from "./services/pushNotifications";
import { processChatMediaJob } from "./services/chatMediaPipeline";

type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;
interface TenantDb {
  query: Query;
}

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
let staleCallQueue: any = null;
let sprintLifecycleQueue: any = null;
let chatMediaQueue: any = null;
let workers: any[] = [];
let fallbackIntervals: NodeJS.Timeout[] = [];

// How long an unanswered call may keep `ringing` before the server force-ends
// it as "missed". Mirrors the caller's client-side no-answer timeout (~35s) but
// is the authoritative backstop: it fires even when every client died mid-ring
// (app killed, network dropped), so an abandoned call can never sit ringing
// forever and the callee's ring UI / native push is always dismissed.
const STALE_RINGING_TTL_SECS = 45;
const STALE_CALL_SWEEP_MS = 20 * 1000;
// Hard backstop for ABANDONED answered calls. A normal call ends via the WS
// `call_end` transition; but if every client dies mid-call (app killed, network
// dropped, process crash) the row stays `answered` forever. That stuck row then
// makes BOTH participants look permanently "busy" to the call_initiate busy
// check — silently blocking all future calls + push notifications to them.
// This sweep force-ends answered calls older than the max plausible call
// duration so an abandoned call can never pin a user as busy indefinitely.
const STALE_ANSWERED_TTL_SECS = 12 * 60 * 60; // 12h
// How often the sprint lifecycle scheduler runs. Hourly is plenty — sprint
// windows turn over on day boundaries, so an hourly sweep guarantees a new
// sprint auto-starts within an hour of the previous one ending.
const SPRINT_LIFECYCLE_SWEEP_MS = 60 * 60 * 1000;

interface InitJobsOpts {
  autoClockOut: () => void | Promise<void>;
  cleanupTokens: () => void | Promise<void>;
}

type ChatMediaPipelineJob = {
  tenantId: number;
  tenantDbName: string;
  tenantDbHost?: string | null;
  mediaJobId: number;
  messageId: number;
  conversationId: number;
};

async function runChatMediaPipelineJob(
  job: ChatMediaPipelineJob,
): Promise<void> {
  const pool = await getTenantPool(job.tenantDbName, job.tenantDbHost || null);
  await processChatMediaJob({
    query: pool.query as any,
    tenantId: job.tenantId,
    mediaJobId: job.mediaJobId,
    messageId: job.messageId,
    conversationId: job.conversationId,
  });
}

async function enqueueChatMediaPipelineJob(
  job: ChatMediaPipelineJob,
): Promise<void> {
  if (chatMediaQueue) {
    await chatMediaQueue.add("chat-media-pipeline", job, {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
      jobId: `chat-media:${job.tenantId}:${job.mediaJobId}:${Date.now()}`,
    });
    return;
  }
  await runChatMediaPipelineJob(job);
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
    logger.info(
      { pruned, tenantsOk: result.ok, tenantsFailed: result.failed },
      "Pruned stale Platform Inspector users",
    );
  }
  return pruned;
}

/**
 * Data retention cleanup: purge old audit logs, expired sessions, and
 * permanently remove soft-deleted tenants past the retention window.
 * Reads retention settings from platform config (app_settings).
 */
async function runRetentionCleanup(): Promise<{
  audit_logs: number;
  session_logs: number;
  tenants: number;
}> {
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
 * Ring-timeout + abandoned-call backstop. Two independent sweeps run per tenant:
 *
 *  1. RINGING → MISSED (STALE_RINGING_TTL_SECS): a call left ringing past the
 *     TTL (every client died mid-ring) is force-ended as `missed`. For each we
 *     broadcast `call_ended`, push-cancel the callee's locked/backgrounded
 *     devices, and clear the per-session in_call activity.
 *
 *  2. ANSWERED → ENDED (STALE_ANSWERED_TTL_SECS): a call left `answered` past
 *     the max plausible duration (every client crashed/killed without ever
 *     sending `call_end`) is force-ended as `ended`. This is CRITICAL because a
 *     stuck `answered` row makes BOTH participants look permanently "busy" to
 *     the call_initiate busy check — silently blocking all future calls + push
 *     notifications until the row is cleared. We also clear the in_call activity
 *     for each so presence doesn't show them stuck "in a call".
 *
 * Runs across every tenant. Safe to run frequently — the UPDATEs only touch
 * rows that are actually stale, and are no-ops when there are none.
 */
async function expireStaleRingingCalls(): Promise<number> {
  let expired = 0;
  await forEachTenant(
    async (db: TenantDb, tenant) => {
      const tenantId = tenant.id;
      const rows = (
        await db.query(
          `UPDATE call_logs
                    SET status = 'missed', ended_at = NOW()
                  WHERE status = 'ringing'
                    AND created_at < NOW() - ($1 || ' seconds')::interval
                  RETURNING id, conversation_id, caller_id, call_type`,
          [String(STALE_RINGING_TTL_SECS)],
        )
      ).rows;

      for (const call of rows) {
        expired++;
        const callId = call.id;
        const conversationId = call.conversation_id;

        let participants: { user_id: number }[] = [];
        try {
          participants = (
            await db.query(
              "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
              [conversationId],
            )
          ).rows;
        } catch (err: any) {
          logger.warn(
            { err: err.message, callId },
            "expireStaleRingingCalls: participant lookup failed",
          );
        }

        for (const p of participants) {
          try {
            sendToUser(tenantId, p.user_id, "call_ended", {
              callId,
              conversationId,
              reason: "no_answer",
            });
          } catch {
            /* best-effort */
          }

          // Only the callee(s) had an incoming ring/push to dismiss.
          if (p.user_id !== call.caller_id) {
            pushNotifications
              .sendCallCancellation(db.query as any, p.user_id, tenantId, {
                callId,
                conversationId,
                reason: "cancelled",
              })
              .catch((err: any) =>
                logger.warn(
                  { err: err.message, callId, userId: p.user_id },
                  "expireStaleRingingCalls: push-cancel failed",
                ),
              );
          }
        }

        // Clear in_call activity for every session referencing this call.
        try {
          const statusService = require("./services/status");
          statusService
            .clearActivityForRef({ db, tenantId }, "in_call", callId)
            .catch((err: any) =>
              logger.warn(
                { err: err.message, callId },
                "expireStaleRingingCalls: clearActivityForRef failed",
              ),
            );
        } catch {
          /* status service optional */
        }

        // Inline "missed" call-history row in the chat thread.
        try {
          await emitCallHistoryMessage(
            db,
            tenantId,
            conversationId,
            call.caller_id,
            call.call_type || "voice",
            "missed",
            null,
          );
        } catch {
          /* best-effort */
        }
      }

      // Sweep 2 — abandoned ANSWERED calls. A normal call ends via the WS
      // `call_end` transition; a crashed/killed client never sends it, so
      // the row sticks at `answered` forever and pins both participants as
      // "busy". Force-end past the max-duration TTL and tear down any
      // lingering ring/in_call state, mirroring sweep 1.
      const answeredRows = (
        await db.query(
          `UPDATE call_logs
                    SET status = 'ended', ended_at = NOW(),
                        duration = COALESCE(duration, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
                  WHERE status = 'answered'
                    AND created_at < NOW() - ($1 || ' seconds')::interval
                  RETURNING id, conversation_id, caller_id, call_type, duration`,
          [String(STALE_ANSWERED_TTL_SECS)],
        )
      ).rows;

      for (const call of answeredRows) {
        expired++;
        const callId = call.id;
        const conversationId = call.conversation_id;

        let participants: { user_id: number }[] = [];
        try {
          participants = (
            await db.query(
              "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
              [conversationId],
            )
          ).rows;
        } catch (err: any) {
          logger.warn(
            { err: err.message, callId },
            "expireStaleRingingCalls: answered participant lookup failed",
          );
        }

        for (const p of participants) {
          try {
            sendToUser(tenantId, p.user_id, "call_ended", {
              callId,
              conversationId,
              reason: "abandoned",
            });
          } catch {
            /* best-effort */
          }

          if (p.user_id !== call.caller_id) {
            pushNotifications
              .sendCallCancellation(db.query as any, p.user_id, tenantId, {
                callId,
                conversationId,
                reason: "cancelled",
              })
              .catch((err: any) =>
                logger.warn(
                  { err: err.message, callId, userId: p.user_id },
                  "expireStaleRingingCalls: answered push-cancel failed",
                ),
              );
          }
        }

        try {
          const statusService = require("./services/status");
          statusService
            .clearActivityForRef({ db, tenantId }, "in_call", callId)
            .catch((err: any) =>
              logger.warn(
                { err: err.message, callId },
                "expireStaleRingingCalls: answered clearActivityForRef failed",
              ),
            );
        } catch {
          /* status service optional */
        }

        // Inline "ended" call-history row for the abandoned answered call.
        try {
          await emitCallHistoryMessage(
            db,
            tenantId,
            conversationId,
            call.caller_id,
            call.call_type || "voice",
            "ended",
            call.duration ?? null,
          );
        } catch {
          /* best-effort */
        }
      }
    },
    { label: "expireStaleRingingCalls" },
  );
  if (expired > 0) {
    logger.info({ expired }, "Expired stale ringing/answered calls");
  }
  return expired;
}

/**
 * Sprint lifecycle sweep. For every tenant, drives the auto-managed sprint
 * cadence: auto-creates the current sprint window, auto-starts it, and
 * auto-completes + rolls over the previous one when its window ends. Teams in
 * manual mode or paused are skipped by the scheduler itself. Invalidates the
 * active-sprint Redis cache for any team that transitioned so the board's
 * "Active" label refreshes immediately.
 */
async function runSprintLifecycleSweep(): Promise<number> {
  const { runSprintLifecycle } = require("./services/sprintScheduler");
  const redis = require("./redis");
  let totalTransitions = 0;
  await forEachTenant(
    async (db: TenantDb, tenant) => {
      const { transitions } = await runSprintLifecycle(
        { db, tenantId: tenant.id },
        redis,
      );
      totalTransitions += transitions || 0;
    },
    { label: "sprintLifecycle" },
  );
  if (totalTransitions > 0) {
    logger.info(
      { transitions: totalTransitions },
      "Sprint lifecycle transitions applied",
    );
  }
  return totalTransitions;
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
    fallbackIntervals.push(
      setInterval(
        () =>
          pruneStaleInspectorUsers().catch((err) =>
            logger.error({ err }, "Inspector prune (interval) failed"),
          ),
        24 * 60 * 60 * 1000,
      ),
    );
    fallbackIntervals.push(
      setInterval(
        () =>
          runRetentionCleanup().catch((err) =>
            logger.error({ err }, "Retention cleanup (interval) failed"),
          ),
        24 * 60 * 60 * 1000,
      ),
    );
    fallbackIntervals.push(
      setInterval(
        () =>
          expireStaleRingingCalls().catch((err) =>
            logger.error({ err }, "Stale-call sweep (interval) failed"),
          ),
        STALE_CALL_SWEEP_MS,
      ),
    );
    // Sprint lifecycle: run once on boot then hourly.
    runSprintLifecycleSweep().catch((err) =>
      logger.error({ err }, "Sprint lifecycle (startup) failed"),
    );
    fallbackIntervals.push(
      setInterval(
        () =>
          runSprintLifecycleSweep().catch((err) =>
            logger.error({ err }, "Sprint lifecycle (interval) failed"),
          ),
        SPRINT_LIFECYCLE_SWEEP_MS,
      ),
    );
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
  autoClockOutQueue
    .upsertJobScheduler(
      "auto-clock-out-schedule",
      {
        every: 5 * 60 * 1000, // 5 minutes
      },
      {
        name: "auto-clock-out",
      },
    )
    .catch((err: any) =>
      logger.warn(
        { err: err.message },
        "Failed to set auto-clock-out schedule",
      ),
    );

  const clockOutWorker = new Worker(
    "auto-clock-out",
    async () => {
      await autoClockOut();
    },
    { connection, concurrency: 1 },
  );
  clockOutWorker.on("failed", (job: any, err: any) => {
    logger.error({ err, jobId: job?.id }, "Auto clock-out job failed");
  });
  workers.push(clockOutWorker);

  // Token cleanup: every hour
  tokenCleanupQueue = new Queue("token-cleanup", { connection });
  tokenCleanupQueue
    .upsertJobScheduler(
      "token-cleanup-schedule",
      {
        every: 60 * 60 * 1000, // 1 hour
      },
      {
        name: "token-cleanup",
      },
    )
    .catch((err: any) =>
      logger.warn({ err: err.message }, "Failed to set token-cleanup schedule"),
    );

  const cleanupWorker = new Worker(
    "token-cleanup",
    async () => {
      await cleanupTokens();
    },
    { connection, concurrency: 1 },
  );
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
  inspectorPruneQueue
    .upsertJobScheduler(
      "inspector-prune-schedule",
      {
        every: 24 * 60 * 60 * 1000, // 24 hours
      },
      {
        name: "inspector-prune",
      },
    )
    .catch((err: any) =>
      logger.warn(
        { err: err.message },
        "Failed to set inspector-prune schedule",
      ),
    );

  const inspectorPruneWorker = new Worker(
    "inspector-prune",
    async () => {
      await pruneStaleInspectorUsers();
    },
    { connection, concurrency: 1 },
  );
  inspectorPruneWorker.on("failed", (job: any, err: any) => {
    logger.error({ err, jobId: job?.id }, "Inspector prune job failed");
  });
  workers.push(inspectorPruneWorker);

  // Data retention cleanup: once a day
  retentionCleanupQueue = new Queue("retention-cleanup", { connection });
  retentionCleanupQueue
    .upsertJobScheduler(
      "retention-cleanup-schedule",
      {
        every: 24 * 60 * 60 * 1000,
      },
      {
        name: "retention-cleanup",
      },
    )
    .catch((err: any) =>
      logger.warn(
        { err: err.message },
        "Failed to set retention-cleanup schedule",
      ),
    );

  const retentionWorker = new Worker(
    "retention-cleanup",
    async () => {
      await runRetentionCleanup();
    },
    { connection, concurrency: 1 },
  );
  retentionWorker.on("failed", (job: any, err: any) => {
    logger.error({ err, jobId: job?.id }, "Retention cleanup job failed");
  });
  workers.push(retentionWorker);

  // Stale ringing-call sweep: force-end calls left ringing past the TTL so an
  // abandoned call (every client died mid-ring) can never ring forever.
  staleCallQueue = new Queue("stale-call-sweep", { connection });
  staleCallQueue
    .upsertJobScheduler(
      "stale-call-sweep-schedule",
      {
        every: STALE_CALL_SWEEP_MS,
      },
      {
        name: "stale-call-sweep",
      },
    )
    .catch((err: any) =>
      logger.warn(
        { err: err.message },
        "Failed to set stale-call-sweep schedule",
      ),
    );

  const staleCallWorker = new Worker(
    "stale-call-sweep",
    async () => {
      await expireStaleRingingCalls();
    },
    { connection, concurrency: 1 },
  );
  staleCallWorker.on("failed", (job: any, err: any) => {
    logger.error({ err, jobId: job?.id }, "Stale-call sweep job failed");
  });
  workers.push(staleCallWorker);

  // Sprint lifecycle: hourly auto-create / auto-start / auto-complete +
  // rollover of sprints for teams in auto mode (see services/sprintScheduler).
  sprintLifecycleQueue = new Queue("sprint-lifecycle", { connection });
  sprintLifecycleQueue
    .upsertJobScheduler(
      "sprint-lifecycle-schedule",
      {
        every: SPRINT_LIFECYCLE_SWEEP_MS,
      },
      {
        name: "sprint-lifecycle",
      },
    )
    .catch((err: any) =>
      logger.warn(
        { err: err.message },
        "Failed to set sprint-lifecycle schedule",
      ),
    );

  const sprintLifecycleWorker = new Worker(
    "sprint-lifecycle",
    async () => {
      await runSprintLifecycleSweep();
    },
    { connection, concurrency: 1 },
  );
  sprintLifecycleWorker.on("failed", (job: any, err: any) => {
    logger.error({ err, jobId: job?.id }, "Sprint lifecycle job failed");
  });
  workers.push(sprintLifecycleWorker);

  // Chat media pipeline: staged media processing (prepare/transform/upload/finalize)
  // so long-running work is durable + retryable outside request handlers.
  chatMediaQueue = new Queue("chat-media-pipeline", { connection });
  const chatMediaWorker = new Worker(
    "chat-media-pipeline",
    async (job: { data: ChatMediaPipelineJob }) => {
      await runChatMediaPipelineJob(job.data);
    },
    { connection, concurrency: 2 },
  );
  chatMediaWorker.on("failed", (job: any, err: any) => {
    logger.error({ err, jobId: job?.id }, "Chat media pipeline job failed");
  });
  workers.push(chatMediaWorker);

  // Run auto clock-out immediately on startup
  autoClockOut();
  // Run a sprint lifecycle pass immediately so a fresh boot picks up any
  // window that turned over while the server was down.
  runSprintLifecycleSweep().catch((err) =>
    logger.error({ err }, "Sprint lifecycle (startup) failed"),
  );

  logger.info(
    "BullMQ job queues initialized (auto-clock-out: 5m, token-cleanup: 1h, inspector-prune: 24h, retention-cleanup: 24h, stale-call-sweep: 20s, sprint-lifecycle: 1h)",
  );
}

async function shutdownJobs(): Promise<void> {
  for (const id of fallbackIntervals) clearInterval(id);
  fallbackIntervals = [];
  for (const w of workers) {
    try {
      await w.close();
    } catch {
      /* ignore */
    }
  }
  if (autoClockOutQueue) {
    try {
      await autoClockOutQueue.close();
    } catch {
      /* ignore */
    }
  }
  if (tokenCleanupQueue) {
    try {
      await tokenCleanupQueue.close();
    } catch {
      /* ignore */
    }
  }
  if (inspectorPruneQueue) {
    try {
      await inspectorPruneQueue.close();
    } catch {
      /* ignore */
    }
  }
  if (retentionCleanupQueue) {
    try {
      await retentionCleanupQueue.close();
    } catch {
      /* ignore */
    }
  }
  if (staleCallQueue) {
    try {
      await staleCallQueue.close();
    } catch {
      /* ignore */
    }
  }
  if (sprintLifecycleQueue) {
    try {
      await sprintLifecycleQueue.close();
    } catch {
      /* ignore */
    }
  }
  if (chatMediaQueue) {
    try {
      await chatMediaQueue.close();
    } catch {
      /* ignore */
    }
  }
}

export {
  initJobs,
  shutdownJobs,
  pruneStaleInspectorUsers,
  runRetentionCleanup,
  expireStaleRingingCalls,
  enqueueChatMediaPipelineJob,
};
