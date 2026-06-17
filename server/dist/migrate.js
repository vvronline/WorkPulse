#!/usr/bin/env node
/**
 * Standalone migration runner for production deployments.
 *
 * Runs all pending tenant migrations, retrying the DB connection with
 * exponential backoff so Railway cold-starts don't cause silent failures.
 *
 * Exit codes:
 *   0 — all migrations applied successfully
 *   1 — fatal failure after retries exhausted
 *
 * Usage:
 *   node migrate.js            # run and exit
 *   npm run migrate            # via package.json script
 */
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const envPath = path_1.default.join(__dirname, ".env");
if (fs_1.default.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
}
else {
    require("dotenv").config();
}
const pg_1 = require("pg");
const logger_1 = require("./utils/logger");
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
async function waitForDatabase() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error("DATABASE_URL is not set — cannot run migrations");
    }
    const pool = new pg_1.Pool({
        connectionString: url,
        ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
        max: 2,
        connectionTimeoutMillis: 5000,
    });
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const client = await pool.connect();
            await client.query("SELECT 1");
            client.release();
            await pool.end();
            logger_1.logger.info({ attempt }, "Database is ready");
            return;
        }
        catch (err) {
            const message = err.message;
            const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 10000);
            logger_1.logger.warn({ attempt, maxRetries: MAX_RETRIES, nextRetryMs: delay, err: message }, "Database not ready — retrying");
            if (attempt === MAX_RETRIES) {
                await pool.end().catch(() => { });
                throw new Error(`Database not reachable after ${MAX_RETRIES} attempts: ${message}`);
            }
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}
async function main() {
    logger_1.logger.info("migrate.js: waiting for database readiness...");
    await waitForDatabase();
    logger_1.logger.info("migrate.js: initializing master schema...");
    const { initDB } = require("./db");
    await initDB();
    logger_1.logger.info("migrate.js: running tenant migrations...");
    const { sweepAllTenants } = require("./utils/migrationRunner");
    const result = await sweepAllTenants();
    logger_1.logger.info({ result }, "migrate.js: all migrations complete");
}
main()
    .then(() => {
    logger_1.logger.info("migrate.js: success — exiting");
    process.exit(0);
})
    .catch((err) => {
    logger_1.logger.error({ err: err.message, stack: err.stack }, "migrate.js: FATAL — migrations failed");
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map