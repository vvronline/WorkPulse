/**
 * Realtime role scaffold: HTTP upgrade endpoints + WebSocket/collaboration.
 * Phase D enables this after in-process signal buffers move to Redis.
 */
import http from "http";
import type { Express } from "express";
import { logger } from "../utils/logger";
import { setupWebSocket } from "../utils/ws";
import { createCollaborationServer } from "../utils/collaboration";
import { bootstrap } from "../bootstrap/migrations";
import { installShutdownHandlers } from "../bootstrap/shutdown";
import { setWebSocketServer, startTracing } from "../platform/metrics";

async function runRealtimeRole(app: Express): Promise<void> {
    startTracing();
    await bootstrap();
    const server = http.createServer(app);
    const wss = await setupWebSocket(server);
    // H2: connections-per-pod is the realtime scaling signal (cap ~5k).
    setWebSocketServer(wss);
    await createCollaborationServer(server);
    const port = process.env.PORT || 5000;
    server.listen(port, () => logger.info({ port, role: "realtime" }, "Realtime role running"));
    installShutdownHandlers(server, wss);
}

export { runRealtimeRole };