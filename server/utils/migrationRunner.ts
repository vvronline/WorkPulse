/**
 * Versioned migration runner for AINO.
 *
 * ── HOW MIGRATIONS WORK NOW (post-squash, 2026-08) ──────────────────────────
 *
 * Migrations are plain `.sql` files in `server/platform/db/migrations/`, applied
 * in filename order and tracked per-database in the `_migrations` table.
 *
 *     0002_migration_catchup.sql   <- the flattened former MIGRATIONS[] array
 *     0003_*.sql                   <- add new migrations here
 *
 * To add a migration: drop a new numbered `.sql` file in that directory. No
 * TypeScript changes required.
 *
 * ── WHY THE SQUASH ──────────────────────────────────────────────────────────
 *
 * This file used to hold a 1,400-line `MIGRATIONS[]` array of 30 `{name, up()}`
 * objects. `scripts/analyze-migration-coverage.mjs` proved that 26 DDL objects
 * were created ONLY by that array and never by `initTenantSchema()` (db.ts) —
 * including `device_tokens` (push), `webauthn_credentials` + `device_credentials`
 * (biometric login), the `users.mfa_*` columns (2FA), `sprint_burndown_snapshots`,
 * `sprint_retro_votes`, `tasks.cycle_started_at` / `lead_started_at`, and three
 * performance indexes.
 *
 * That meant a NEWLY created tenant got an incomplete schema and only received
 * those objects later, whenever a sweep happened to run — a latent bug. Flattening
 * to SQL files closes the gap and removes the whole drift class.
 *
 * ── SCHEMA LAYERS ───────────────────────────────────────────────────────────
 *
 *   1. `initTenantSchema()` (db.ts)  — base schema, idempotent
 *   2. `.sql` files here             — everything layered on top
 *
 * Usage:
 *   const { runTenantMigrations, sweepAllTenants } = require('./migrationRunner');
 *   await runTenantMigrations(db.query);   // one tenant DB
 *   await sweepAllTenants();               // startup: every active tenant
 */
import fs from "fs";
import path from "path";
import { logger } from "./logger";
import type { QueryFn, TransactionFn } from "../types/domain";

/**
 * Directory holding the `.sql` migration files.
 *
 * Resolved relative to this module so it works both from `server/utils/` (tsx
 * dev) and from the flattened `dist/` layout the Dockerfile produces, where
 * `utils/` sits next to `platform/`.
 */
const MIGRATIONS_DIR = path.join(__dirname, "..", "platform", "db", "migrations");

/**
 * Master-database migrations (platform tables: tenants, shards, platform_users…).
 *
 * Kept in a `master/` subdirectory so the tenant loader — which only picks up
 * `*.sql` directly inside MIGRATIONS_DIR — never applies them to a tenant DB.
 */
const MASTER_MIGRATIONS_DIR = path.join(MIGRATIONS_DIR, "master");

interface Migration {
    name: string;
    sql: string;
}

let _cache: Migration[] | null = null;
let _masterCache: Migration[] | null = null;

/** Read every `.sql` file in a directory, sorted by filename. */
function readSqlDir(dir: string, label: string): Migration[] {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    } catch {
        // A missing directory is not an error — it just means no migrations
        // of this kind exist yet.
        return [];
    }
    if (files.length) {
        logger.info({ count: files.length, files, label }, "Migration runner: loaded SQL migrations");
    }
    return files.map((file) => ({
        name: file.replace(/\.sql$/, ""),
        sql: fs.readFileSync(path.join(dir, file), "utf8"),
    }));
}

/**
 * Tenant migrations, loaded once and cached.
 *
 * The numeric prefix defines apply order, so zero-pad new files
 * (`0003_`, `0004_`, ...) to keep lexical and numeric order identical.
 *
 * Names keep their prefix in `_migrations`, so renaming an existing file
 * would re-apply it. Never rename one.
 */
function loadMigrations(): Migration[] {
    if (!_cache) _cache = readSqlDir(MIGRATIONS_DIR, "tenant");
    return _cache;
}

/** Master-database migrations (platform tables), loaded once and cached. */
function loadMasterMigrations(): Migration[] {
    if (!_masterCache) _masterCache = readSqlDir(MASTER_MIGRATIONS_DIR, "master");
    return _masterCache;
}

/**
 * Names of the 30 pre-squash migrations. A database that has ALL of these
 * recorded is already fully migrated, so `0002_migration_catchup.sql` must be
 * marked as applied WITHOUT executing it.
 *
 * WHY THIS MATTERS
 *   The catch-up file is a faithful flattening of those 30 migrations,
 *   including `DROP TABLE IF EXISTS sprint_retrospectives;` followed by a
 *   recreate (migration 2026_05_v3 intentionally rebuilt that table). Replaying
 *   it against a live database would DESTROY existing retrospectives.
 *
 *   Fresh databases have none of these names, so they run the file normally.
 *
 * Do not edit: this list is frozen history.
 */
