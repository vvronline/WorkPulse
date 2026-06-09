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
import type { Request } from "express";
import { logger } from "./logger";

interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount?: number;
}

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
}

interface AuditLogRow {
    actor_username?: string | null;
    actor_is_inspector?: boolean;
    actor_inspector_real_name?: string | null;
    actor_inspector_username?: string | null;
    [key: string]: unknown;
}

interface QueryLogsOptions {
    orgId?: number | null;
    actorId?: number | null;
    entityType?: string | null;
    entityId?: number | null;
    action?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
}

/**
 * Write an audit log entry. Returns a Promise (can be awaited or ignored).
 */
function logAction(
    req: Request,
    action: string,
    entityType: string,
    entityId: number | null = null,
    details: Record<string, unknown> | null = null,
): Promise<unknown> {
    const xff = req.headers["x-forwarded-for"];
    const rawIp = req.ip || (Array.isArray(xff) ? xff[0] : xff) || req.socket?.remoteAddress || null;
    const ip = rawIp === "::1" ? "127.0.0.1" : rawIp?.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
    const ua = req.headers["user-agent"] || null;
    const dbQuery = req.db?.query;
    if (!dbQuery) {
        logger.error({ action, entityType, entityId }, "Audit log skipped — no DB context");
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
    ).catch((e: unknown) => logger.error({ err: e, action, entityType, entityId }, "Audit log write failed"));
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
async function queryLogs(
    db: DbLike,
    { orgId, actorId, entityType, entityId, action, from, to, limit: rawLimit = 100, offset = 0 }: QueryLogsOptions,
): Promise<{ total: number; logs: AuditLogRow[] }> {
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (orgId) { where.push(`al.org_id = $${p++}`); params.push(orgId); }
    if (actorId) { where.push(`al.actor_id = $${p++}`); params.push(actorId); }
    if (entityType) { where.push(`al.entity_type = $${p++}`); params.push(entityType); }
    if (entityId) { where.push(`al.entity_id = $${p++}`); params.push(entityId); }
    if (action) { where.push(`al.action = $${p++}`); params.push(action); }
    if (from) { where.push(`al.created_at >= $${p++}`); params.push(from); }
    if (to) { where.push(`al.created_at <= $${p++}`); params.push(to); }

    const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

    const countRes = await db.query(
        `SELECT COUNT(*) AS count FROM audit_logs al ${whereClause}`,
        params,
    );
    const total = parseInt(String(countRes.rows[0].count), 10);

    const logsRes = await db.query(
        `SELECT al.*, u.username AS actor_username, u.full_name AS actor_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_id
         ${whereClause}
         ORDER BY al.created_at DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, limit, offset],
    );

    const logs = logsRes.rows as AuditLogRow[];
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
async function annotateInspectorActors(rows: AuditLogRow[]): Promise<void> {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const ids = new Set<number>();
    for (const r of rows) {
        const m = typeof r.actor_username === "string"
            ? r.actor_username.match(/^platform_inspector_(\d+)$/)
            : null;
        if (m) {
            r.actor_is_inspector = true;
            ids.add(Number(m[1]));
        }
    }
    if (ids.size === 0) return;

    try {
        // Lazy require to avoid the circular `audit → db → audit` chain when
        // tests stub out db.js.
        const { masterQuery } = require("../db");
        const res = await masterQuery(
            `SELECT id, username, full_name FROM platform_users WHERE id = ANY($1::int[])`,
            [Array.from(ids)],
        );
        const byId = new Map<number, { id: number; username: string; full_name: string }>(
            res.rows.map((r: { id: number; username: string; full_name: string }) => [Number(r.id), r]),
        );
        for (const r of rows) {
            if (!r.actor_is_inspector) continue;
            const m = (r.actor_username as string).match(/^platform_inspector_(\d+)$/);
            const real = m ? byId.get(Number(m[1])) : null;
            r.actor_inspector_real_name = real?.full_name || null;
            r.actor_inspector_username = real?.username || null;
        }
    } catch (e: unknown) {
        logger.warn({ err: (e as Error).message }, "Inspector actor resolution failed; rows shown without real-name overlay");
    }
}

export { logAction, queryLogs };