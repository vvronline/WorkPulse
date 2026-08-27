/**
 * Combined process role — preserves the pre-Phase-C deployment behavior.
 *
 * Backwards-compatible all-in-one role. Phase D added independent web,
 * realtime and worker roles; keep ROLE=all until Railway staging proves the
 * split, then retain this as a local-dev and rollback option.
 */
import http from "http";
import type { Express } from "express";
import { logger } from "../utils/logger";
import { setupWebSocket } from "../utils/ws";
import { createCollaborationServer } from "../utils/collaboration";
import { initJobs } from "../jobs";
import { autoClockOut, cleanupTokens } from "../services/attendance/autoClockOut";
import { bootstrap } from "../bootstrap/migrations";
import { installShutdownHandlers } from "../bootstrap/shutdown";
import {
    setWebSocketServer,
    startTracing,
    startMigrationDriftSampler,
} from "../platform/metrics";

async function runAllRole(app: Express): Promise<void> {
    startTracing();
    await bootstrap();

    const httpServer = http.createServer(app);
    const wss = await setupWebSocket(httpServer);
    setWebSocketServer(wss);
    await createCollaborationServer(httpServer);

    const port = process.env.PORT || 5000;
    httpServer.listen(port, () => {
        logger.info({ port }, "Server running");
    });

    await initJobs({ autoClockOut, cleanupTokens });
    // ROLE=all owns the worker responsibilities too, including drift sampling.
    startMigrationDriftSampler();
    installShutdownHandlers(httpServer, wss);
}

export { runAllRole };