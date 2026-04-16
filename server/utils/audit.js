/**
 * Audit logging utility.
 * Records every significant action for compliance and traceability.
 *
 * Usage:
 *   const { logAction } = require('../utils/audit');
 *   logAction(req, 'create', 'leave', leave.id, { date, leave_type });
 *
 * logAction returns a Promise. For fire-and-forget usage the caller can ignore it,
 * but for compliance-critical operations (role changes, deletions) the caller
 * should await it.  Errors are always caught so the main flow is never broken.
 */
const { logger } = require('./logger');

/**
 * Write an audit log entry. Returns a Promise (can be awaited or ignored).
 */
function logAction(req, action, entityType, entityId = null, details = null) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;
    const dbQuery = req.db?.query;
    if (!dbQuery) {
        logger.error({ action, entityType, entityId }, 'Audit log skipped — no DB context');
        return Promise.resolve();
    }
    return dbQuery(
        `INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            req.userOrgId || null,
            req.userId || null,
            action,
            entityType,
            entityId || null,
            details ? JSON.stringify(details) : null,
            ip,
            ua,
        ],
    ).catch(e => logger.error({ err: e, action, entityType, entityId }, 'Audit log write failed'));
}

/**
 * Query audit logs with filters. Returns { total, logs }.
 */
async function queryLogs(db, { orgId, actorId, entityType, entityId, action, from, to, limit: rawLimit = 100, offset = 0 }) {
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 500);
    const where = [];
    const params = [];
    let p = 1;

    if (orgId) { where.push(`al.org_id = $${p++}`); params.push(orgId); }
    if (actorId) { where.push(`al.actor_id = $${p++}`); params.push(actorId); }
    if (entityType) { where.push(`al.entity_type = $${p++}`); params.push(entityType); }
    if (entityId) { where.push(`al.entity_id = $${p++}`); params.push(entityId); }
    if (action) { where.push(`al.action = $${p++}`); params.push(action); }
    if (from) { where.push(`al.created_at >= $${p++}`); params.push(from); }
    if (to) { where.push(`al.created_at <= $${p++}`); params.push(to); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await db.query(
        `SELECT COUNT(*) AS count FROM audit_logs al ${whereClause}`,
        params,
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const logsRes = await db.query(
        `SELECT al.*, u.username AS actor_username, u.full_name AS actor_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_id
         ${whereClause}
         ORDER BY al.created_at DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, limit, offset],
    );

    return { total, logs: logsRes.rows };
}

module.exports = { logAction, queryLogs };
