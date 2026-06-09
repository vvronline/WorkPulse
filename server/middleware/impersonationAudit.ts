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
import type { Response, NextFunction } from "express";

interface SessionAction {
    type: "read" | "write";
    method: string;
    path: string;
    status: number;
    timestamp: string;
}

interface AuditSession {
    startedAt: Date;
    auditLogId: number | null;
    actions: SessionAction[];
}

// In-memory session store:  key = `${platformAdminId}:${tenantId}`
// value = { startedAt, actions: [ { method, path, status, timestamp } ] }
const sessions = new Map<string, AuditSession>();

// Routes to skip tracking (high-frequency polling / meta)
const SKIP_PATHS = [
    "/api/auth/refresh",
    "/api/notifications/unread-count",
    "/api/health",
    "/api/admin/tenants/", // skip the session-poll endpoint itself
];

function sessionKey(platformAdminId: number, tenantId: number | null | undefined): string {
    return `${platformAdminId}:${tenantId}`;
}

function startSession(platformAdminId: number, tenantId: number | null | undefined, auditLogId?: number | null): void {
    const key = sessionKey(platformAdminId, tenantId);
    sessions.set(key, { startedAt: new Date(), auditLogId: auditLogId || null, actions: [] });
}

function getSession(platformAdminId: number, tenantId: number | null | undefined): AuditSession | null {
    return sessions.get(sessionKey(platformAdminId, tenantId)) || null;
}

function endSession(platformAdminId: number, tenantId: number | null | undefined): AuditSession {
    const key = sessionKey(platformAdminId, tenantId);
    const session = sessions.get(key);
    sessions.delete(key);
    return session || { startedAt: new Date(), auditLogId: null, actions: [] };
}

interface ImpersonationAuditMiddleware {
    (req: any, res: Response, next: NextFunction): void;
    startSession: typeof startSession;
    getSession: typeof getSession;
    endSession: typeof endSession;
}

const impersonationAudit = function impersonationAudit(req: any, res: Response, next: NextFunction): void {
    res.on("finish", () => {
        if (!req.isImpersonated) return;

        // Skip noisy / meta endpoints
        if (SKIP_PATHS.some((p) => req.originalUrl.startsWith(p))) return;

        const isRead = ["GET", "HEAD", "OPTIONS"].includes(req.method);

        // Only track writes and meaningful read inspections
        if (isRead && !req.originalUrl.match(/\/(profile|tracker|leaves|tasks|sprints|admin|org|manager|chat|meetings|calendar|search|export)/)) {
            return;
        }

        const platformAdminId = req.impersonatedBy || req.userId;
        const key = sessionKey(platformAdminId, req.tenantId);
        const session = sessions.get(key);
        if (!session) return; // session not started yet (race on first request)

        session.actions.push({
            type: isRead ? "read" : "write",
            method: req.method,
            path: req.originalUrl.split("?")[0],
            status: res.statusCode,
            timestamp: new Date().toISOString(),
        });
    });

    next();
} as ImpersonationAuditMiddleware;

impersonationAudit.startSession = startSession;
impersonationAudit.getSession = getSession;
impersonationAudit.endSession = endSession;

export = impersonationAudit;