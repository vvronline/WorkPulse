const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
} else {
    require('dotenv').config();
}

const { logger, requestLogger } = require('./utils/logger');

if (!process.env.JWT_SECRET) {
    logger.fatal('JWT_SECRET environment variable is not set. Server cannot start.');
    process.exit(1);
}

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const cookieParser = require('cookie-parser');
const { pool, initDB, masterQuery, masterTransaction } = require('./db');
const redis = require('./redis');
const { resolveTenant } = require('./middleware/tenant');
const { listActiveTenants, getTenantPool, destroyAllPools } = require('./utils/tenantManager');
const authRoutes = require('./routes/auth');
const trackerRoutes = require('./routes/tracker');
const leaveRoutes = require('./routes/leaves');
const taskRoutes = require('./routes/tasks');
const profileRoutes = require('./routes/profile');
const organizationRoutes = require('./routes/organization');
const adminRoutes = require('./routes/admin');
const managerRoutes = require('./routes/manager');
const leavePolicyRoutes = require('./routes/leavePolicy');
const sprintsRoutes = require('./routes/sprints');
const notesRoutes = require('./routes/notes');

const calendarRoutes = require('./routes/calendar');
const notificationsRoutes = require('./routes/notifications');
const exportRoutes = require('./routes/export');
const chatRoutes = require('./routes/chat');
const searchRoutes = require('./routes/search');
const meetingsRoutes = require('./routes/meetings');
const tenantRoutes = require('./routes/tenants');
const { setupWebSocket } = require('./utils/ws');
const { initJobs, shutdownJobs } = require('./jobs');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            // upgrade-insecure-requests omitted: serving over plain HTTP (no TLS)
            "upgrade-insecure-requests": null,
        }
    },
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    // Prevent click-jacking
    frameguard: { action: 'deny' },
    // Strict transport security for HTTPS deployments
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// Helmet 8.x does not support permissionsPolicy — set the header manually
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    // Prevent browsers from MIME-sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Referrer policy to prevent leaking URLs (e.g. password reset tokens)
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Serve React static files BEFORE cors/auth — assets don't need CORS
const clientDist = path.join(__dirname, '..', 'client', 'dist');
// Cache-bust: hashed assets get long cache, index.html/sw.js never cached
app.use(express.static(clientDist, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.match(/\.(js|css|woff2?|png|jpg|svg)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));

app.use((req, res, next) => {
    const origin = req.headers.origin;

    const isAllowed = (() => {
        if (!origin) return true;

        // Explicitly allowed origins from env (comma-separated)
        if (process.env.CORS_ORIGIN) {
            const allowed = process.env.CORS_ORIGIN.split(',').map(s => s.trim());
            if (allowed.includes(origin)) return true;
        }

        // Always allow same-origin requests: when the SPA served by this
        // Express server makes API calls, Origin matches the Host header.
        // This works regardless of what domain Railway assigns.
        const host = req.headers.host;
        if (host && (origin === `https://${host}` || origin === `http://${host}`)) {
            return true;
        }

        if (process.env.NODE_ENV !== 'production') {
            const devOrigins = [
                `http://localhost:${PORT}`, 'http://localhost', 'https://localhost',
                'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:5173',
            ];
            if (devOrigins.includes(origin)) return true;
        }

        return false;
    })();

    if (!isAllowed) {
        return res.status(403).json({ error: 'Not allowed by CORS' });
    }

    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-timezone-offset');
    }

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});
app.use(cookieParser());
app.use('/api/notes', express.json({ limit: '5mb' }));
app.use('/api/profile/avatar', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));

// Structured request logging with request IDs
app.use(requestLogger);

// Tenant resolution — must come before auth and all /api routes
app.use(resolveTenant);

