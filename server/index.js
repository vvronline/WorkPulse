const path = require('path');
const fs = require('fs');

// Load environment variables (.env file is optional in Docker)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
} else {
    // Also try root directory (Docker compose style)
    require('dotenv').config();
}

// Ensure JWT_SECRET is set — tokens are insecure without it
if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is not set. Server cannot start.');
    process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const db = require('./db');
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
const notificationsRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "upgrade-insecure-requests": null, // Disable forcing HTTPS
        }
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    originAgentCluster: false
}));
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        // Check explicit allowlist from CORS_ORIGIN env var
        if (process.env.CORS_ORIGIN) {
            const allowed = process.env.CORS_ORIGIN.split(',').map(s => s.trim());
            if (allowed.includes(origin)) return callback(null, true);
        }

        // In production the SPA is served from the same Express server,
        // and CSRF is already guarded by the X-Requested-With header.
        if (process.env.NODE_ENV === 'production') return callback(null, true);

        // Allow same-origin (SPA served by this Express server)
        const serverOrigin = `http://localhost:${PORT}`;
        if (origin === serverOrigin) return callback(null, true);

        // Development defaults
        const devOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:5173'];
        if (devOrigins.includes(origin)) return callback(null, true);

        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(cookieParser());
// Higher body limits for specific routes (must be before global parser)
app.use('/api/notes', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));

// --- DEBUG LOGGING (dev only) ---
if (process.env.NODE_ENV !== 'production') {
    app.use('/api', (req, res, next) => {
        console.log(`[DEBUG] ${req.method} ${req.url}`);
        next();
    });
}

// Serve uploaded avatars behind authentication
const authMiddleware = require('./middleware/auth');
app.use('/uploads', authMiddleware, (req, res, next) => {
    // Validate the resolved path stays within the uploads directory
    const resolved = path.resolve(__dirname, 'uploads', req.path.replace(/^\//, ''));
    if (!resolved.startsWith(path.resolve(__dirname, 'uploads'))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}, express.static(path.join(__dirname, 'uploads')));

// CSRF protection: require custom header on state-changing requests
// Browsers won't send custom headers cross-origin without CORS preflight
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const xrw = req.headers['x-requested-with'];
    if (xrw === 'WorkPulse') return next();
    return res.status(403).json({ error: 'Missing CSRF header' });
});

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many attempts. Please try again later.' }
});

// Stricter rate limiting for forgot-password (prevent email enumeration brute-force)
const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many password reset attempts. Please try again later.' }
});

// Stricter rate limiting for password-related endpoints
const passwordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many password attempts. Please try again later.' }
});

// General rate limiter for API routes
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5000,
    message: { error: 'Too many requests. Please try again later.' }
});

// Routes
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tracker', apiLimiter, trackerRoutes);
app.use('/api/leaves', apiLimiter, leaveRoutes);
app.use('/api/tasks', apiLimiter, taskRoutes);
app.use('/api/sprints', apiLimiter, sprintsRoutes);
// Apply higher body limit only for avatar upload
app.use('/api/profile/avatar', express.json({ limit: '10mb' }));
app.use('/api/profile/password', passwordLimiter);
app.use('/api/profile', apiLimiter, profileRoutes);
app.use('/api/org', apiLimiter, organizationRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/manager', apiLimiter, managerRoutes);
app.use('/api/leave-policy', apiLimiter, leavePolicyRoutes);
app.use('/api/notes', apiLimiter, notesRoutes);
app.use('/api/notifications', apiLimiter, notificationsRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ============= AUTO LOGOUT =============
// Check for users who forgot to logout yesterday (uses per-user stored timezone)
function autoClockOut() {
    // Only process users whose latest time entry is NOT a clock_out
    const activeUsers = db.prepare(`
        SELECT u.id, u.timezone_offset 
        FROM users u
        WHERE EXISTS (
            SELECT 1 FROM time_entries t
            WHERE t.user_id = u.id
            AND t.entry_type != 'clock_out'
            AND t.timestamp = (
                SELECT MAX(t2.timestamp) FROM time_entries t2 WHERE t2.user_id = u.id
            )
        )
    `).all();
    const insert = db.prepare('INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES (?, ?, ?)');

    const autoClockOutUser = db.transaction((user) => {
        const offsetMin = user.timezone_offset || 0;
        const shift = -offsetMin;
        const tzMod = `${shift >= 0 ? '+' : ''}${shift} minutes`;

        // Compute "yesterday" in the user's local timezone (avoid toISOString UTC shift)
        const localNow = new Date(Date.now() - offsetMin * 60000);
        const localYesterday = new Date(localNow.getTime() - 86400000);
        const yesterdayStr = `${localYesterday.getUTCFullYear()}-${String(localYesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(localYesterday.getUTCDate()).padStart(2, '0')}`;

        // Re-verify inside transaction: find the last entry for yesterday
        const lastEntry = db.prepare(`
            SELECT entry_type, timestamp FROM time_entries
            WHERE user_id = ? AND date(timestamp, ?) = date(?)
            ORDER BY timestamp DESC LIMIT 1
        `).get(user.id, tzMod, yesterdayStr);

        if (lastEntry && lastEntry.entry_type !== 'clock_out') {
            // Idempotency: check that an auto clock_out for this day doesn't already exist
            const alreadyDone = db.prepare(`
                SELECT 1 FROM time_entries
                WHERE user_id = ? AND entry_type = 'clock_out' AND date(timestamp, ?) = date(?)
                LIMIT 1
            `).get(user.id, tzMod, yesterdayStr);
            if (alreadyDone) return;
            // Compute UTC timestamp for 23:59:59 in user's local timezone
            const [y, m, d] = yesterdayStr.split('-').map(Number);
            const utcMs = Date.UTC(y, m - 1, d, 23, 59, 59) + offsetMin * 60000;
            const autoTs = new Date(utcMs).toISOString().slice(0, 19).replace('T', ' ');

            if (lastEntry.entry_type === 'break_start') {
                insert.run(user.id, 'break_end', autoTs);
            }
            insert.run(user.id, 'clock_out', autoTs);
            console.log(`Auto-logged out user ${user.id} for ${yesterdayStr} (local)`);
        }
    });

    for (const user of activeUsers) {
        try {
            autoClockOutUser(user);
        } catch (e) {
            console.error(`Auto clock-out failed for user ${user.id}:`, e.message);
        }
    }
}

autoClockOut();
setInterval(autoClockOut, 5 * 60 * 1000);

// Cleanup expired/used password reset tokens every hour
setInterval(() => {
    try {
        db.prepare("DELETE FROM password_reset_tokens WHERE used = 1 OR expires_at < datetime('now')").run();
    } catch (e) { console.error('Token cleanup error:', e.message); }
}, 60 * 60 * 1000);

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
});

// Global error handler (must be registered AFTER all routes/static handlers)
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown — close SQLite cleanly to prevent WAL corruption
function shutdown() {
    console.log('Shutting down gracefully...');
    server.close(() => {
        db.close();
        process.exit(0);
    });
    // Force exit after 5 seconds if server doesn't close
    setTimeout(() => { db.close(); process.exit(1); }, 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
