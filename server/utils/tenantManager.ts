/**
 * Tenant Database Lifecycle Manager.
 *
 * Manages per-tenant PostgreSQL databases and an LRU pool cache to keep
 * total connection count within Railway's limits (~97 usable).
 *
 * Pool strategy:
 *   - Master pool: max 10 connections (in db.js)
 *   - Active tenant pools: up to MAX_POOLS (10), each with POOL_SIZE (8)
 *   - Idle pools evicted after IDLE_TIMEOUT_MS (5 min)
 *   - Total worst case: 10 + 10×8 = 90 connections
 */
import { Pool } from "pg";
import { masterQuery, masterTransaction, makePoolQuery, makePoolTransaction, initTenantSchema } from "../db";
import { logger } from "./logger";
import type { QueryFn, TransactionFn, TenantRow, DbContext } from "../types/domain";

interface PoolEntry {
    pool: Pool;
    query: QueryFn;
    transaction: TransactionFn;
    lastUsed: number;
}

interface CreateTenantOpts {
    orgName: string;
    slug: string;
    plan?: string;
    features?: Record<string, unknown>;
    maxUsers?: number | null;
    maxStorageMb?: number | null;
}

interface ForEachTenantOpts {
    label?: string;
    includeLegacyMaster?: boolean;
}

interface MasterConnConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    ssl: { rejectUnauthorized: boolean } | false;
}

// Configurable via env so Railway/prod deployments can be tuned without a rebuild.
//   TENANT_MAX_POOLS       — max number of cached tenant pools (default 10)
//   TENANT_POOL_SIZE       — max connections per pool                (default 8)
//   TENANT_POOL_IDLE_MS    — idle pool eviction threshold in ms      (default 5 min)
const MAX_POOLS = Math.max(1, parseInt(process.env.TENANT_MAX_POOLS || "", 10) || 10);
const POOL_SIZE = Math.max(1, parseInt(process.env.TENANT_POOL_SIZE || "", 10) || 8);
const IDLE_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.TENANT_POOL_IDLE_MS || "", 10) || 5 * 60 * 1000);

// ── LRU pool cache ──────────────────────────────────────────────────────────

const poolCache = new Map<string, PoolEntry>();

/** Track tenant DBs that have been schema-migrated this process lifetime. */
const migratedDbs = new Set<string>();

/** Prevents concurrent pool creation for the same db_name. */
const pendingCreations = new Map<string, Promise<PoolEntry>>();

/** Parse the master DATABASE_URL to extract host/port/user/password for tenant connections. */
function parseMasterUrl(): MasterConnConfig {
    const url = new URL(process.env.DATABASE_URL as string);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 5432,
        user: url.username,
        password: url.password,
        ssl: (process.env.DATABASE_URL || "").includes("sslmode=require")
            ? { rejectUnauthorized: false }
            : false,
    };
}

/**
 * Evict the least-recently-used pool if we're over the limit, or any pool
 * that has been idle longer than IDLE_TIMEOUT_MS.
 */
function evictIfNeeded(): void {
    const now = Date.now();
    // First evict stale pools
    for (const [dbName, entry] of poolCache) {
        if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
            logger.info({ dbName }, "Evicting idle tenant pool");
            entry.pool.end().catch(() => { });
            poolCache.delete(dbName);
        }
    }
    // Then evict LRU if still over limit
    while (poolCache.size >= MAX_POOLS) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [dbName, entry] of poolCache) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = dbName;
            }
        }
        if (oldestKey) {
            logger.info({ dbName: oldestKey }, "Evicting LRU tenant pool");
            poolCache.get(oldestKey)!.pool.end().catch(() => { });
            poolCache.delete(oldestKey);
        }
    }
}

/**
 * Get (or create) a connection pool for a tenant database.
 * Returns { pool, query, transaction } where query/transaction are bound to the pool.
 *
 * @param dbName - The database name (e.g., 'wp_acme')
 * @param dbHost - Override host (for future external DB support)
 */
