/**
 * Phase H5 — migration drift gauges.
 *
 * D4.3 deliberately removed the O(tenants) migration sweep from the health
 * probe because every load-balancer check was hitting every tenant database.
 * The same constraint applies here, so this sampler:
 *
 *   - runs ONLY on the worker role (one process, not one per web replica), and
 *   - samples on a slow interval rather than on scrape.
 *
 * Drift should be impossible now that migrations run in the Railway pre-deploy
 * command, so this is a backstop that proves the invariant holds rather than a
 * hot-path metric.
 */
import { Gauge } from "prom-client";
import { registry } from "./registry";
import { logger } from "../../utils/logger";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const migrationsExpected = new Gauge({
    name: "aino_migrations_expected",
    help: "Migration files the running image expects every tenant to have applied.",
    registers: [registry],
});

const migrationsApplied = new Gauge({
    name: "aino_migrations_applied",
    help: "Lowest applied migration count across all reachable tenants.",
    registers: [registry],
});

const tenantsUnreachable = new Gauge({
    name: "aino_tenants_unreachable",
    help: "Tenants whose database could not be reached during the last sweep.",
    registers: [registry],
});

let timer: NodeJS.Timeout | null = null;

/** Run one sweep. Exported so a test can drive it without a timer. */
async function sampleMigrationDrift(): Promise<void> {
    const { expectedMigrationCount } = require("../../utils/migrationRunner");
    const { forEachTenant } = require("../../utils/tenantManager");

    let minApplied = Infinity;
    const sweep = await forEachTenant(
        async (db: { query: (sql: string) => Promise<{ rows: any[] }> }) => {
            const result = await db.query("SELECT COUNT(*)::int AS count FROM _migrations");
            const count = result.rows[0]?.count || 0;
            if (count < minApplied) minApplied = count;
        },
        { label: "migration-drift-metric", includeLegacyMaster: true },
    );

    migrationsExpected.set(expectedMigrationCount);
    migrationsApplied.set(minApplied === Infinity ? expectedMigrationCount : minApplied);
    tenantsUnreachable.set(sweep.failed);
}

/**
 * Begin periodic sampling. `unref()` keeps the timer from holding the process
 * open during shutdown.
 */
function startMigrationDriftSampler(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (timer) return;
    const run = () => {
        sampleMigrationDrift().catch((err: unknown) => {
            logger.warn({ err }, "Migration drift sampling failed");
        });
    };
    run();
    timer = setInterval(run, intervalMs);
    timer.unref?.();
}

/** Stop sampling (shutdown and tests). */
function stopMigrationDriftSampler(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}

export {
    startMigrationDriftSampler,
    stopMigrationDriftSampler,
    sampleMigrationDrift,
    migrationsExpected,
    migrationsApplied,
    tenantsUnreachable,
};
