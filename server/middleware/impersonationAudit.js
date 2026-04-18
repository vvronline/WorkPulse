/**
 * Impersonation Audit Middleware
 *
 * Tracks API actions in-memory during impersonation sessions.
 * No per-request DB writes — a single consolidated audit entry
 * is written when the session ends (via the exit-impersonate route).
 *
 * The in-memory store is exported so the session/exit endpoints can
 * read and flush it.
 */

// In-memory session store:  key = `${platformAdminId}:${tenantId}`
// value = { startedAt, actions: [ { method, path, status, timestamp } ] }
const sessions = new Map();

// Routes to skip tracking (high-frequency polling / meta)
const SKIP_PATHS = [
    '/api/auth/refresh',
    '/api/notifications/unread-count',
    '/api/health',
    '/api/admin/tenants/', // skip the session-poll endpoint itself
];

function sessionKey(platformAdminId, tenantId) {
    return `${platformAdminId}:${tenantId}`;
}

function startSession(platformAdminId, tenantId, auditLogId) {
    const key = sessionKey(platformAdminId, tenantId);
    sessions.set(key, { startedAt: new Date(), auditLogId: auditLogId || null, actions: [] });
}

function getSession(platformAdminId, tenantId) {
    return sessions.get(sessionKey(platformAdminId, tenantId)) || null;
}

function endSession(platformAdminId, tenantId) {
    const key = sessionKey(platformAdminId, tenantId);
    const session = sessions.get(key);
    sessions.delete(key);
    return session || { startedAt: new Date(), auditLogId: null, actions: [] };
}

function impersonationAudit(req, res, next) {
    res.on('finish', () => {
        if (!req.isImpersonated) return;

        // Skip noisy / meta endpoints
        if (SKIP_PATHS.some(p => req.originalUrl.startsWith(p))) return;

        const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

        // Only track writes and meaningful read inspections
        if (isRead && !req.originalUrl.match(/\/(profile|tracker|leaves|tasks|sprints|admin|org|manager|chat|meetings|calendar|search|export)/)) {
            return;
        }

        const platformAdminId = req.impersonatedBy || req.userId;
        const key = sessionKey(platformAdminId, req.tenantId);
        const session = sessions.get(key);
        if (!session) return; // session not started yet (race on first request)

        session.actions.push({
            type: isRead ? 'read' : 'write',
            method: req.method,
            path: req.originalUrl.split('?')[0],
            status: res.statusCode,
            timestamp: new Date().toISOString(),
        });
    });

    next();
}

module.exports = impersonationAudit;
module.exports.startSession = startSession;
module.exports.getSession = getSession;
module.exports.endSession = endSession;
