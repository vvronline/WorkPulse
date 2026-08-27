import type { Server } from "http";
import type { WebSocketServer } from "ws";
import { logger } from "../utils/logger";
import { pool } from "../db";
import * as redis from "../redis";
import { destroyAllPools } from "../utils/tenantManager";
import { shutdownJobs } from "../jobs";
import { stopTracing, stopMigrationDriftSampler } from "../platform/metrics";

/** Install idempotent SIGTERM/SIGINT handling for the combined process. */
function installShutdownHandlers(httpServer: Server, wss?: WebSocketServer | null): void {
    let shuttingDown = false;

    async function cleanupResources(): Promise<void> {
        stopMigrationDriftSampler();
        await shutdownJobs();
        // Flush buffered spans before the exporter's transport is torn down;
        // otherwise the trace of the request that triggered a restart is lost.
        await stopTracing();
        await redis.shutdown();
        await destroyAllPools();
        await pool.end();
    }

    async function shutdown(): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("Shutting down gracefully...");

        // Long-lived WS connections hold close() open indefinitely.
        try { wss?.clients?.forEach((client) => client.terminate()); } catch { /* best-effort */ }
        try { httpServer.closeIdleConnections?.(); } catch { /* Node <18.2 */ }

        const forceExit = setTimeout(async () => {
            logger.warn("Graceful shutdown timed out — forcing exit");
            try { await cleanupResources(); } catch { /* best-effort */ }
            process.exit(0);
        }, 5000);

        httpServer.close(async () => {
            clearTimeout(forceExit);
            try { await cleanupResources(); } catch (err) {
                logger.error({ err }, "Cleanup during shutdown failed");
            }
            process.exit(0);
        });
    }

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

export { installShutdownHandlers };