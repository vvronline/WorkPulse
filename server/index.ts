/**
 * AINO server entrypoint.
 *
 * Phase C reduced this file to configuration + delegation. Express composition
 * lives in app.ts; bootstrap/shutdown in bootstrap/; process launchers in
 * roles/. Keep `app` exported here until the existing Supertest suites migrate
 * to importing buildApp() directly.
 */
import { loadEnvironment } from "./bootstrap/env";

// Must run before modules such as db.ts, logger.ts and tenantManager.ts read
// process.env at module-evaluation time.
loadEnvironment(__dirname);

const { validateEnvironment } = require("./bootstrap/env");
const { installCrashHandlers } = require("./bootstrap/crashHandlers");
const { logger } = require("./utils/logger");

validateEnvironment();
installCrashHandlers();

const { bootstrap } = require("./bootstrap/migrations");

const selectedRole = (process.env.ROLE || "all").toLowerCase();
// A direct worker process owns only a tiny probe server; constructing the full
// app would import every route and undermine the role boundary. Tests and all
// HTTP-bearing roles keep the compatibility singleton.
const app = require.main === module && selectedRole === "worker"
    ? undefined
    : require("./app").app;

// Compatibility export: 21 Supertest suites import { app } from index.ts.
export { app };

// Preserve the PaaS/import-wrapper behavior: schema bootstrap starts whenever
// the module is imported outside tests, not only under `require.main`.
if (process.env.NODE_ENV !== "test") {
    bootstrap().catch((err: unknown) => {
        logger.error({ err }, "Bootstrap failed at module load — server may run with stale schema");
    });
}

// Direct invocation starts the current combined process. Phase D introduces
// true ROLE=web/realtime/worker separation; Phase C intentionally preserves
// production behavior.
if (require.main === module) {
    const { runRole } = require("./roles");
    runRole(app).catch((err: unknown) => {
        logger.fatal({ err }, "Server startup failed");
        process.exit(1);
    });
}