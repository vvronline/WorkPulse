import type { Express, Response } from "express";
import { logger } from "../utils/logger";
import { masterQuery } from "../db";
import * as redis from "../redis";

/** Register dependency-free liveness and dependency-aware readiness probes. */
function mountHealthRoutes(app: Express): void {
    app.get("/healthz", (_req, res: Response) => {
        res.json({ status: "ok", role: process.env.ROLE || "all", time: new Date().toISOString() });
    });

    app.get("/readyz", async (_req, res: Response) => {
        try {
            await masterQuery("SELECT 1");
            const redisOk = await redis.ping();
            const subscriberOk = redis.isSubscriberReady();
            const role = process.env.ROLE || "all";
            const needsSubscriber = role === "all" || role === "realtime";
            if (!redisOk || (needsSubscriber && !subscriberOk)) {
                return res.status(503).json({
                    status: "not-ready",
                    database: "ok",
                    redis: redisOk ? "ok" : "unavailable",
                    redisSubscriber: subscriberOk ? "ok" : "unavailable",
                    role,
                });
            }
            return res.json({
                status: "ready",
                database: "ok",
                redis: "ok",
                redisSubscriber: "ok",
                role,
            });
        } catch (err: unknown) {
            logger.error({ err }, "Readiness check failed");
            return res.status(503).json({
                status: "not-ready",
                database: "unavailable",
                redis: redis.isRedisReady() ? "ok" : "unavailable",
                role: process.env.ROLE || "all",
            });
        }
    });

    // Backwards-compatible shallow endpoint. The O(tenants) detail sweep moved
    // to the authenticated internal router and is never used as an LB probe.
    app.get("/api/health", async (_req, res: Response) => {
        try {
            await masterQuery("SELECT 1");
            return res.json({ status: "ok", time: new Date().toISOString() });
        } catch (err: unknown) {
            logger.error({ err }, "Health check DB ping failed");
            return res.status(503).json({
                status: "error",
                time: new Date().toISOString(),
                error: "Database unreachable",
            });
        }
    });
}

export { mountHealthRoutes };