"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
const jwt = require("jsonwebtoken");
const logger_1 = require("../utils/logger");
const redis = __importStar(require("../redis"));
const db_1 = require("../db");
// ── Impersonation revocation cache ────────────────────────────────────────
// Cache the per-request liveness check for an access-request row for 10s so
// the master DB doesn't get hammered during a busy impersonation session.
// 10s is short enough that a tenant revoke takes effect almost immediately.
const _impCache = new Map(); // requestId -> { allowed, expiresAt }
const IMP_CACHE_TTL_MS = 10_000;
async function checkImpersonationStillAllowed(requestId) {
    const now = Date.now();
    const cached = _impCache.get(requestId);
    if (cached && cached.expiresAt > now)
        return cached.allowed;
    const row = (await (0, db_1.masterQuery)(`SELECT status, revoked_at, session_ends_at
           FROM tenant_access_requests WHERE id = $1`, [requestId])).rows[0];
    let allowed = true;
    if (!row) {
        allowed = false;
    }
    else if (row.status === "revoked" || row.revoked_at) {
        allowed = false;
    }
    else if (row.session_ends_at && new Date(row.session_ends_at) < new Date(now)) {
        allowed = false;
    }
    _impCache.set(requestId, { allowed, expiresAt: now + IMP_CACHE_TTL_MS });
    // Bound the cache to avoid an unbounded growth in pathological cases.
    if (_impCache.size > 1000) {
        const oldest = _impCache.keys().next().value;
        if (oldest !== undefined)
            _impCache.delete(oldest);
    }
    return allowed;
}
async function authMiddleware(req, res, next) {
    // Web/desktop clients send the JWT in an HttpOnly cookie. Native mobile
    // clients (React Native) can't manage cookies easily, so fall back to an
    // `Authorization: Bearer <jwt>` header. Cookie takes precedence.
    const authHeader = req.headers?.authorization;
    const token = req.cookies.token ||
        (typeof authHeader === "string" && authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null);
    if (!token) {
        return res.status(401).json({ error: "No token provided" });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
                await redis.setTokenVersion(tenantId, decoded.id, dbTokenVersion);
            }
            if (tokenVersion !== dbTokenVersion) {
                return res.status(401).json({ error: "Session expired. Please sign in again." });
            }
            // Validate session is still active (single-device enforcement)
            if (decoded.sid) {
                let sessions = await redis.getUserSessions(tenantId, decoded.id);
                if (sessions === null) {
                    const sessRes = await dbQuery("SELECT id FROM user_sessions WHERE user_id = $1", [decoded.id]);
                    sessions = sessRes.rows.map((r) => r.id);
                    await redis.setUserSessions(tenantId, decoded.id, sessions);
                }
                if (!sessions.includes(decoded.sid)) {
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
            }
            catch (e) {
                logger_1.logger.warn({ err: e.message }, "auth: failed to verify impersonation session");
            }
        }
        next();
    }
    catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token expired. Please sign in again." });
        }
        if (err.name === "JsonWebTokenError") {
            return res.status(401).json({ error: "Invalid token" });
        }
        logger_1.logger.error({ err, tokenError: err.name }, "Auth middleware error");
        return res.status(401).json({ error: "Authentication failed" });
    }
}
module.exports = authMiddleware;
//# sourceMappingURL=auth.js.map