const LEGACY_MIGRATION_NAMES: readonly string[] = [
    "2026_05_v1_index_users_org_active",
    "2026_05_v1_index_audit_logs_actor_created",
    "2026_05_v1_index_audit_logs_entity_created",
    "2026_05_v1_agile_customisation_tables",
    "2026_05_v2_sprint_lifecycle",
    "2026_05_v3_cycle_time_and_retros",
    "2026_05_v4_retro_cleanup",
    "2026_06_v1_branding_and_email_templates",
    "2026_06_v2_cleanup_dm_extra_participants",
    "2026_06_v1_custom_fields",
    "2026_06_v3_compensation_payroll_tables",
    "2026_06_v4_status_service_v2_schema",
    "2026_06_v4_ctc_support",
    "2026_06_v5_drop_legacy_user_status_columns",
    "2026_06_v6_projects_and_git_integration",
    "2026_05_attendance_face_location",
    "2026_05_attendance_face_location_column_rename_fix",
    "2026_06_v7_office_wifi_verification",
    "2026_06_v8_messages_client_msg_id",
    "2026_06_v9_users_hidden_from_directory",
    "2026_06_v10_user_mfa",
    "2026_06_v11_task_comment_attachments",
    "2026_06_v12_mfa_reset_tokens",
    "2026_06_v13_push_notification_device_tokens",
    "2026_06_v14_biometric_device_credentials",
    "2026_06_v15_webauthn_credentials",
    "2026_06_v16_biometric_login_enabled_flag",
    "2026_06_v17_chat_media_jobs_foundation",
    "2026_06_v18_chat_media_pipeline_stages",
    "2026_07_v19_notification_metric_events",
];

/** Migration that flattens the legacy set; safe to skip when they all ran. */
const CATCHUP_MIGRATION = "0002_migration_catchup";

interface MigrationOpts {
    label?: string;
    transaction?: TransactionFn;
    /** Throw on the first failed migration so the enclosing transaction rolls back. */
    failFast?: boolean;
}

interface MigrationResult {
    applied: string[];
    skipped: number;
    failed: string[];
}

/**
 * Apply pending migrations to a single tenant database (or the legacy master).
 * Safe to call repeatedly — applied names are recorded in `_migrations`.
 */
async function runTenantMigrations(query: QueryFn, opts: MigrationOpts = {}): Promise<MigrationResult> {
    const label = opts.label || "tenant";

    // The transaction-scoped advisory lock and every migration statement must
    // use the SAME physical connection. This is safe through PgBouncer's
    // transaction pooling and prevents simultaneous deploy replicas applying
    // DDL to the same tenant DB.
    if (opts.transaction) {
        return opts.transaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`aino:migrate:${label}`]);
            const txQuery: QueryFn = (sql, params = []) => client.query(sql, params as any[]);
            return runTenantMigrations(txQuery, { label, failFast: true });
        });
    }
    const applied: string[] = [];
    const failed: string[] = [];
    let skipped = 0;

    // Ensure the ledger exists. initTenantSchema() also creates it, but we
    // must not depend on call order.
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message, label }, "Migration runner: failed to ensure _migrations table");
        return { applied, skipped, failed };
    }

    let appliedSet = new Set<string>();
    try {
        const res = await query("SELECT name FROM _migrations");
        appliedSet = new Set(res.rows.map((r) => (r as { name: string }).name));
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message, label }, "Migration runner: failed to read _migrations");
        return { applied, skipped, failed };
    }

    // ── Legacy adoption ─────────────────────────────────────────────────────
    // A database carrying all 30 pre-squash migration names is already fully
    // migrated. Record the catch-up file as applied WITHOUT running it: the
    // file recreates `sprint_retrospectives`, which would delete live rows.
    if (!appliedSet.has(CATCHUP_MIGRATION)) {
        const legacyPresent = LEGACY_MIGRATION_NAMES.filter((n) => appliedSet.has(n)).length;
        if (legacyPresent === LEGACY_MIGRATION_NAMES.length) {
            try {
                await query(
                    "INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
                    [CATCHUP_MIGRATION],
                );
                appliedSet.add(CATCHUP_MIGRATION);
                logger.info(
                    { label, legacyPresent },
                    "Migration runner: pre-squash DB detected — adopted catch-up migration without re-running it",
                );
            } catch (err: unknown) {
                logger.error(
                    { err: (err as Error).message, label },
                    "Migration runner: failed to adopt catch-up migration",
                );
            }
        } else if (legacyPresent > 0) {
            // Partially-migrated DB: running the catch-up is still the correct
            // repair (every statement is IF NOT EXISTS guarded), but the retro
            // rebuild could lose rows, so make the situation visible.
            logger.warn(
                { label, legacyPresent, legacyTotal: LEGACY_MIGRATION_NAMES.length },
                "Migration runner: PARTIALLY migrated DB — catch-up will run and may rebuild sprint_retrospectives",
            );
        }
    }

    for (const mig of loadMigrations()) {
        if (appliedSet.has(mig.name)) {
            skipped++;
            continue;
        }
        try {
            // node-postgres runs a multi-statement string in an implicit
            // transaction, so a mid-file failure rolls the whole file back and
            // the ledger row is never written. No CONCURRENTLY statements are
            // present, which would otherwise forbid this.
            await query(mig.sql);
            await query(
                "INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
                [mig.name],
            );
            applied.push(mig.name);
            logger.info({ migration: mig.name, label }, "Migration applied");
        } catch (err: unknown) {
            failed.push(mig.name);
            logger.error({
                migration: mig.name,
                label,
                err: (err as Error).message,
            }, "Migration failed (non-fatal — will retry on next sweep)");
            if (opts.failFast) throw err;
        }
    }

    // Always re-run the Agile defaults seeder. Idempotent: it only does work
    // for orgs not yet seeded (or whose tasks still need backfilling), so every
    // tenant picks up Work Item Types / Workflow States on the next deploy.
    try {
        const { seedAgileDefaults } = require("../db");
        await seedAgileDefaults(query);
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message, label }, "Agile defaults seeding failed (non-fatal)");
    }

    return { applied, skipped, failed };
}

