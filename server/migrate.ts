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

import path from "path";
import fs from "fs";

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
} else {
    require("dotenv").config();
}

// Phase E: application traffic may use PgBouncer transaction pooling, while
// schema administration should use a direct Postgres connection. Override
// before db.ts is lazily required below, so every migration helper binds to the
// direct URL. In existing deployments the variable is absent and behavior is
// unchanged.
if (process.env.DIRECT_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
}

import { Pool } from "pg";
import { logger } from "./utils/logger";

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;

function assertNoMigrationFailures(
    label: string,
    failed: number | string[],
): void {
    const count = Array.isArray(failed) ? failed.length : failed;
    if (count > 0) {
        const detail = Array.isArray(failed) ? failed.join(", ") : `${failed} failure(s)`;
        throw new Error(`${label} failed: ${detail}`);
    }
}

async function waitForDatabase(): Promise<void> {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error("DATABASE_URL is not set — cannot run migrations");
    }

    const pool = new Pool({
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
            logger.info({ attempt }, "Database is ready");
            return;
        } catch (err: unknown) {
            const message = (err as Error).message;
            const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 10000);
            logger.warn(
                { attempt, maxRetries: MAX_RETRIES, nextRetryMs: delay, err: message },
                "Database not ready — retrying",
            );
            if (attempt === MAX_RETRIES) {
                await pool.end().catch(() => {});
                throw new Error(`Database not reachable after ${MAX_RETRIES} attempts: ${message}`);
            }
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

async function main(): Promise<void> {
    logger.info("migrate.js: waiting for database readiness...");
    await waitForDatabase();

    logger.info("migrate.js: initializing master schema...");
    const { initDB, initTenantSchema } = require("./db");
    await initDB();

    // A4: master-database migrations (shards registry, tenants.shard_id,
    // tenants.storage_bucket). Must run BEFORE any tenant work so
    // createTenant() can place new tenants on a shard.
    logger.info("migrate.js: running master migrations...");
    const { runMasterMigrations } = require("./utils/migrationRunner");
    const masterResult = await runMasterMigrations();
    logger.info({ masterResult }, "migrate.js: master migrations complete");
    if (masterResult.failed.length > 0) {
        logger.error(
            { failed: masterResult.failed },
            "migrate.js: master migrations FAILED — platform schema may be incomplete",
        );
        assertNoMigrationFailures("Master migrations", masterResult.failed);
    }

    // CRITICAL: ensure every tenant DB has the FULL base schema before the
    // migration sweep runs. `sweepAllTenants()` applies only the `.sql` files
    // in platform/db/migrations — it does NOT (re)run initTenantSchema().
    // Any tenant DB that was never fully bootstrapped (or whose bootstrap
    // aborted) would therefore be missing base tables like `tenant_roles`.
    // initTenantSchema() is fully idempotent (every statement is
    // CREATE TABLE / ADD COLUMN IF NOT EXISTS), so running it on every deploy
    // is safe and self-healing.
    //
    // NOTE (A2 squash, 2026-08): initTenantSchema() is deliberately NOT the
    // complete schema. 26 objects — `device_tokens` (push), `webauthn_credentials`
    // + `device_credentials` (biometric), the `users.mfa_*` columns (2FA),
    // `sprint_burndown_snapshots`, `sprint_retro_votes`,
    // `tasks.cycle_started_at` / `lead_started_at`, and 3 perf indexes — are
    // created by 0002_migration_catchup.sql in the sweep below. Both steps are
    // required; see scripts/analyze-migration-coverage.mjs for the proof.
    logger.info("migrate.js: ensuring base tenant schema for all tenants...");
    const { forEachTenant } = require("./utils/tenantManager");
    const schemaTotals = { ok: 0, failed: 0 };
    await forEachTenant(
        async (db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, tenant: { slug?: string; db_name?: string }) => {
            try {
                await initTenantSchema(db.query);
                schemaTotals.ok++;
            } catch (err: unknown) {
                schemaTotals.failed++;
                logger.error(
                    { err: (err as Error).message, tenant: tenant.slug || tenant.db_name },
                    "migrate.js: initTenantSchema failed for tenant",
                );
            }
        },
        { label: "tenant-schema-bootstrap" },
    );
    logger.info({ schemaTotals }, "migrate.js: base tenant schema ensured");
    if (schemaTotals.failed > 0) {
        assertNoMigrationFailures("Base tenant schema", schemaTotals.failed);
    }

    logger.info("migrate.js: running tenant migrations...");
    const { sweepAllTenants } = require("./utils/migrationRunner");
    const result = await sweepAllTenants();
    logger.info({ result }, "migrate.js: all migrations complete");
    if (result?.failed > 0) {
        logger.error({ failed: result.failed }, "migrate.js: one or more tenant migrations FAILED — see per-migration errors above");
        assertNoMigrationFailures("Tenant migrations", result.failed);
    }

    // Historical platform-admin cleanup is a deploy-time data migration, not a
    // runtime-role responsibility. The helper is idempotent.
    const { scrubPlatformAdminsFromCustomerTenants } = require("./utils/migrationRunner");
    await scrubPlatformAdminsFromCustomerTenants();
}

if (require.main === module) main()
    .then(() => {
        logger.info("migrate.js: success — exiting");
        process.exit(0);
    })
    .catch((err: unknown) => {
        logger.error({ err: (err as Error).message, stack: (err as Error).stack }, "migrate.js: FATAL — migrations failed");
        process.exit(1);
    });

export { main, waitForDatabase, assertNoMigrationFailures };