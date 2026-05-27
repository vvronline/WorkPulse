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
const express = require('express');
const authMiddleware = require('../middleware/auth');
const { loadUserContext, requireRole } = require('../middleware/rbac');
const wsMetrics = require('../utils/wsMetrics');

const router = express.Router();

// All internal endpoints require an authenticated platform admin.
router.use(authMiddleware, loadUserContext, requireRole('platform_admin'));

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
router.get('/ws-stats', (_req, res) => {
    const snap = wsMetrics.snapshot();
    res.json({
        instanceId: `${process.pid}`,
        ...snap,
    });
});

module.exports = router;