/** Background-worker role with liveness/readiness probe server. */
import http from "http";
import express from "express";
import { logger } from "../utils/logger";
import { initJobs, areJobsReady } from "../jobs";
import { autoClockOut, cleanupTokens } from "../services/attendance/autoClockOut";
import { bootstrap } from "../bootstrap/migrations";
import { installShutdownHandlers } from "../bootstrap/shutdown";
import { masterQuery } from "../db";
import * as redis from "../redis";
import {
    mountMetricsEndpoint,
    startTracing,
    startMigrationDriftSampler,
} from "../platform/metrics";

async function runWorkerRole(): Promise<void> {
    startTracing();
    await bootstrap();
    await initJobs({ autoClockOut, cleanupTokens });
    // H5: only the worker samples migration drift. Doing it per web replica
    // would reintroduce the O(tenants) sweep that D4.3 removed from /readyz.
    startMigrationDriftSampler();

    const probe = express();
    probe.get("/healthz", (_req, res) => res.json({ status: "ok", role: "worker" }));
    // H1: the worker owns queue depth and job duration — the two signals the
    // backlog alert fires on — so it must be scrapable even though it serves
    // no application traffic.
    mountMetricsEndpoint(probe);
    probe.get("/readyz", async (_req, res) => {
        try {
            await masterQuery("SELECT 1");
            const ready = areJobsReady() && await redis.ping();
            return res.status(ready ? 200 : 503).json({
                status: ready ? "ready" : "not-ready",
                role: "worker",
                jobs: areJobsReady() ? "ready" : "not-ready",
                redis: redis.isRedisReady() ? "ready" : "not-ready",
            });
        } catch {
            return res.status(503).json({ status: "not-ready", role: "worker" });
        }
    });

    const server = http.createServer(probe);
    const port = Number(process.env.PORT || 5000);
    server.listen(port, () => logger.info({ port, role: "worker" }, "Worker role running"));
    installShutdownHandlers(server, null);
}

export { runWorkerRole };