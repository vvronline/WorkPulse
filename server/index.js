const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const authRoutes = require('./routes/auth');
const trackerRoutes = require('./routes/tracker');
const leaveRoutes = require('./routes/leaves');
const taskRoutes = require('./routes/tasks');
const profileRoutes = require('./routes/profile');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '1mb' }));

// Serve uploaded avatars
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many attempts. Please try again later.' }
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tracker', trackerRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/profile', profileRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ============= AUTO LOGOUT =============
// Check for users who forgot to logout yesterday (uses per-user stored timezone)
function autoClockOut() {
    const users = db.prepare('SELECT id, timezone_offset FROM users').all();
    const insert = db.prepare('INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES (?, ?, ?)');

    for (const user of users) {
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

// Run auto logout on startup and every 5 minutes
autoClockOut();
setInterval(autoClockOut, 5 * 60 * 1000);

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
});

// Global error handler (must be registered BEFORE app.listen)
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