interface SweepTotals {
    applied: number;
    skipped: number;
    failed: number;
    tenants: number;
}

/**
 * Iterate every active tenant and apply pending migrations.
 * Called once at server startup (after `initDB()`).
 *
 * Lazy-loads tenantManager to avoid the circular import
 * tenantManager -> db -> migrationRunner.
 */
async function sweepAllTenants(): Promise<SweepTotals> {
    const { forEachTenant } = require("./tenantManager");
    const totals: SweepTotals = { applied: 0, skipped: 0, failed: 0, tenants: 0 };

    await forEachTenant(async (db: { query: QueryFn; transaction?: TransactionFn }, tenant: { slug?: string; db_name?: string }) => {
        totals.tenants++;
        const label = tenant.slug || tenant.db_name;
        const r = await runTenantMigrations(db.query, { label, transaction: db.transaction });
        totals.applied += r.applied.length;
        totals.skipped += r.skipped;
        totals.failed += r.failed.length;
        // Surface per-tenant failures loudly. A silently-failing migration
        // (e.g. device_tokens never created) otherwise hides forever, breaking
        // features like push notifications with no obvious cause.
        if (r.failed.length > 0) {
            logger.error(
                { label, failedMigrations: r.failed },
                "Migration sweep: tenant has FAILED migrations — feature schema may be incomplete",
            );
        }
    }, { label: "migration-sweep" });

    if (totals.failed > 0) {
        logger.error(totals, "Migration sweep complete WITH FAILURES — see per-tenant errors above");
    } else {
        logger.info(totals, "Migration sweep complete");
    }
    return totals;
}

/**
 * Number of migrations the code expects to be applied.
 *
 * `/api/health?detail=true` compares this against each tenant's `_migrations`
 * count and reports the deployment degraded if any tenant is behind.
 *
 * Computed from the directory listing (not a hardcoded constant) so adding a
 * `.sql` file automatically raises the expectation.
 */
const expectedMigrationCount = loadMigrations().length;

/**
 * Apply pending migrations to the MASTER database (platform tables: tenants,
 * shards, platform_users, user_directory, app_settings).
 *
 * Separate from the tenant sweep because master has exactly one database and a
 * different schema. Tracked in the same `_migrations` table, but names are
 * prefixed `master/` so they can never collide with a tenant migration.
 *
 * Called from migrate.ts on every deploy, before the tenant sweep.
 */