async function getTenantPool(dbName: string, dbHost?: string | null): Promise<PoolEntry> {
    // Cache hit — touch LRU timestamp
    if (poolCache.has(dbName)) {
        const entry = poolCache.get(dbName)!;
        entry.lastUsed = Date.now();
        return entry;
    }

    // Prevent duplicate concurrent pool creation
    if (pendingCreations.has(dbName)) {
        return pendingCreations.get(dbName)!;
    }

    const promise = (async (): Promise<PoolEntry> => {
        evictIfNeeded();

        const master = parseMasterUrl();
        const tenantPool = new Pool({
            host: dbHost || master.host,
            port: master.port,
            user: master.user,
            password: master.password,
            database: dbName,
            ssl: master.ssl,
            max: POOL_SIZE,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });

        tenantPool.on("error", (err) => {
            logger.error({ err, dbName }, "Tenant pool error");
        });

        // Verify connectivity
        const client = await tenantPool.connect();
        client.release();

        const entry: PoolEntry = {
            pool: tenantPool,
            query: makePoolQuery(tenantPool),
            transaction: makePoolTransaction(tenantPool),
            lastUsed: Date.now(),
        };

        poolCache.set(dbName, entry);

        // Note: implicit `initTenantSchema(entry.query)` on first pool use was
        // removed in favor of the startup-time `sweepAllTenants()` migration
        // runner (see server/utils/migrationRunner.js). Cold-start latency for
        // new tenants is now bounded by the connection itself, not by an
        // entire schema script. Newly-created tenants still get
        // `initTenantSchema()` called explicitly in `createTenant()` below.
        //
        // Apply versioned migrations on first touch of a tenant pool this
        // process lifetime — cheap, idempotent, and ensures any tenant DB
        // touched at runtime (e.g. via custom-domain hit) is up to date even
        // if it was provisioned before the most recent deploy.
        if (!migratedDbs.has(dbName)) {
            migratedDbs.add(dbName);
            try {
                const { runTenantMigrations } = require("./migrationRunner");
                await runTenantMigrations(entry.query, { label: dbName });
            } catch (err) {
                logger.error({ err: (err as Error).message, dbName }, "Per-pool migrations failed (non-fatal)");
            }
        }

        logger.info({ dbName, poolCount: poolCache.size }, "Tenant pool created");
        return entry;
    })();

    pendingCreations.set(dbName, promise);
    try {
        return await promise;
    } finally {
        pendingCreations.delete(dbName);
    }
}

/**
 * Destroy a specific tenant pool (e.g., on tenant deletion).
 */
async function destroyTenantPool(dbName: string): Promise<void> {
    const entry = poolCache.get(dbName);
    if (entry) {
        await entry.pool.end();
        poolCache.delete(dbName);
        logger.info({ dbName }, "Tenant pool destroyed");
    }
}

/**
 * Destroy all cached tenant pools (for graceful shutdown).
 */
async function destroyAllPools(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [dbName, entry] of poolCache) {
        promises.push(entry.pool.end().catch(() => { }));
        logger.info({ dbName }, "Shutting down tenant pool");
    }
    poolCache.clear();
    await Promise.all(promises);
}

// ── Tenant lifecycle ────────────────────────────────────────────────────────

/** PostgreSQL identifiers are capped at 63 bytes. */
const PG_IDENT_MAX = 63;

/**
 * Resolve a database name derived from `base` that is unused both in the
 * master `tenants` catalog and on the physical PostgreSQL cluster. Appends a
 * numeric suffix (`_1`, `_2`, …) on collision. This guards against reusing the
 * retained database of a soft-deleted tenant that shared the same slug.
 */
async function pickAvailableDbName(base: string): Promise<string> {
    const trimmedBase = base.slice(0, PG_IDENT_MAX);
    for (let i = 0; i < 1000; i++) {
        const suffix = i === 0 ? "" : `_${i}`;
        const candidate = i === 0
            ? trimmedBase
            : `${base.slice(0, PG_IDENT_MAX - suffix.length)}${suffix}`;

        const inCatalog = (await masterQuery(
            "SELECT 1 FROM tenants WHERE db_name = $1 LIMIT 1",
            [candidate],
        )).rows.length > 0;
        if (inCatalog) continue;

        const physicallyExists = (await masterQuery(
            "SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1",
            [candidate],
        )).rows.length > 0;
        if (physicallyExists) continue;

        return candidate;
    }
    throw new Error(`Could not allocate a unique database name for base "${base}"`);
}

/**
 * Create a new tenant database and initialise its schema.
 */
