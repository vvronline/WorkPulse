const jwt = require('jsonwebtoken');
const db = require('../db');

function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const token = header.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Verify token hasn't been invalidated by a password change/reset
        const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get(decoded.id);
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
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

module.exports = authMiddleware;