async function runMasterMigrations(): Promise<MigrationResult> {
    const { masterQuery, masterTransaction } = require("../db");
    return masterTransaction(async (client: any) => {
    // Serialise master catalog DDL across simultaneous deploy replicas. This
    // lock is transaction-scoped and therefore PgBouncer transaction-mode safe.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["aino:migrate:master"]);
    const query: QueryFn = (sql, params = []) => client.query(sql, params as any[]);
    const applied: string[] = [];
    const failed: string[] = [];
    let skipped = 0;

    const migrations = loadMasterMigrations();
    if (migrations.length === 0) return { applied, skipped, failed };

    try {
        await query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message }, "Master migrations: failed to ensure _migrations table");
        return { applied, skipped, failed };
    }

    let appliedSet = new Set<string>();
    try {
        const res = await query("SELECT name FROM _migrations");
        appliedSet = new Set(res.rows.map((r) => (r as { name: string }).name));
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message }, "Master migrations: failed to read _migrations");
        return { applied, skipped, failed };
    }

    for (const mig of migrations) {
        const name = `master/${mig.name}`;
        if (appliedSet.has(name)) {
            skipped++;
            continue;
        }
        try {
            await query(mig.sql);
            await query(
                "INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
                [name],
            );
            applied.push(name);
            logger.info({ migration: name }, "Master migration applied");
        } catch (err: unknown) {
            failed.push(name);
            logger.error(
                { migration: name, err: (err as Error).message },
                "Master migration FAILED",
            );
        }
    }

    return { applied, skipped, failed };
    });
}

/**
 * One-off data scrub: remove platform admins that a historical login bug
 * seeded into CUSTOMER tenants.
 *
 * Background: `finishLogin()` used to home a platform admin in the *first
 * active tenant* instead of the *default platform tenant*, inserting a
 * visible `role='platform_admin'` users row into whichever customer tenant
 * was created first — plus a sticky `user_directory` row that kept routing
 * their logins there. Per the access model, platform admins must NEVER be
 * members of customer tenants (they use the consent-gated impersonation
 * flow instead), so those rows are illegitimate by definition.
 *
 * What this does, for every ACTIVE NON-default tenant:
 *   1. Deactivates + hides every VISIBLE platform_admin users row
 *      (`role = 'platform_admin' AND hidden_from_directory = FALSE`).
 *      The `hidden_from_directory = FALSE` filter precisely excludes the
 *      legitimate synthetic "Platform Inspector" rows created by the
 *      impersonation flow (those are hidden by design and must survive).
 *   2. Deletes the matching master `user_directory` rows so login routing
 *      and the tenant's user_count are corrected immediately.
 *
 * Idempotent and safe to run on every startup — once scrubbed, the WHERE
 * clauses match nothing.
 */
async function scrubPlatformAdminsFromCustomerTenants(): Promise<{ scrubbedUsers: number; scrubbedDirRows: number }> {
    const { masterQuery } = require('../db');
    const { getTenantPool } = require('./tenantManager');
    const totals = { scrubbedUsers: 0, scrubbedDirRows: 0 };

    let tenants: any[] = [];
    try {
        tenants = (await masterQuery(`
            SELECT id, slug, db_name, db_host
              FROM tenants
             WHERE status = 'active'
               AND (is_default IS NOT TRUE)
               AND db_name IS NOT NULL
        `)).rows;
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message }, 'platform-admin scrub: failed to list tenants');
        return totals;
    }

    for (const t of tenants) {
        try {
            const db = await getTenantPool(t.db_name, t.db_host);
            // Find visible platform_admin rows (never the hidden inspector rows).
            const rows = (await db.query(`
                SELECT id, username, email
                  FROM users
                 WHERE role = 'platform_admin'
                   AND hidden_from_directory = FALSE
            `)).rows;
            if (rows.length === 0) continue;

            const ids = rows.map((r: any) => r.id);
            await db.query(
                `UPDATE users
                    SET is_active = FALSE, hidden_from_directory = TRUE
                  WHERE id = ANY($1::int[])`,
                [ids],
            );
            totals.scrubbedUsers += ids.length;

            // Remove the stale master directory rows so login routing and the
            // tenant's user_count are corrected.
            const dirRes = await masterQuery(
                `DELETE FROM user_directory
                  WHERE tenant_id = $1 AND user_id = ANY($2::int[])`,
                [t.id, ids],
            );
            totals.scrubbedDirRows += dirRes.rowCount || 0;

            logger.warn(
                { tenantId: t.id, slug: t.slug, users: rows.map((r: any) => r.username) },
                'platform-admin scrub: removed platform admin membership from customer tenant',
            );
        } catch (err: unknown) {
            logger.error(
                { err: (err as Error).message, tenantId: t.id, slug: t.slug },
                'platform-admin scrub: tenant iteration failed (non-fatal)',
            );
        }
    }

    if (totals.scrubbedUsers > 0) {
        logger.info(totals, 'platform-admin scrub complete');
    }
    return totals;
}

export {
    runTenantMigrations,
    runMasterMigrations,
    sweepAllTenants,
    scrubPlatformAdminsFromCustomerTenants,
    expectedMigrationCount,
};
