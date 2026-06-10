import type { Request, Response, NextFunction } from "express";
const jwt = require("jsonwebtoken");
import { logger } from "../utils/logger";
import * as redis from "../redis";
import { masterQuery } from "../db";

// ── Impersonation revocation cache ────────────────────────────────────────
// Cache the per-request liveness check for an access-request row for 10s so
// the master DB doesn't get hammered during a busy impersonation session.
// 10s is short enough that a tenant revoke takes effect almost immediately.
const _impCache = new Map<number, { allowed: boolean; expiresAt: number }>();   // requestId -> { allowed, expiresAt }
const IMP_CACHE_TTL_MS = 10_000;

async function checkImpersonationStillAllowed(requestId: number): Promise<boolean> {
    const now = Date.now();
    const cached = _impCache.get(requestId);
    if (cached && cached.expiresAt > now) return cached.allowed;

    const row = (await masterQuery(
        `SELECT status, revoked_at, session_ends_at
           FROM tenant_access_requests WHERE id = $1`,
        [requestId],
    )).rows[0];

    let allowed = true;
    if (!row) {
        allowed = false;
    } else if (row.status === "revoked" || row.revoked_at) {
        allowed = false;
    } else if (row.session_ends_at && new Date(row.session_ends_at) < new Date(now)) {
        allowed = false;
    }

    _impCache.set(requestId, { allowed, expiresAt: now + IMP_CACHE_TTL_MS });
    // Bound the cache to avoid an unbounded growth in pathological cases.
    if (_impCache.size > 1000) {
        const oldest = _impCache.keys().next().value;
        if (oldest !== undefined) _impCache.delete(oldest);
    }
    return allowed;
}

async function authMiddleware(req: any, res: Response, next: NextFunction): Promise<void | Response> {
    // Web/desktop clients send the JWT in an HttpOnly cookie. Native mobile
    // clients (React Native) can't manage cookies easily, so fall back to an
    // `Authorization: Bearer <jwt>` header. Cookie takes precedence.
    const authHeader = req.headers?.authorization;
    const token =
        req.cookies.token ||
        (typeof authHeader === "string" && authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null);
    if (!token) {
        return res.status(401).json({ error: "No token provided" });
    }
    try {
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET);
        const tokenVersion = decoded.tv ?? 0;
        const isPlatformUser = !!decoded.platform;
        const isVirtualImpersonation = !!decoded.impersonated && !!decoded.is_virtual;
        // A platform_admin with a tenant_id has a linked user record in the tenant DB.
        // Token version should be checked against the tenant's users table, not platform_users.
        const hasTenantContext = !!decoded.tenant_id;

        // req.db is set by tenant middleware (or falls back to master DB)
        const dbQuery = req.db?.query;
        if (!dbQuery) {
            return res.status(500).json({ error: "Database context not available" });
        }

        // Skip token version & session checks for virtual impersonation (no real user in tenant)
        if (!isVirtualImpersonation) {
            // Try Redis cache first for token version check
            const tenantId = decoded.tenant_id || null;
            let dbTokenVersion = await redis.getTokenVersion(tenantId, decoded.id);
            if (dbTokenVersion === null) {
                const result = (isPlatformUser && !hasTenantContext)
                    ? await dbQuery("SELECT token_version FROM platform_users WHERE id = $1", [decoded.id])
                    : await dbQuery("SELECT token_version FROM users WHERE id = $1", [decoded.id]);
                const user = result.rows[0];
                if (!user) {
                    return res.status(401).json({ error: "User no longer exists" });
                }
                dbTokenVersion = user.token_version || 0;
                await redis.setTokenVersion(tenantId, decoded.id, dbTokenVersion as number);
            }

            if (tokenVersion !== dbTokenVersion) {
                return res.status(401).json({ error: "Session expired. Please sign in again." });
            }

            // Validate session is still active (single-device enforcement)
            if (decoded.sid) {
                let sessions = await redis.getUserSessions(tenantId, decoded.id) as string[] | null;
                if (sessions === null) {
                    const sessRes = await dbQuery("SELECT id FROM user_sessions WHERE user_id = $1", [decoded.id]);
                    sessions = sessRes.rows.map((r: any) => r.id);
                    await redis.setUserSessions(tenantId, decoded.id, sessions);
                }
                if (!sessions!.includes(decoded.sid)) {
                    return res.status(401).json({ error: "Session ended. You may have signed in on another device." });
                }
            }
        } // end !isVirtualImpersonation

        req.userId = decoded.id;
        req.username = decoded.username;
        req.sessionId = decoded.sid || null;
        req.tenantId = decoded.tenant_id || null;
        req.isPlatformUser = isPlatformUser;
        req.isImpersonated = !!decoded.impersonated;
        req.impersonatedBy = decoded.impersonated_by || null;
        req.impersonatedTenantName = decoded.impersonated_tenant_name || null;
        req.accessRequestId = decoded.access_request_id || null;

        // ── Impersonation session revocation check ──
        // If this is an impersonation token tied to a tenant_access_requests
        // row, verify the row hasn't been revoked / expired. We use a
        // tiny in-memory TTL cache so we don't hit the master DB on every
        // request during a long session (10 second TTL is plenty — a
        // revocation is meant to kill activity *promptly*, not instantly).
        if (req.isImpersonated && decoded.access_request_id) {
            try {
                const allowed = await checkImpersonationStillAllowed(decoded.access_request_id);
                if (!allowed) {
                    return res.status(401).json({
                        error: "Your impersonation session was revoked by the tenant.",
                        code: "IMPERSONATION_REVOKED",
                    });
                }
            } catch (e: any) {
                logger.warn({ err: e.message }, "auth: failed to verify impersonation session");
            }
        }
        next();
    } catch (err: any) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token expired. Please sign in again." });
        }
        if (err.name === "JsonWebTokenError") {
            return res.status(401).json({ error: "Invalid token" });
        }
        logger.error({ err, tokenError: err.name }, "Auth middleware error");
        return res.status(401).json({ error: "Authentication failed" });
    }
}

export = authMiddleware;