/**
 * HTTP-only role scaffold.
 *
 * Phase C establishes the process boundary. Phase D enables it in production
 * after Redis-backed signal state, mandatory Redis, and readiness probes land.
 */
import http from "http";
import type { Express } from "express";
import { logger } from "../utils/logger";
import { bootstrap } from "../bootstrap/migrations";
import { installShutdownHandlers } from "../bootstrap/shutdown";
import { startTracing } from "../platform/metrics";

async function runWebRole(app: Express): Promise<void> {
    startTracing();
    await bootstrap();
    const server = http.createServer(app);
    const port = process.env.PORT || 5000;
    server.listen(port, () => logger.info({ port, role: "web" }, "Web role running"));
    installShutdownHandlers(server, null);
}

export { runWebRole };