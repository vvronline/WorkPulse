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
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { pool, initDB, query, transaction } = require('./db');
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
const { setupWebSocket } = require('./utils/ws');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            // Automatically enforce HTTPS upgrades in production (Caddy handles TLS)
            "upgrade-insecure-requests": isProduction ? [] : null,
        }
    },
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    permissionsPolicy: {
        features: {
            microphone: ['self'],
        }
    }
}));

// Serve React static files BEFORE cors/auth — assets don't need CORS
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (process.env.CORS_ORIGIN) {
            const allowed = process.env.CORS_ORIGIN.split(',').map(s => s.trim());
            if (allowed.includes(origin)) return callback(null, true);
            return callback(new Error('Not allowed by CORS'));
        }
        if (process.env.NODE_ENV === 'production') {
            // Allow same-origin requests (SPA served by this server)
            const selfOrigins = [`http://localhost:${PORT}`, 'http://localhost', 'https://localhost'];
            if (selfOrigins.includes(origin)) return callback(null, true);
            return callback(new Error('Not allowed by CORS'));
        }
        const serverOrigin = `http://localhost:${PORT}`;
        if (origin === serverOrigin) return callback(null, true);
        const devOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:5173'];
        if (devOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(cookieParser());
app.use('/api/notes', express.json({ limit: '5mb' }));
app.use('/api/profile/avatar', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));

// Structured request logging with request IDs
app.use(requestLogger);

const authMiddleware = require('./middleware/auth');
app.use('/uploads', authMiddleware, (req, res, next) => {
    const resolved = path.resolve(__dirname, 'uploads', req.path.replace(/^\//, ''));
    if (!resolved.startsWith(path.resolve(__dirname, 'uploads'))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}, express.static(path.join(__dirname, 'uploads')));

app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const xrw = req.headers['x-requested-with'];
    if (xrw === 'WorkPulse') return next();
    return res.status(403).json({ error: 'Missing CSRF header' });
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many attempts. Please try again later.' } });
const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many password reset attempts. Please try again later.' } });
const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many password attempts. Please try again later.' } });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5000, message: { error: 'Too many requests. Please try again later.' } });

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
app.use('/api/manager', apiLimiter, managerRoutes);
app.use('/api/leave-policy', apiLimiter, leavePolicyRoutes);
app.use('/api/notes', apiLimiter, notesRoutes);
app.use('/api/calendar', apiLimiter, calendarRoutes);
app.use('/api/notifications', apiLimiter, notificationsRoutes);
app.use('/api/export', apiLimiter, exportRoutes);
app.use('/api/chat', apiLimiter, chatRoutes);
app.use('/api/search', apiLimiter, searchRoutes);

app.get('/api/health', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({ status: 'ok', time: new Date().toISOString() });
    } catch (err) {
        logger.error({ err }, 'Health check DB ping failed');
        res.status(503).json({ status: 'error', time: new Date().toISOString(), error: 'Database unreachable' });
    }
});

// ============= AUTO CLOCK-OUT =============
async function autoClockOut() {
    try {
        // Use DISTINCT ON to efficiently find each user's latest time entry,
        // then filter only those whose last entry is not a clock_out.
        // This avoids O(N) correlated subqueries for large user bases.
        const activeUsers = (await query(`
            SELECT u.id, u.timezone_offset
            FROM users u
            INNER JOIN LATERAL (
                SELECT entry_type FROM time_entries t
                WHERE t.user_id = u.id
                ORDER BY t.timestamp DESC
                LIMIT 1
            ) latest ON latest.entry_type != 'clock_out'
        `)).rows;

        for (const user of activeUsers) {
            try {
                await autoClockOutUser(user);
            } catch (e) {
                logger.error({ userId: user.id, err: e }, 'Auto clock-out failed');
            }
        }
    } catch (e) {
        logger.error({ err: e }, 'autoClockOut query error');
    }
}

async function autoClockOutUser(user) {
    const rawOffset = user.timezone_offset || 0;
    // Clamp to valid timezone range: UTC-12 (720) to UTC+14 (-840)
    const offsetMin = (typeof rawOffset === 'number' && rawOffset >= -840 && rawOffset <= 720) ? rawOffset : 0;
    const intervalStr = `${-offsetMin} minutes`;

    const localNow = new Date(Date.now() - offsetMin * 60000);
    const localYesterday = new Date(localNow.getTime() - 86400000);
    const yesterdayStr = `${localYesterday.getUTCFullYear()}-${String(localYesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(localYesterday.getUTCDate()).padStart(2, '0')}`;

    await transaction(async (client) => {
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

// Cleanup expired/used password reset tokens every hour
async function cleanupTokens() {
    try {
        await query("DELETE FROM password_reset_tokens WHERE used = TRUE OR expires_at < NOW()");
    } catch (e) { logger.error({ err: e }, 'Token cleanup error'); }
}

// SPA fallback: only serve index.html for navigation requests, not file/asset requests
app.get(/^[^.]*$/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
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
        const httpServer = http.createServer(app);
        setupWebSocket(httpServer);
        httpServer.listen(PORT, () => {
            logger.info({ port: PORT }, 'Server running');
        });

        autoClockOut();
        setInterval(autoClockOut, 5 * 60 * 1000);
        setInterval(cleanupTokens, 60 * 60 * 1000);

        async function shutdown() {
            logger.info('Shutting down gracefully...');
            httpServer.close(async () => {
                await pool.end();
                process.exit(0);
            });
            setTimeout(async () => { await pool.end(); process.exit(1); }, 5000);
        }
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    })();
}