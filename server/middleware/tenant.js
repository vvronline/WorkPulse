/**
 * Tenant Resolution Middleware.
 *
 * Resolves the tenant for each request and attaches:
 *   req.tenant        – tenant record from master DB (or null for master-only routes)
 *   req.db.query()    – pool-bound query for the resolved tenant
 *   req.db.transaction() – pool-bound transaction for the resolved tenant
 *   req.isMasterRoute – true if the request targets the master/platform admin panel
 *
 * Resolution order:
 *   1. JWT `tenant_id` claim (set after login) → fastest, no DB lookup
 *   2. Host header → custom domain lookup in master DB (Redis-cached 5 min)
 *   3. Default Railway domain → master context (platform admin panel)
 *
 * Suspended tenants get 503.
 * Deleted tenants get 404.
 */
const { masterQuery } = require('../db');
const { getTenantPool, getTenantById } = require('../utils/tenantManager');
const redis = require('../redis');
const { logger } = require('../utils/logger');

const DOMAIN_CACHE_TTL = 5 * 60; // 5 minutes

/**
 * Resolve tenant from JWT tenant_id claim (fast path).
 */
async function resolveFromJwt(req) {
    // The auth middleware hasn't run yet at this point, so we can't read req.userId.
    // However, we can peek at the JWT if present to get tenant_id without full verification.
    // The auth middleware will do full verification later.
    const jwt = require('jsonwebtoken');
    const token = req.cookies?.token;
    if (!token) return null;

    try {
        const decoded = jwt.decode(token); // decode only, don't verify (auth middleware does that)
        if (decoded?.tenant_id) {
            return decoded.tenant_id;
        }
    } catch {
        // Invalid token — let auth middleware handle it
    }
    return null;
}

/**
 * Resolve tenant from custom domain via Host header.
 * Uses Redis cache to avoid master DB lookup on every request.
 */
async function resolveFromDomain(host) {
    if (!host) return null;

    // Strip port if present
    const domain = host.split(':')[0].toLowerCase();

    // Skip localhost and Railway default domains
    if (domain === 'localhost' || domain.endsWith('.railway.app') || domain.endsWith('.up.railway.app')) {
        return null;
    }

    // Check Redis cache
    const cacheKey = `tenant:domain:${domain}`;
    const cached = await redis.get(cacheKey);
    if (cached) return cached === 'null' ? null : cached;

    // Query master DB
    const res = await masterQuery(
        `SELECT id, slug, db_name, db_host, status, features, max_users, max_storage_mb
         FROM tenants WHERE custom_domain = $1 AND status != 'deleted'`,
        [domain]
    );
    const tenant = res.rows[0] || null;

    // Cache (even null results to prevent repeated lookups for unknown domains)
    await redis.set(cacheKey, tenant || 'null', DOMAIN_CACHE_TTL);

    return tenant;
}

/**
 * Given a tenant record, get the pool and attach to req.
 */
async function attachTenantDb(req, tenant) {
    req.tenant = tenant;
    req.isMasterRoute = false;

    const db = await getTenantPool(tenant.db_name, tenant.db_host);
    req.db = {
        query: db.query,
        transaction: db.transaction,
        pool: db.pool,
    };
}

/**
 * Attach master DB context for platform admin routes.
 */
function attachMasterDb(req) {
    const { masterQuery: mq, masterTransaction: mt, pool: masterPool } = require('../db');
    req.tenant = null;
    req.isMasterRoute = true;
    req.db = {
        query: mq,
        transaction: mt,
        pool: masterPool,
    };
}

/**
 * Main tenant resolution middleware.
 */
async function resolveTenant(req, res, next) {
    try {
        // 1. Try JWT tenant_id (fast path for authenticated requests)
        const jwtTenantId = await resolveFromJwt(req);
        if (jwtTenantId) {
            // Load tenant from cache or master DB
            const cacheKey = `tenant:id:${jwtTenantId}`;
            let tenant = await redis.get(cacheKey);
            if (!tenant) {
                tenant = await getTenantById(jwtTenantId);
                if (tenant) {
                    await redis.set(cacheKey, tenant, DOMAIN_CACHE_TTL);
                }
            }

            if (tenant) {
                if (tenant.status === 'suspended') {
                    return res.status(503).json({
                        error: 'This organization is currently suspended.',
                        reason: tenant.suspended_reason || undefined,
                    });
                }
                if (tenant.status === 'deleted') {
                    return res.status(404).json({ error: 'Organization not found.' });
                }
                await attachTenantDb(req, tenant);
                return next();
            }
            // JWT has tenant_id but tenant not found — fall through to domain resolution
        }

        // 2. Try Host header for custom domain resolution
        const host = req.headers.host;
        const domainTenant = await resolveFromDomain(host);
        if (domainTenant) {
            if (domainTenant.status === 'suspended') {
                return res.status(503).json({
                    error: 'This organization is currently suspended.',
                    reason: domainTenant.suspended_reason || undefined,
                });
            }
            await attachTenantDb(req, domainTenant);
            return next();
        }

        // 3. Default domain or no match → master context
        // Platform admin routes, auth routes, and health checks use master DB
        attachMasterDb(req);
        next();
    } catch (err) {
        logger.error({ err, host: req.headers.host }, 'Tenant resolution error');
        // Fall back to master context so health checks and auth still work
        attachMasterDb(req);
        next();
    }
}

/**
 * Middleware: require that a tenant is resolved (not master context).
 * Use on routes that must operate within a tenant database.
 */
function requireTenant(req, res, next) {
    if (!req.tenant) {
        return res.status(400).json({ error: 'Organization context required. Please log in from your organization domain.' });
    }
    next();
}

/**
 * Middleware: check tenant feature flags.
 * Usage: requireFeature('meetings')
 */
function requireFeature(featureName) {
    return (req, res, next) => {
        if (!req.tenant) return next(); // master context — no feature gating
        const features = req.tenant.features || {};
        // Default: all features enabled if not explicitly set to false
        if (features[featureName] === false) {
            return res.status(403).json({ error: `The ${featureName} feature is not enabled for your organization.` });
        }
        next();
    };
}

/**
 * Middleware: check tenant user limit before creating a new user.
 */
async function checkUserLimit(req, res, next) {
    if (!req.tenant || !req.tenant.max_users) return next(); // no limit
    try {
        const countRes = await req.db.query('SELECT COUNT(*) as count FROM users WHERE is_active = TRUE');
        const current = parseInt(countRes.rows[0].count, 10);
        if (current >= req.tenant.max_users) {
            return res.status(403).json({
                error: `User limit reached (${req.tenant.max_users}). Contact your platform administrator.`,
            });
        }
        next();
    } catch (err) {
        next(err);
    }
}

/**
 * Invalidate cached tenant data (call after tenant config changes).
 */
async function invalidateTenantCache(tenantId, customDomain) {
    await redis.del(`tenant:id:${tenantId}`);
    if (customDomain) {
        await redis.del(`tenant:domain:${customDomain}`);
    }
}

module.exports = {
    resolveTenant,
    requireTenant,
    requireFeature,
    checkUserLimit,
    invalidateTenantCache,
};
