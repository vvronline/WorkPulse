/**
 * Internal observability endpoints.
 *
 * Not exposed publicly — these are intended for the platform-admin
 * console + automated health checks. Gated behind the existing
 * `platform_admin` role so a tenant admin can't peek at cross-tenant
 * latency data.
 *
 * Currently exposes:
 *   GET /api/internal/ws-stats — per-message-type WS handler metrics
 *                                (counts, errors, timeouts, p50, p95).
 *
 * Future homes for this router (no schema migration needed):
 *   GET /api/internal/db-pool-stats — per-tenant pg pool saturation
 *   GET /api/internal/redis-stats   — pub/sub fan-out + cache hit rate
 */
import express from "express";
import type { Request, Response } from "express";
import type { DbContext } from "../types/domain";
import { forEachTenant, getPoolStats } from "../utils/tenantManager";
const authMiddleware = require("../middleware/auth");
const { loadUserContext, requireRole } = require("../middleware/rbac");
const wsMetrics = require("../utils/wsMetrics");

const router = express.Router();

// All internal endpoints require an authenticated platform admin.
router.use(authMiddleware, loadUserContext, requireRole("platform_admin"));

/**
 * GET /api/internal/ws-stats
 *
 * Returns the current in-memory snapshot of WS handler stats for this
 * process (NOT a cluster-wide rollup — for that we'd aggregate across
 * the Redis Pub/Sub channel in a follow-up).
 *
 * Response shape:
 *   {
 *     instanceId: string,
 *     handlers: {
 *       [messageType]: { count, errors, timeouts, errorRate, p50Ms, p95Ms }
 *     },
 *     totals:  { count, errors, timeouts, errorRate },
 *     windowSize: number,
 *     capturedAt: ISO-8601
 *   }
 */
router.get("/ws-stats", (_req: Request, res: Response) => {
    const snap = wsMetrics.snapshot();
    res.json({
        instanceId: `${process.pid}`,
        ...snap,
    });
});

/** GET /api/internal/db-pool-stats — pool hit/eviction/waiting signals. */
router.get("/db-pool-stats", (_req: Request, res: Response) => {
    res.json(getPoolStats());
});

/**
 * GET /api/internal/migration-status
 *
 * O(tenants) diagnostic intentionally kept away from /readyz. Platform admins
 * can use it after deploys without making the load-balancer probe every DB.
 */
router.get("/migration-status", async (_req: Request, res: Response) => {
    const { expectedMigrationCount } = require("../utils/migrationRunner");
    const tenants: Record<string, number> = {};
    let minApplied = Infinity;
    const sweep = await forEachTenant(async (db: DbContext, tenant: any) => {
        const r = await db.query("SELECT COUNT(*)::int AS count FROM _migrations");
        const count = r.rows[0]?.count || 0;
        tenants[tenant.slug || tenant.db_name] = count;
        if (count < minApplied) minApplied = count;
    }, { label: "migration-status", includeLegacyMaster: true });
    if (minApplied === Infinity) minApplied = 0;
    const ok = sweep.failed === 0 && (sweep.ok === 0 || minApplied >= expectedMigrationCount);
    res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "degraded",
        expected: expectedMigrationCount,
        minApplied,
        tenants,
        unreachableTenants: sweep.failed,
    });
});

export = router;