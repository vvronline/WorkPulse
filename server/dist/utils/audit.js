"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAction = logAction;
exports.queryLogs = queryLogs;
const logger_1 = require("./logger");
/**
 * Write an audit log entry. Returns a Promise (can be awaited or ignored).
 */
function logAction(req, action, entityType, entityId = null, details = null) {
    const xff = req.headers["x-forwarded-for"];
    const rawIp = req.ip || (Array.isArray(xff) ? xff[0] : xff) || req.socket?.remoteAddress || null;
    const ip = rawIp === "::1" ? "127.0.0.1" : rawIp?.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
    const ua = req.headers["user-agent"] || null;
    const dbQuery = req.db?.query;
    if (!dbQuery) {
        logger_1.logger.error({ action, entityType, entityId }, "Audit log skipped — no DB context");
        return Promise.resolve();
    }
    return dbQuery(`INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        req.userOrgId || null,
        req.userId || null,
        action,
        entityType,
        entityId || null,
        details ? JSON.stringify(details) : null,
        ip,
        ua,
    ]).catch((e) => logger_1.logger.error({ err: e, action, entityType, entityId }, "Audit log write failed"));
}
/**
 * Query audit logs with filters. Returns { total, logs }.
 *
 * Synthetic Platform Inspector resolution
 * ───────────────────────────────────────
 * Rows whose `actor_username` matches `platform_inspector_<id>` were written
 * by a synthetic users row created on behalf of a platform admin during an
 * impersonation session (see `utils/impersonationApproval.getOrCreateInspectorUser`).
 * The synthetic row's display name is "<Inspector Name> (Platform Support)",
 * which is already useful — but for the auditor we additionally surface the
 * underlying `platform_users.full_name` / `username` so the trail is honest
 * about *who* the human behind the support badge was.
 *
 * platform_users lives in the master DB so we can't JOIN it from a tenant
 * pool; we batch-fetch the IDs after the main query instead.
 */
async function queryLogs(db, { orgId, actorId, entityType, entityId, action, from, to, limit: rawLimit = 100, offset = 0 }) {
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 500);
    const where = [];
    const params = [];
    let p = 1;
    if (orgId) {
        where.push(`al.org_id = $${p++}`);
        params.push(orgId);
    }
    if (actorId) {
        where.push(`al.actor_id = $${p++}`);
        params.push(actorId);
    }
    if (entityType) {
        where.push(`al.entity_type = $${p++}`);
        params.push(entityType);
    }
    if (entityId) {
        where.push(`al.entity_id = $${p++}`);
        params.push(entityId);
    }
    if (action) {
        where.push(`al.action = $${p++}`);
        params.push(action);
    }
    if (from) {
        where.push(`al.created_at >= $${p++}`);
        params.push(from);
    }
    if (to) {
        where.push(`al.created_at <= $${p++}`);
        params.push(to);
    }
    const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const countRes = await db.query(`SELECT COUNT(*) AS count FROM audit_logs al ${whereClause}`, params);
    const total = parseInt(String(countRes.rows[0].count), 10);
    const logsRes = await db.query(`SELECT al.*, u.username AS actor_username, u.full_name AS actor_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_id
         ${whereClause}
         ORDER BY al.created_at DESC
         LIMIT $${p++} OFFSET $${p++}`, [...params, limit, offset]);
    const logs = logsRes.rows;
    await annotateInspectorActors(logs);
    return { total, logs };
}
/**
 * Mutates the supplied audit-log rows in place, adding two fields when the
 * actor is a synthetic Platform Inspector:
 *   - actor_is_inspector        boolean
 *   - actor_inspector_real_name string|null   (platform admin's full_name)
 *   - actor_inspector_username  string|null   (platform admin's username)
 *
 * Safe to call with any mix of rows — non-inspector rows are left alone.
 * Failures (e.g. master DB unreachable) are swallowed so a stale lookup
 * never breaks the audit-log endpoint.
 */
async function annotateInspectorActors(rows) {
    if (!Array.isArray(rows) || rows.length === 0)
        return;
    const ids = new Set();
    for (const r of rows) {
        const m = typeof r.actor_username === "string"
            ? r.actor_username.match(/^platform_inspector_(\d+)$/)
            : null;
        if (m) {
            r.actor_is_inspector = true;
            ids.add(Number(m[1]));
        }
    }
    if (ids.size === 0)
        return;
    try {
        // Lazy require to avoid the circular `audit → db → audit` chain when
        // tests stub out db.js.
        const { masterQuery } = require("../db");
        const res = await masterQuery(`SELECT id, username, full_name FROM platform_users WHERE id = ANY($1::int[])`, [Array.from(ids)]);
        const byId = new Map(res.rows.map((r) => [Number(r.id), r]));
        for (const r of rows) {
            if (!r.actor_is_inspector)
                continue;
            const m = r.actor_username.match(/^platform_inspector_(\d+)$/);
            const real = m ? byId.get(Number(m[1])) : null;
            r.actor_inspector_real_name = real?.full_name || null;
            r.actor_inspector_username = real?.username || null;
        }
    }
    catch (e) {
        logger_1.logger.warn({ err: e.message }, "Inspector actor resolution failed; rows shown without real-name overlay");
    }
}
//# sourceMappingURL=audit.js.map