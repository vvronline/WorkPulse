const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { logger } = require('../utils/logger');

async function authMiddleware(req, res, next) {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Verify token hasn't been invalidated by a password change/reset
        const result = await query('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'User no longer exists' });
        }
        const tokenVersion = decoded.tv ?? 0;
        if (tokenVersion !== (user.token_version || 0)) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }

        req.userId = decoded.id;
        req.username = decoded.username;
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