const authMiddleware = require('./middleware/auth');
app.use('/uploads', authMiddleware, async (req, res, next) => {
    const resolved = path.resolve(__dirname, 'uploads', req.path.replace(/^\//, ''));
    if (!resolved.startsWith(path.resolve(__dirname, 'uploads'))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    // Enforce tenant isolation: tenant-scoped paths like /uploads/tenant_5/org_42/...
    const tenantMatch = req.path.match(/^\/tenant_(\d+)\//);
    if (tenantMatch) {
        const pathTenantId = parseInt(tenantMatch[1], 10);
        if (!req.tenantId || req.tenantId !== pathTenantId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
    }
    // Enforce org isolation: org-scoped paths like /uploads/tenant_5/org_42/... must match user's org
    const orgMatch = req.path.match(/\/org_(\d+)\//);
    if (orgMatch) {
        const pathOrgId = parseInt(orgMatch[1], 10);
        const user = (await req.db.query('SELECT org_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!user || user.org_id !== pathOrgId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
    }
    next();
}, express.static(path.join(__dirname, 'uploads')));

app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const xrw = req.headers['x-requested-with'];
    if (xrw === 'WorkPulse') return next();
    return res.status(403).json({ error: 'Missing CSRF header' });
});

// Build a Redis-backed store factory; falls back to in-memory when Redis is unavailable
function makeStore(prefix) {
    const redisClient = redis.getClient();
    if (redisClient) {
        return new RedisStore({ sendCommand: (...args) => redisClient.call(...args), prefix: `rl:${prefix}:` });
    }
    return undefined; // express-rate-limit uses MemoryStore by default
}

// Per-tenant rate limiting: include tenantId in the key so tenants can't exhaust each other's quotas
const tenantKeyGen = (req) => `${req.tenantId || 'master'}:${req.ip}`;
const rlOpts = (prefix, max) => ({ windowMs: 15 * 60 * 1000, max, store: makeStore(prefix), keyGenerator: tenantKeyGen, validate: { keyGeneratorIpFallback: false } });
const authLimiter = rateLimit({ ...rlOpts('auth', 15), message: { error: 'Too many attempts. Please try again later.' } });
const registerLimiter = rateLimit({ ...rlOpts('reg', 10), message: { error: 'Too many registration attempts. Please try again later.' } });
const forgotPasswordLimiter = rateLimit({ ...rlOpts('fp', 5), message: { error: 'Too many password reset attempts. Please try again later.' } });
const passwordLimiter = rateLimit({ ...rlOpts('pw', 10), message: { error: 'Too many password attempts. Please try again later.' } });
const apiLimiter = rateLimit({ ...rlOpts('api', 5000), message: { error: 'Too many requests. Please try again later.' } });

// Audit every action during impersonation sessions
const impersonationAudit = require('./middleware/impersonationAudit');
app.use('/api', impersonationAudit);

app.use('/api/auth/register', registerLimiter);
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tracker', apiLimiter, trackerRoutes);
app.use('/api/leaves', apiLimiter, leaveRoutes);
app.use('/api/tasks', apiLimiter, taskRoutes);
app.use('/api/sprints', apiLimiter, sprintsRoutes);
app.use('/api/profile/password', passwordLimiter);
app.use('/api/profile', apiLimiter, profileRoutes);
app.use('/api/org', apiLimiter, organizationRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/admin/tenants', apiLimiter, tenantRoutes);
app.use('/api/manager', apiLimiter, managerRoutes);
app.use('/api/leave-policy', apiLimiter, leavePolicyRoutes);
app.use('/api/notes', apiLimiter, notesRoutes);
app.use('/api/calendar', apiLimiter, calendarRoutes);
app.use('/api/meetings', apiLimiter, meetingsRoutes);
app.use('/api/notifications', apiLimiter, notificationsRoutes);
app.use('/api/export', apiLimiter, exportRoutes);
app.use('/api/chat', apiLimiter, chatRoutes);
app.use('/api/search', apiLimiter, searchRoutes);

app.get('/api/health', async (req, res) => {
    try {
        await masterQuery('SELECT 1');
        res.json({ status: 'ok', time: new Date().toISOString() });
    } catch (err) {
        logger.error({ err }, 'Health check DB ping failed');
        res.status(503).json({ status: 'error', time: new Date().toISOString(), error: 'Database unreachable' });
    }
});

// ============= AUTO CLOCK-OUT (multi-tenant) =============
async function autoClockOut() {
    try {
        const tenants = await listActiveTenants();
        for (const tenant of tenants) {
            try {
                const db = await getTenantPool(tenant.db_name, tenant.db_host);
                await autoClockOutForDb(db);
            } catch (e) {
                logger.error({ tenantId: tenant.id, err: e }, 'Auto clock-out failed for tenant');
            }
        }

        // Also handle legacy users still in the master DB (pre-migration)
        const masterDbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
        const masterCoveredByTenant = tenants.some(t => t.db_name === masterDbName);
        if (!masterCoveredByTenant) {
            try {
                const hasUsers = (await masterQuery('SELECT 1 FROM users LIMIT 1')).rows.length > 0;
                if (hasUsers) {
                    await autoClockOutForDb({ query: masterQuery, transaction: masterTransaction });
                }
            } catch { /* users table may not exist in fresh master-only DB */ }
        }
    } catch (e) {
        logger.error({ err: e }, 'autoClockOut iteration error');
    }
}

async function autoClockOutForDb(db) {
    const activeUsers = (await db.query(`
        SELECT u.id, u.timezone_offset
        FROM users u
        INNER JOIN LATERAL (
            SELECT entry_type FROM time_entries t
            WHERE t.user_id = u.id
            ORDER BY t.timestamp DESC
            LIMIT 1
        ) latest ON latest.entry_type != 'clock_out'
    `)).rows;

    if (activeUsers.length === 0) return;

    // Process in batches to avoid overwhelming the connection pool
    const BATCH = 50;
    for (let i = 0; i < activeUsers.length; i += BATCH) {
        const batch = activeUsers.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(user =>
            autoClockOutUser(db, user).catch(e =>
                logger.error({ userId: user.id, err: e }, 'Auto clock-out failed')
            )
        ));
    }
}

async function autoClockOutUser(db, user) {
    const rawOffset = user.timezone_offset || 0;
    // Clamp to valid timezone range: UTC-12 (720) to UTC+14 (-840)
    const offsetMin = (typeof rawOffset === 'number' && rawOffset >= -840 && rawOffset <= 720) ? rawOffset : 0;
    const intervalStr = `${-offsetMin} minutes`;

    const localNow = new Date(Date.now() - offsetMin * 60000);
    const localYesterday = new Date(localNow.getTime() - 86400000);
    const yesterdayStr = `${localYesterday.getUTCFullYear()}-${String(localYesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(localYesterday.getUTCDate()).padStart(2, '0')}`;

    await db.transaction(async (client) => {
        const lastEntryRow = (await client.query(`
            SELECT entry_type, timestamp FROM time_entries
            WHERE user_id = $1 AND (timestamp + $2::interval)::date = $3::date
            ORDER BY timestamp DESC LIMIT 1
        `, [user.id, intervalStr, yesterdayStr])).rows[0];

        if (!lastEntryRow || lastEntryRow.entry_type === 'clock_out') return;

        const alreadyDone = (await client.query(`
            SELECT 1 FROM time_entries
            WHERE user_id = $1 AND entry_type = 'clock_out' AND (timestamp + $2::interval)::date = $3::date
            LIMIT 1
        `, [user.id, intervalStr, yesterdayStr])).rows[0];
        if (alreadyDone) return;

        const [y, m, d] = yesterdayStr.split('-').map(Number);
        const utcMs = Date.UTC(y, m - 1, d, 23, 59, 59) + offsetMin * 60000;
        const autoTs = new Date(utcMs).toISOString().slice(0, 19).replace('T', ' ');

        if (lastEntryRow.entry_type === 'break_start') {
            await client.query('INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES ($1, $2, $3)',
                [user.id, 'break_end', autoTs]);
        }
        await client.query('INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES ($1, $2, $3)',
            [user.id, 'clock_out', autoTs]);
        logger.info({ userId: user.id, date: yesterdayStr }, 'Auto clock-out applied');
    });
}

// Cleanup expired/used password reset tokens every hour (multi-tenant)
async function cleanupTokens() {
    try {
        const tenants = await listActiveTenants();
        for (const tenant of tenants) {
            try {
                const db = await getTenantPool(tenant.db_name, tenant.db_host);
                await db.query("DELETE FROM password_reset_tokens WHERE used = TRUE OR expires_at < NOW()");
            } catch (e) { logger.error({ tenantId: tenant.id, err: e }, 'Token cleanup error for tenant'); }
        }

        // Also clean up legacy master DB tokens (pre-migration)
        const masterDbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
        const masterCoveredByTenant = tenants.some(t => t.db_name === masterDbName);
        if (!masterCoveredByTenant) {
            try {
                await masterQuery("DELETE FROM password_reset_tokens WHERE used = TRUE OR expires_at < NOW()");
            } catch { /* table may not exist */ }
        }
    } catch (e) { logger.error({ err: e }, 'Token cleanup iteration error'); }
}

// SPA fallback: only serve index.html for navigation requests, not file/asset requests
app.get(/^[^.]*$/, (req, res, next) => {
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
        if (err) next(err);
    });
});

app.use((err, req, res, next) => {
    (req.log || logger).error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
});

// Export app for testing (supertest)
module.exports = { app };

// Only start the server when run directly (not when imported for tests)
if (require.main === module) {
    const http = require('http');
    (async () => {
        await initDB();
        redis.initRedis();
        const httpServer = http.createServer(app);
        setupWebSocket(httpServer);
        httpServer.listen(PORT, () => {
            logger.info({ port: PORT }, 'Server running');
        });

        initJobs({ autoClockOut, cleanupTokens });

        async function shutdown() {
            logger.info('Shutting down gracefully...');
            httpServer.close(async () => {
                await shutdownJobs();
                await redis.shutdown();
                await destroyAllPools();
                await pool.end();
                process.exit(0);
            });
            setTimeout(async () => { await shutdownJobs(); await redis.shutdown(); await destroyAllPools(); await pool.end(); process.exit(1); }, 5000);
        }
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    })();
}