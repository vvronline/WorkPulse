const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

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
        const allowed = process.env.CORS_ORIGIN
            ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
            : ['http://localhost:3000', 'http://localhost:3001'];
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin || allowed.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// --- DEBUG LOGGING (dev only) ---
if (process.env.NODE_ENV !== 'production') {
    app.use('/api', (req, res, next) => {
        console.log(`[DEBUG] ${req.method} ${req.url}`);
        next();
    });
}

// Serve uploaded avatars
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many attempts. Please try again later.' }
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
    max: 300,
    message: { error: 'Too many requests. Please try again later.' }
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tracker', apiLimiter, trackerRoutes);
app.use('/api/leaves', apiLimiter, leaveRoutes);
app.use('/api/tasks', apiLimiter, taskRoutes);
app.use('/api/profile/password', passwordLimiter);
app.use('/api/profile', apiLimiter, profileRoutes);
app.use('/api/org', apiLimiter, organizationRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/manager', apiLimiter, managerRoutes);
app.use('/api/leave-policy', apiLimiter, leavePolicyRoutes);

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
        JOIN (
            SELECT user_id, entry_type 
            FROM time_entries 
            WHERE id IN (
                SELECT MAX(id) FROM time_entries GROUP BY user_id
            )
        ) latest ON u.id = latest.user_id
        WHERE latest.entry_type != 'clock_out'
    `).all();
    const insert = db.prepare('INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES (?, ?, ?)');

    for (const user of activeUsers) {
        const offsetMin = user.timezone_offset || 0;
        const shift = -offsetMin;
        const tzMod = `${shift >= 0 ? '+' : ''}${shift} minutes`;

        // Compute "yesterday" in the user's local timezone
        const localNow = new Date(Date.now() - offsetMin * 60000);
        const localYesterday = new Date(localNow.getTime() - 86400000);
        const yesterdayStr = localYesterday.toISOString().slice(0, 10);

        // Find the last entry for yesterday (in user's local timezone)
        const lastEntry = db.prepare(`
            SELECT entry_type, timestamp FROM time_entries
            WHERE user_id = ? AND date(timestamp, ?) = date(?)
            ORDER BY timestamp DESC LIMIT 1
        `).get(user.id, tzMod, yesterdayStr);

        if (lastEntry && lastEntry.entry_type !== 'clock_out') {
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

// Global error handler (must be registered BEFORE static/SPA fallback)
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
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
