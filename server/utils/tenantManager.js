/**
 * Tenant Database Lifecycle Manager.
 *
 * Manages per-tenant PostgreSQL databases and an LRU pool cache to keep
 * total connection count within Railway's limits (~97 usable).
 *
 * Pool strategy:
 *   - Master pool: max 10 connections (in db.js)
 *   - Active tenant pools: up to MAX_POOLS (10), each with POOL_SIZE (5)
 *   - Idle pools evicted after IDLE_TIMEOUT_MS (5 min)
 *   - Total worst case: 10 + 10×5 = 60 connections
 */
const { Pool } = require('pg');
const { masterQuery, masterTransaction, makePoolQuery, makePoolTransaction, initTenantSchema } = require('../db');
const { logger } = require('./logger');

const MAX_POOLS = 10;
const POOL_SIZE = 5;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── LRU pool cache ──────────────────────────────────────────────────────────

/** @type {Map<string, { pool: Pool, query: Function, transaction: Function, lastUsed: number }>} */
const poolCache = new Map();

/** Prevents concurrent pool creation for the same db_name. */
const pendingCreations = new Map();

/** Parse the master DATABASE_URL to extract host/port/user/password for tenant connections. */
function parseMasterUrl() {
    const url = new URL(process.env.DATABASE_URL);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 5432,
        user: url.username,
        password: url.password,
        ssl: process.env.DATABASE_URL.includes('sslmode=require')
            ? { rejectUnauthorized: false }
            : false,
    };
}

/**
 * Evict the least-recently-used pool if we're over the limit, or any pool
 * that has been idle longer than IDLE_TIMEOUT_MS.
 */
function evictIfNeeded() {
    const now = Date.now();
    // First evict stale pools
    for (const [dbName, entry] of poolCache) {
        if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
            logger.info({ dbName }, 'Evicting idle tenant pool');
            entry.pool.end().catch(() => { });
            poolCache.delete(dbName);
        }
    }
    // Then evict LRU if still over limit
    while (poolCache.size >= MAX_POOLS) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [dbName, entry] of poolCache) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = dbName;
            }
        }
        if (oldestKey) {
            logger.info({ dbName: oldestKey }, 'Evicting LRU tenant pool');
            poolCache.get(oldestKey).pool.end().catch(() => { });
            poolCache.delete(oldestKey);
        }
    }
}

/**
 * Get (or create) a connection pool for a tenant database.
 * Returns { pool, query, transaction } where query/transaction are bound to the pool.
 *
 * @param {string} dbName - The database name (e.g., 'wp_acme')
 * @param {string} [dbHost] - Override host (for future external DB support)
 * @returns {Promise<{ pool: Pool, query: Function, transaction: Function }>}
 */
