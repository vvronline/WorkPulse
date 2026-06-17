"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logPlatformAction = logPlatformAction;
exports.updatePlatformAuditLog = updatePlatformAuditLog;
exports.queryPlatformLogs = queryPlatformLogs;
const db_1 = require("../db");
const logger_1 = require("./logger");
/**
 * Write a platform audit log entry. Fire-and-forget safe — errors are caught.
 */
function normalizeIp(raw) {
    if (!raw)
        return null;
    if (raw === "::1")
        return "127.0.0.1";
    if (raw.startsWith("::ffff:"))
        return raw.slice(7);
    return raw;
}
function logPlatformAction(req, action, entityType, entityId = null, details = null, tenantId = null) {
    const xff = req.headers?.["x-forwarded-for"];
    const rawIp = req.ip || (Array.isArray(xff) ? xff[0] : xff) || req.socket?.remoteAddress;
    const ip = normalizeIp(rawIp);
    const ua = req.headers?.["user-agent"] || null;
    return (0, db_1.masterQuery)(`INSERT INTO platform_audit_logs (actor_id, action, entity_type, entity_id, tenant_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`, [
        req.userId || null,
        action,
        entityType,
        entityId || null,
        tenantId || null,
        details ? JSON.stringify(details) : null,
        ip,
        ua,
    ]).catch((e) => logger_1.logger.error({ err: e, action, entityType, entityId }, "Platform audit log write failed"));
}
/**
 * Update an existing audit log entry (e.g. to set ended_at and final details).
 */
function updatePlatformAuditLog(id, { ended_at, details }) {
    return (0, db_1.masterQuery)(`UPDATE platform_audit_logs SET ended_at = $1, details = $2 WHERE id = $3`, [ended_at, details ? JSON.stringify(details) : null, id]).catch((e) => logger_1.logger.error({ err: e, id }, "Platform audit log update failed"));
}
/**
 * Query platform audit logs with filters. Returns { total, logs }.
 */
async function queryPlatformLogs({ actorId, entityType, entityId, action, tenantId, from, to, limit: rawLimit = 50, offset = 0 }) {
    const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 500);
    const where = [];
    const params = [];
    let p = 1;
    if (actorId) {
        where.push(`pal.actor_id = $${p++}`);
        params.push(actorId);
    }
    if (entityType) {
        where.push(`pal.entity_type = $${p++}`);
        params.push(entityType);
    }
    if (entityId) {
        where.push(`pal.entity_id = $${p++}`);
        params.push(entityId);
    }
    if (action) {
        where.push(`pal.action = $${p++}`);
        params.push(action);
    }
    if (tenantId) {
        where.push(`pal.tenant_id = $${p++}`);
        params.push(tenantId);
    }
    if (from) {
        where.push(`pal.created_at >= $${p++}`);
        params.push(from);
    }
    if (to) {
        where.push(`pal.created_at <= $${p++}`);
        params.push(to);
    }
    const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const countRes = await (0, db_1.masterQuery)(`SELECT COUNT(*) AS count FROM platform_audit_logs pal ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count, 10);
    const logsRes = await (0, db_1.masterQuery)(`SELECT pal.*, pal.ended_at, pu.username AS actor_username, pu.full_name AS actor_name,
                t.org_name AS tenant_name, t.slug AS tenant_slug
         FROM platform_audit_logs pal
         LEFT JOIN platform_users pu ON pu.id = pal.actor_id
         LEFT JOIN tenants t ON t.id = pal.tenant_id
         ${whereClause}
         ORDER BY pal.created_at DESC
         LIMIT $${p++} OFFSET $${p++}`, [...params, limit, offset]);
    return { total, logs: logsRes.rows };
}
//# sourceMappingURL=platformAudit.js.map