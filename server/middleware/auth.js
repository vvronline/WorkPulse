const jwt = require('jsonwebtoken');
const { logger } = require('../utils/logger');
const redis = require('../redis');

async function authMiddleware(req, res, next) {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const tokenVersion = decoded.tv ?? 0;
        const isPlatformUser = !!decoded.platform;
        // A platform_admin with a tenant_id has a linked user record in the tenant DB.
        // Token version should be checked against the tenant's users table, not platform_users.
        const hasTenantContext = !!decoded.tenant_id;

        // req.db is set by tenant middleware (or falls back to master DB)
        const dbQuery = req.db?.query;
        if (!dbQuery) {
            return res.status(500).json({ error: 'Database context not available' });
        }

        // Try Redis cache first for token version check
        let dbTokenVersion = await redis.getTokenVersion(decoded.id);
        if (dbTokenVersion === null) {
            const result = (isPlatformUser && !hasTenantContext)
                ? await dbQuery('SELECT token_version FROM platform_users WHERE id = $1', [decoded.id])
                : await dbQuery('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
            const user = result.rows[0];
            if (!user) {
                return res.status(401).json({ error: 'User no longer exists' });
            }
            dbTokenVersion = user.token_version || 0;
            await redis.setTokenVersion(decoded.id, dbTokenVersion);
        }

        if (tokenVersion !== dbTokenVersion) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }

        // Validate session is still active (max-2-device enforcement)
        if (decoded.sid) {
            let sessions = await redis.getUserSessions(decoded.id);
            if (sessions === null) {
                const sessRes = await dbQuery('SELECT id FROM user_sessions WHERE user_id = $1', [decoded.id]);
                sessions = sessRes.rows.map(r => r.id);
                await redis.setUserSessions(decoded.id, sessions);
            }
            if (!sessions.includes(decoded.sid)) {
                return res.status(401).json({ error: 'Session ended. You may have signed in on another device.' });
            }
        }

        req.userId = decoded.id;
        req.username = decoded.username;
        req.sessionId = decoded.sid || null;
        req.tenantId = decoded.tenant_id || null;
        req.isPlatformUser = isPlatformUser;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please sign in again.' });
        }
        if (err.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        logger.error({ err, tokenError: err.name }, 'Auth middleware error');
        return res.status(401).json({ error: 'Authentication failed' });
    }
}

module.exports = authMiddleware;