async function getTenantPool(dbName, dbHost) {
    // Cache hit — touch LRU timestamp
    if (poolCache.has(dbName)) {
        const entry = poolCache.get(dbName);
        entry.lastUsed = Date.now();
        return entry;
    }

    // Prevent duplicate concurrent pool creation
    if (pendingCreations.has(dbName)) {
        return pendingCreations.get(dbName);
    }

    const promise = (async () => {
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

        tenantPool.on('error', (err) => {
            logger.error({ err, dbName }, 'Tenant pool error');
        });

        // Verify connectivity
        const client = await tenantPool.connect();
        client.release();

        const entry = {
            pool: tenantPool,
            query: makePoolQuery(tenantPool),
            transaction: makePoolTransaction(tenantPool),
            lastUsed: Date.now(),
        };

        // Run idempotent schema migrations so existing tenant DBs pick up
        // any new tables/columns added since the DB was first provisioned.
        await initTenantSchema(entry.query);

        poolCache.set(dbName, entry);
        logger.info({ dbName, poolCount: poolCache.size }, 'Tenant pool created');
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
 * @param {string} dbName
 */
async function destroyTenantPool(dbName) {
    const entry = poolCache.get(dbName);
    if (entry) {
        await entry.pool.end();
        poolCache.delete(dbName);
        logger.info({ dbName }, 'Tenant pool destroyed');
    }
}

/**
 * Destroy all cached tenant pools (for graceful shutdown).
 */
async function destroyAllPools() {
    const promises = [];
    for (const [dbName, entry] of poolCache) {
        promises.push(entry.pool.end().catch(() => { }));
        logger.info({ dbName }, 'Shutting down tenant pool');
    }
    poolCache.clear();
    await Promise.all(promises);
}

// ── Tenant lifecycle ────────────────────────────────────────────────────────

/**
 * Create a new tenant database and initialise its schema.
 *
 * @param {object} opts
 * @param {string} opts.orgName - Display name
 * @param {string} opts.slug    - URL slug (lowercase, hyphen-separated)
 * @param {object} [opts.features] - Feature flags
 * @param {number} [opts.maxUsers] - User limit
 * @param {number} [opts.maxStorageMb] - Storage limit
 * @returns {Promise<{ tenant: object, db: { pool, query, transaction } }>}
 */
async function createTenant({ orgName, slug, features, maxUsers, maxStorageMb }) {
    const dbName = `wp_${slug.replace(/-/g, '_')}`;

    // 1. Register in master tenants catalog
    const result = await masterQuery(
        `INSERT INTO tenants (org_name, slug, db_name, features, max_users, max_storage_mb)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [orgName, slug, dbName, JSON.stringify(features || {}), maxUsers || null, maxStorageMb || null]
    );
    const tenant = result.rows[0];

    // 2. Create the database (must use master connection; CREATE DATABASE cannot run inside a transaction)
    try {
        // Use a connecting directly to avoid parameterized DDL issues
        await masterQuery(`CREATE DATABASE "${dbName}"`);
    } catch (err) {
        if (err.code === '42P04') {
            // Database already exists — fine (idempotent)
            logger.warn({ dbName }, 'Tenant database already exists');
        } else {
            // Roll back the tenants row
            await masterQuery('DELETE FROM tenants WHERE id = $1', [tenant.id]);
            throw err;
        }
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

    logger.info({ tenantId: tenant.id, dbName, slug }, 'Tenant created');
    return { tenant, db };
}

/**
 * Drop a tenant database and remove from catalog.
 * DANGER: This permanently destroys all tenant data.
 *
 * @param {number} tenantId
 * @param {boolean} [hardDelete=false] - If true, DROP DATABASE. If false, just mark deleted.
 */
async function deleteTenant(tenantId, hardDelete = false) {
    const tenantRes = await masterQuery('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = tenantRes.rows[0];
    if (!tenant) throw new Error('Tenant not found');

    // Close pool if cached
    await destroyTenantPool(tenant.db_name);

    if (hardDelete) {
        // Terminate active connections first
        await masterQuery(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [tenant.db_name]
        );
        await masterQuery(`DROP DATABASE IF EXISTS "${tenant.db_name}"`);
        await masterQuery('DELETE FROM user_directory WHERE tenant_id = $1', [tenantId]);
        await masterQuery('DELETE FROM tenants WHERE id = $1', [tenantId]);
        logger.info({ tenantId, dbName: tenant.db_name }, 'Tenant hard-deleted');
    } else {
        await masterQuery(
            `UPDATE tenants SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
            [tenantId]
        );
        logger.info({ tenantId, dbName: tenant.db_name }, 'Tenant soft-deleted');
    }
}

/**
 * Suspend a tenant — all API calls will get 503.
 */
async function suspendTenant(tenantId, reason) {
    await masterQuery(
        `UPDATE tenants SET status = 'suspended', suspended_at = NOW(), suspended_reason = $2, updated_at = NOW()
         WHERE id = $1`,
        [tenantId, reason || null]
    );
    logger.info({ tenantId, reason }, 'Tenant suspended');
}

/**
 * Reactivate a suspended tenant.
 */
async function reactivateTenant(tenantId) {
    await masterQuery(
        `UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = NOW()
         WHERE id = $1`,
        [tenantId]
    );
    logger.info({ tenantId }, 'Tenant reactivated');
}

/**
 * Get tenant record from master DB by ID.
 */
async function getTenantById(tenantId) {
    const res = await masterQuery('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    return res.rows[0] || null;
}

/**
 * Get tenant record from master DB by slug.
 */
async function getTenantBySlug(slug) {
    const res = await masterQuery('SELECT * FROM tenants WHERE slug = $1', [slug]);
    return res.rows[0] || null;
}

/**
 * Get tenant record by custom domain.
 */
async function getTenantByDomain(domain) {
    const res = await masterQuery(
        `SELECT * FROM tenants WHERE custom_domain = $1 AND status != 'deleted'`,
        [domain.toLowerCase()]
    );
    return res.rows[0] || null;
}

/**
 * List all active tenants (for background jobs).
 */
async function listActiveTenants() {
    const res = await masterQuery(
        `SELECT * FROM tenants WHERE status = 'active' ORDER BY id`
    );
    return res.rows;
}

/**
 * Get pool size info for monitoring.
 */
function getPoolStats() {
    const stats = {};
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

module.exports = {
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
};
