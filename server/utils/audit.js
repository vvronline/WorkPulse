/**
 * Audit logging utility.
 * Records every significant action for compliance and traceability.
 *
 * Usage:
 *   const { logAction } = require('../utils/audit');
 *   logAction(req, 'create', 'leave', leave.id, { date, leave_type });
 */
const db = require('../db');

const insertStmt = db.prepare(`
    INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, details, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Log an action to the audit trail.
 *
 * @param {object} req - Express request (must have userId, userOrgId after auth+rbac middleware)
 * @param {string} action - e.g. 'create', 'update', 'delete', 'approve', 'reject', 'clock_in', 'login'
 * @param {string} entityType - e.g. 'user', 'leave', 'time_entry', 'task', 'team', 'department', 'org', 'leave_policy', 'holiday'
 * @param {number|null} entityId - ID of the affected entity
 * @param {object|null} details - Additional context (JSON-serialisable)
 */
function logAction(req, action, entityType, entityId = null, details = null) {
    try {
        const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
        const ua = req.headers['user-agent'] || null;
        insertStmt.run(
            req.userOrgId || null,
            req.userId || null,
            action,
            entityType,
            entityId,
            details ? JSON.stringify(details) : null,
            ip,
            ua
        );
    } catch (e) {
        // Never let audit logging break the main flow
        console.error('Audit log error:', e.message);
    }
}

/**
 * Query audit logs with filters.
 */
function queryLogs({ orgId, actorId, entityType, entityId, action, from, to, limit = 100, offset = 0 }) {
    let where = [];
    let params = [];

    if (orgId) { where.push('org_id = ?'); params.push(orgId); }
    if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
    if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
    if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
    if (action) { where.push('action = ?'); params.push(action); }
    if (from) { where.push('created_at >= ?'); params.push(from); }
    if (to) { where.push('created_at <= ?'); params.push(to); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const total = db.prepare(`SELECT COUNT(*) as count FROM audit_logs ${whereClause}`).get(...params).count;

    const logs = db.prepare(`
        SELECT al.*, u.username as actor_username, u.full_name as actor_name
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.actor_id
        ${whereClause}
        ORDER BY al.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return { total, logs };
}

module.exports = { logAction, queryLogs };