async function createTenant(
    { orgName, slug, plan, features, maxUsers, maxStorageMb }: CreateTenantOpts,
): Promise<{ tenant: TenantRow; db: PoolEntry }> {
    const { getPlanLimits, PLAN_KEYS } = require("./planCatalog");
    const effectivePlan = PLAN_KEYS.includes(plan) ? plan : "standard";
    const planLimits = getPlanLimits(effectivePlan);

    // Allocate a database name that is free both in the master catalog AND on
    // the physical PostgreSQL cluster. This prevents a "new" tenant from
    // silently inheriting the data of a previously-deleted tenant that shared
    // the same slug (whose retained database still exists after a soft delete).
    const dbName = await pickAvailableDbName(`wp_${slug.replace(/-/g, "_")}`);

    // Sanitize: only allow safe identifiers to prevent DDL injection
    if (!/^wp_[a-z0-9_]+$/.test(dbName)) {
        throw new Error(`Invalid tenant database name: ${dbName}`);
    }

    // 1. Register in master tenants catalog
    const result = await masterQuery(
        `INSERT INTO tenants (org_name, slug, db_name, plan, features, max_users, max_storage_mb)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [orgName, slug, dbName, effectivePlan, JSON.stringify(features || {}), maxUsers ?? planLimits.max_users, maxStorageMb ?? planLimits.max_storage_mb]
    );
    const tenant = result.rows[0] as TenantRow;

    // 2. Create the database (must use master connection; CREATE DATABASE cannot run inside a transaction)
    try {
        // Use a connecting directly to avoid parameterized DDL issues
        await masterQuery(`CREATE DATABASE "${dbName}"`);
    } catch (err) {
        // Any failure here (including a rare 42P04 race after our pre-check)
        // must roll back the catalog row so we never leave a tenant pointing
        // at a database we didn't freshly provision.
        await masterQuery("DELETE FROM tenants WHERE id = $1", [tenant.id]);
        throw err;
    }

    // 3. Connect to the new database and initialise schema
    const db = await getTenantPool(dbName);
    await initTenantSchema(db.query);

    // 4. Create the organizations row inside the tenant DB (1 org per tenant DB)
    await db.query(
        `INSERT INTO organizations (id, name, slug, created_by)
         VALUES (1, $1, $2, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [orgName, slug]
    );

    logger.info({ tenantId: tenant.id, dbName, slug }, "Tenant created");
    return { tenant, db };
}

/**
 * Drop a tenant database and remove from catalog.
 * DANGER: This permanently destroys all tenant data.
 *
 * @param tenantId
 * @param hardDelete - If true, DROP DATABASE. If false, just mark deleted.
 * @returns the tenant row that was deleted, or null if no such tenant existed.
 */
async function deleteTenant(tenantId: number, hardDelete = false): Promise<TenantRow | null> {
    const tenantRes = await masterQuery("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    const tenant = tenantRes.rows[0] as TenantRow | undefined;
    if (!tenant) return null;

    // Close pool if cached
    await destroyTenantPool(tenant.db_name);

    if (hardDelete) {
        // Sanitize db_name before using in DDL to prevent injection
        if (!/^wp_[a-z0-9_]+$/.test(tenant.db_name)) {
            throw new Error(`Invalid tenant database name: ${tenant.db_name}`);
        }
        // Terminate active connections first
        await masterQuery(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [tenant.db_name]
        );
        await masterQuery(`DROP DATABASE IF EXISTS "${tenant.db_name}"`);
        await masterQuery("DELETE FROM user_directory WHERE tenant_id = $1", [tenantId]);
        await masterQuery("DELETE FROM tenants WHERE id = $1", [tenantId]);
        logger.info({ tenantId, dbName: tenant.db_name }, "Tenant hard-deleted");
    } else {
        // Soft delete: retain the database + catalog row for audit/recovery,
        // but free the UNIQUE identifiers (slug, custom_domain) so the same
        // slug can be provisioned again as a brand-new tenant. The db_name is
        // left untouched so the retained data stays reachable; createTenant()
        // allocates a fresh, collision-free db_name for any future tenant.
        const tombstone = `_deleted_${tenantId}`;
        const tombstonedSlug = `${tenant.slug}${tombstone}`;
        await masterQuery(
            `UPDATE tenants
                SET status = 'deleted',
                    slug = $2,
                    custom_domain = NULL,
                    updated_at = NOW()
              WHERE id = $1`,
            [tenantId, tombstonedSlug]
        );
        // Drop the freed users from the global directory so their emails /
        // usernames can be reused and don't inflate cross-tenant lookups.
        await masterQuery("DELETE FROM user_directory WHERE tenant_id = $1", [tenantId]);
        logger.info({ tenantId, dbName: tenant.db_name, freedSlug: tenant.slug }, "Tenant soft-deleted");
    }
    return tenant;
}

/**
 * Suspend a tenant — all API calls will get 503.
 */
async function suspendTenant(tenantId: number, reason?: string | null): Promise<void> {
    await masterQuery(
        `UPDATE tenants SET status = 'suspended', suspended_at = NOW(), suspended_reason = $2, updated_at = NOW()
         WHERE id = $1`,
        [tenantId, reason || null]
    );
    logger.info({ tenantId, reason }, "Tenant suspended");
}

/**
 * Reactivate a suspended tenant.
 */
async function reactivateTenant(tenantId: number): Promise<void> {
    await masterQuery(
        `UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = NOW()
         WHERE id = $1`,
        [tenantId]
    );
    logger.info({ tenantId }, "Tenant reactivated");
}

/**
 * Get tenant record from master DB by ID.
 */
async function getTenantById(tenantId: number): Promise<TenantRow | null> {
    const res = await masterQuery("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    return (res.rows[0] as TenantRow) || null;
}

/**
 * Get tenant record from master DB by slug.
 */
async function getTenantBySlug(slug: string): Promise<TenantRow | null> {
    const res = await masterQuery("SELECT * FROM tenants WHERE slug = $1", [slug]);
    return (res.rows[0] as TenantRow) || null;
}

/**
 * Get tenant record by custom domain.
 */
async function getTenantByDomain(domain: string): Promise<TenantRow | null> {
    const res = await masterQuery(
        `SELECT * FROM tenants WHERE custom_domain = $1 AND status != 'deleted'`,
        [domain.toLowerCase()]
    );
    return (res.rows[0] as TenantRow) || null;
}

/**
 * List all active tenants (for background jobs).
 */
async function listActiveTenants(): Promise<TenantRow[]> {
    const res = await masterQuery(
        `SELECT * FROM tenants WHERE status = 'active' ORDER BY id`
    );
    return res.rows as TenantRow[];
}

type ForEachTenantFn = (db: DbContext, tenant: Omit<Partial<TenantRow>, "id"> & { id: number | null; slug: string; db_name: string }) => Promise<unknown>;

/**
 * Iterate every active tenant and invoke `fn(db, tenant)` for each.
 *
 * - Errors are caught per-tenant so one failing tenant doesn't abort the
 *   whole sweep.
 * - Optionally also runs `fn` against the master DB if it isn't covered by
 *   any active tenant (legacy single-DB deployments still on the pre-
 *   migration `users` table).
 */
async function forEachTenant(fn: ForEachTenantFn, opts: ForEachTenantOpts = {}): Promise<{ ok: number; failed: number }> {
    const { label = "job", includeLegacyMaster = true } = opts;
    let ok = 0;
    let failed = 0;

    let tenants: TenantRow[] = [];
    try {
        tenants = await listActiveTenants();
    } catch (err) {
        logger.error({ err: (err as Error).message, label }, "forEachTenant: failed to list tenants");
        return { ok, failed };
    }

    for (const tenant of tenants) {
        try {
            const db = await getTenantPool(tenant.db_name, tenant.db_host);
            await fn(db as unknown as DbContext, tenant);
            ok++;
        } catch (err) {
            failed++;
            logger.error({
                err: (err as Error).message,
                stack: (err as Error).stack,
                tenantId: tenant.id,
                slug: tenant.slug,
                label,
            }, "forEachTenant: tenant iteration failed");
        }
    }

    if (includeLegacyMaster) {
        try {
            const masterDbName = new URL(process.env.DATABASE_URL as string).pathname.slice(1);
            const masterCovered = tenants.some(t => t.db_name === masterDbName);
            if (!masterCovered) {
                // Only run against master if it actually has a `users` table
                // (i.e. legacy single-DB deployment pre-migration).
                const hasUsers = (await masterQuery(`
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1
                `)).rows.length > 0;
                if (hasUsers) {
                    try {
                        await fn(
                            { query: masterQuery, transaction: masterTransaction } as unknown as DbContext,
                            { id: null, slug: "master", db_name: masterDbName },
                        );
                        ok++;
                    } catch (err) {
                        failed++;
                        logger.error({
                            err: (err as Error).message,
                            stack: (err as Error).stack,
                            label,
                        }, "forEachTenant: master legacy iteration failed");
                    }
                }
            }
        } catch { /* ignore – best-effort master coverage */ }
    }

    return { ok, failed };
}

/**
 * Get pool size info for monitoring.
 */
function getPoolStats(): { poolCount: number; maxPools: number; pools: Record<string, unknown> } {
    const stats: Record<string, unknown> = {};
    for (const [dbName, entry] of poolCache) {
        stats[dbName] = {
            total: entry.pool.totalCount,
            idle: entry.pool.idleCount,
            waiting: entry.pool.waitingCount,
            lastUsed: entry.lastUsed,
        };
    }
    return { poolCount: poolCache.size, maxPools: MAX_POOLS, pools: stats };
}

export {
    // Pool management
    getTenantPool,
    destroyTenantPool,
    destroyAllPools,
    getPoolStats,
    // Tenant lifecycle
    createTenant,
    deleteTenant,
    suspendTenant,
    reactivateTenant,
    // Tenant queries
    getTenantById,
    getTenantBySlug,
    getTenantByDomain,
    listActiveTenants,
    forEachTenant,
};