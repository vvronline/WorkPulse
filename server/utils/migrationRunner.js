/**
 * Versioned migration runner for WorkPulse.
 *
 * Background: the existing `initTenantSchema(query)` in db.js is a long
 * idempotent function full of `CREATE TABLE IF NOT EXISTS` and
 * `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements. It works, but has two
 * shortcomings on the multi-tenant code path:
 *
 *   1. It runs the *entire* schema script every time `getTenantPool` first
 *      touches a tenant DB in a process (slow cold start, log noise).
 *   2. There is no record of which "logical migration" has been applied to
 *      a given tenant DB — so we can't gate a feature on "migration M is
 *      applied", and we can't easily add destructive migrations later.
 *
 * This module fixes both. Each migration is a `{ name, up(query) }` object
 * that runs once per tenant DB. We track applied migrations per DB in the
 * existing `_migrations` table (which the schema bootstrap already creates).
 *
 * Migrations defined here are *additive only* — they live alongside the
 * existing `initTenantSchema()` so they cannot regress an already-bootstrapped
 * DB. Use them for new columns/indexes/feature toggles after the initial
 * schema has shipped.
 *
 * Usage:
 *   const { runTenantMigrations, sweepAllTenants } = require('./migrationRunner');
 *   await runTenantMigrations(db.query);             // for a single tenant DB
 *   await sweepAllTenants();                         // startup: every active tenant
 */
const { logger } = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// Migration registry — append new migrations to the bottom; never reorder or
// rename existing ones. Each `name` is the unique key persisted in
// `_migrations.name`.
//
// `up(query)` is invoked with a pool-bound query function. Migrations should
// be idempotent (`IF NOT EXISTS`) so a partial application can be safely
// retried without manual cleanup.
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATIONS = [
    {
        name: '2026_05_v1_index_users_org_active',
        async up(query) {
            await query(`
                CREATE INDEX IF NOT EXISTS idx_users_org_active
                ON users (org_id) WHERE is_active = TRUE
            `);
        },
    },
    {
        name: '2026_05_v1_index_audit_logs_actor_created',
        async up(query) {
            await query(`
                CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
                ON audit_logs (actor_id, created_at DESC)
            `);
        },
    },
    {
        name: '2026_05_v1_index_audit_logs_entity_created',
        async up(query) {
            await query(`
                CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created
                ON audit_logs (entity_type, created_at DESC)
            `);
        },
    },
];

/**
 * Apply pending migrations against a single tenant database (or the master
 * legacy DB). Safe to call multiple times.
 *
 * @param {(sql: string, params?: any[]) => Promise<any>} query
 * @param {object} [opts]
 * @param {string} [opts.label] – log label (e.g. tenant slug or dbName)
 * @returns {Promise<{ applied: string[], skipped: number, failed: string[] }>}
 */
async function runTenantMigrations(query, opts = {}) {
    const label = opts.label || 'tenant';
    const applied = [];
    const failed = [];
    let skipped = 0;

    // Ensure the tracking table exists (initTenantSchema also creates this,
    // but we don't want to depend on call order).
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    } catch (err) {
        logger.error({ err: err.message, label }, 'Migration runner: failed to ensure _migrations table');
        return { applied, skipped, failed };
    }

    // Read the set of already-applied names in one query
    let appliedSet = new Set();
    try {
        const res = await query('SELECT name FROM _migrations');
        appliedSet = new Set(res.rows.map(r => r.name));
    } catch (err) {
        logger.error({ err: err.message, label }, 'Migration runner: failed to read _migrations');
        return { applied, skipped, failed };
    }

    for (const mig of MIGRATIONS) {
        if (appliedSet.has(mig.name)) {
            skipped++;
            continue;
        }
        try {
            await mig.up(query);
            await query(
                'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
                [mig.name],
            );
            applied.push(mig.name);
            logger.info({ migration: mig.name, label }, 'Migration applied');
        } catch (err) {
            failed.push(mig.name);
            logger.error({
                migration: mig.name,
                label,
                err: err.message,
            }, 'Migration failed (non-fatal — will retry on next sweep)');
        }
    }

    return { applied, skipped, failed };
}

/**
 * Iterate every active tenant and apply pending migrations to their DB.
 * Intended to be called once at server startup (after `initDB()`).
 *
 * Lazy-loads tenantManager to avoid the circular-import that exists between
 * tenantManager → db → migrationRunner.
 */
async function sweepAllTenants() {
    const { forEachTenant } = require('./tenantManager');
    const totals = { applied: 0, skipped: 0, failed: 0, tenants: 0 };

    await forEachTenant(async (db, tenant) => {
        totals.tenants++;
        const r = await runTenantMigrations(db.query, { label: tenant.slug || tenant.db_name });
        totals.applied += r.applied.length;
        totals.skipped += r.skipped;
        totals.failed += r.failed.length;
    }, { label: 'migration-sweep' });

    logger.info(totals, 'Migration sweep complete');
    return totals;
}

module.exports = {
    MIGRATIONS,
    runTenantMigrations,
    sweepAllTenants,
};