/**
 * Tenant Management Routes — platform_admin only.
 * All routes prefixed with /admin/tenants (mounted in index.js).
 */
import express from "express";
import type { Request, Response } from "express";
const { masterQuery } = require("../db");
const auth = require("../middleware/auth");
const { loadUserContext, requireRole } = require("../middleware/rbac");
const {
    createTenant, deleteTenant, suspendTenant, reactivateTenant,
    getTenantById, getTenantPool, getPoolStats, listActiveTenants,
} = require("../utils/tenantManager");
const { logPlatformAction, updatePlatformAuditLog, queryPlatformLogs } = require("../utils/platformAudit");
const { logger } = require("../utils/logger");
const redis = require("../redis");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { validatePassword, validateUsername, BCRYPT_ROUNDS } = require("../utils/password");
const { startSession: startImpSession, getSession: getImpSession, endSession: endImpSession } = require("../middleware/impersonationAudit");

const { cookieOptions } = require("../utils/cookie");
const {
    PLANS, PLAN_KEYS, FEATURE_LABELS,
    getEffectiveFeatures, getPlanLimits,
    sanitizeFeatureOverrides, planFeatureDiff,
    loadPlanCatalog, savePlanCatalog, getPlans, DEFAULT_PLANS, FEATURE_KEYS,
} = require("../utils/planCatalog");
const {
    generateApprovalCode, hashApprovalCode, verifyApprovalCode,
    getImpersonationPolicy, updateImpersonationPolicy,
    computeEffectiveStatus, expireStaleRequests, getActiveSession,
    getOrCreateInspectorUser,
} = require("../utils/impersonationApproval");
const {
    getPlatformConfig, updatePlatformConfig,
} = require("../utils/platformConfig");
const { invalidateMaintenanceCache } = require("../middleware/maintenanceMode");

const router = express.Router();
router.use(auth, loadUserContext, requireRole("platform_admin"));

interface ActorCheck {
    ok?: boolean;
    actor?: any;
    status?: number;
    error?: string;
    code?: string;
    mismatch?: boolean;
}

/**
 * Re-verify the acting platform admin's password before a destructive
 * tenant action (suspend / delete). Defends against session-cookie theft
 * and gives a fresh proof-of-identity moment for the audit trail.
 *
 * Works in both auth contexts:
 *   • pure platform user (no tenant)  → checks master `platform_users`.
 *   • platform admin in tenant ctx    → checks the tenant `users` row
 *     (its password hash is mirrored from the platform account on login).
 *
 * Returns { ok: true, actor } | { status, error, code? }.
 */
async function verifyActorPassword(req: Request, password: unknown): Promise<ActorCheck> {
    if (!password || typeof password !== "string") {
        return { status: 400, error: "Your password is required to confirm this action.", code: "REAUTH_REQUIRED" };
    }
    let actor;
    if (req.tenantId) {
        actor = (await req.db!.query(
            "SELECT id, password, full_name, is_active FROM users WHERE id = $1",
            [req.userId],
        )).rows[0];
    } else {
        actor = (await masterQuery(
            "SELECT id, password, full_name, is_active FROM platform_users WHERE id = $1",
            [req.userId],
        )).rows[0];
    }
    if (!actor || actor.is_active === false) {
        return { status: 403, error: "Your account is no longer active." };
    }
    const ok = await bcrypt.compare(password, actor.password);
    if (!ok) {
        return { status: 401, error: "Password did not match. Please try again.", mismatch: true, actor };
    }
    return { ok: true, actor };
}

/**
 * Build session summary from in-memory session data.
 */
function buildSessionSummary(session: any): any {
    if (!session) return { session_start: new Date(), total: 0, reads: 0, writes: 0, actions: [] };
    const actions = session.actions || [];
    return {
        session_start: session.startedAt,
        total: actions.length,
        reads: actions.filter((a: any) => a.type === "read").length,
        writes: actions.filter((a: any) => a.type === "write").length,
        actions,
    };
}

// ═══════════════════════════════════════════════════════════════
//  TENANT CRUD & LIFECYCLE
// ═══════════════════════════════════════════════════════════════

// POST /admin/tenants — create a new tenant
router.post("/", async (req: Request, res: Response) => {
    try {
        const { org_name, slug, plan, features, max_users, max_storage_mb } = req.body;
        if (!org_name || !slug) {
            return res.status(400).json({ error: "org_name and slug are required" });
        }
        if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
            return res.status(400).json({ error: "Slug must be 3-50 chars, lowercase alphanumeric with dashes, no leading/trailing dash." });
        }
        if (plan && !PLAN_KEYS.includes(plan)) {
            return res.status(400).json({ error: `Invalid plan. Must be one of: ${PLAN_KEYS.join(", ")}` });
        }

        const { tenant, db } = await createTenant({
            orgName: org_name,
            slug,
            plan: plan || "standard",
            features: features || {},
            maxUsers: max_users || null,
            maxStorageMb: max_storage_mb || null,
        });

        // Auto-seed a super_admin user for the platform admin who created this tenant
        if (req.isPlatformUser) {
            const platUser = (await masterQuery("SELECT * FROM platform_users WHERE id = $1", [req.userId])).rows[0];
            if (platUser) {
                const existing = (await db.query("SELECT id FROM users WHERE username = $1 OR email = $2", [platUser.username, platUser.email || ""])).rows[0];
                if (!existing) {
                    const newUser = (await db.query(
                        `INSERT INTO users (username, password, full_name, email, org_id, role)
                         VALUES ($1, $2, $3, $4, 1, 'platform_admin') RETURNING id`,
                        [platUser.username, platUser.password, platUser.full_name, platUser.email || `${platUser.username}@platform.local`]
                    )).rows[0];
                    if (platUser.email) {
                        await masterQuery(
                            "INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                            [platUser.email.toLowerCase(), platUser.username.toLowerCase(), tenant.id, newUser.id]
                        );
                    }
                }
            }
        }

        logPlatformAction(req, "tenant_created", "tenant", tenant.id, { slug, org_name }, tenant.id);
        res.status(201).json({ tenant });
    } catch (err: any) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "A tenant with that slug already exists." });
        }
        logger.error({ err }, "Create tenant error");
        res.status(500).json({ error: "Failed to create tenant" });
    }
});

// GET /admin/tenants — list all tenants with user counts
router.get("/", async (req: Request, res: Response) => {
    try {
        const { status, search, limit: rawLimit, offset } = req.query as Record<string, string>;
        const where: string[] = [];
        const params: unknown[] = [];
        let p = 1;

        // Exclude deleted tenants by default; only show them if explicitly requested
        if (status === "deleted") { where.push(`t.status = 'deleted'`); }
        else if (status) { where.push(`t.status = $${p++}`); params.push(status); }
        else { where.push(`t.status != 'deleted'`); }

        if (search) { where.push(`(t.org_name ILIKE $${p} OR t.slug ILIKE $${p})`); params.push(`%${search}%`); p++; }

        const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
        const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        const countRes = await masterQuery(`SELECT COUNT(*) FROM tenants t ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].count, 10);

        const tenantsRes = await masterQuery(
            `SELECT t.*,
                    (SELECT COUNT(*) FROM user_directory ud WHERE ud.tenant_id = t.id) AS user_count
             FROM tenants t ${whereClause}
             ORDER BY t.created_at DESC
             LIMIT $${p++} OFFSET $${p++}`,
            [...params, limit, off]
        );

        res.json({ total, tenants: tenantsRes.rows });
    } catch (err) {
        logger.error({ err }, "List tenants error");
        res.status(500).json({ error: "Failed to list tenants" });
    }
});

// GET /admin/tenants/plan-catalog — return plan definitions for the frontend
router.get("/plan-catalog", async (req: Request, res: Response) => {
    try {
        const plans = await loadPlanCatalog();
        res.json({ plans, feature_labels: FEATURE_LABELS, feature_keys: FEATURE_KEYS });
    } catch (err) {
        logger.error({ err }, "Get plan catalog error");
        res.status(500).json({ error: "Failed to get plan catalog" });
    }
});

// PUT /admin/tenants/plan-catalog — update plan definitions
router.put("/plan-catalog", async (req: Request, res: Response) => {
    try {
        const { plans } = req.body;
        if (!plans || typeof plans !== "object" || Object.keys(plans).length === 0) {
            return res.status(400).json({ error: "plans object is required with at least one plan" });
        }
        for (const [key, plan] of Object.entries(plans) as [string, any][]) {
            if (!plan.label || !plan.features || !plan.limits) {
                return res.status(400).json({ error: `Plan "${key}" must have label, features, and limits` });
            }
        }
        await savePlanCatalog(plans);
        logPlatformAction(req, "plan_catalog_updated", "platform", null, { plan_keys: Object.keys(plans) });
        const current = await loadPlanCatalog();
        res.json({ plans: current, feature_labels: FEATURE_LABELS, feature_keys: FEATURE_KEYS });
    } catch (err) {
        logger.error({ err }, "Update plan catalog error");
        res.status(500).json({ error: "Failed to update plan catalog" });
    }
});

// POST /admin/tenants/plan-catalog/reset — reset to defaults
router.post("/plan-catalog/reset", async (req: Request, res: Response) => {
    try {
        await savePlanCatalog(DEFAULT_PLANS);
        logPlatformAction(req, "plan_catalog_reset", "platform", null, {});
        res.json({ plans: DEFAULT_PLANS, feature_labels: FEATURE_LABELS, feature_keys: FEATURE_KEYS });
    } catch (err) {
        logger.error({ err }, "Reset plan catalog error");
        res.status(500).json({ error: "Failed to reset plan catalog" });
    }
});

// GET /admin/tenants/overview — aggregate dashboard stats
router.get("/overview", async (req: Request, res: Response) => {
    try {
        const [statusRes, userRes, recentRes, planRes, trendRes] = await Promise.all([
            masterQuery(`SELECT status, COUNT(*) AS count FROM tenants GROUP BY status`),
            masterQuery(`SELECT COUNT(*) AS total_users FROM user_directory`),
            masterQuery(`SELECT id, org_name, slug, status, created_at FROM tenants ORDER BY created_at DESC LIMIT 5`),
            masterQuery(`SELECT plan, COUNT(*) AS count FROM tenants WHERE status = 'active' GROUP BY plan`),
            masterQuery(`SELECT DATE(created_at) AS day, COUNT(*) AS count FROM tenants WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day`),
        ]);

        const byStatus: Record<string, number> = {};
        for (const r of statusRes.rows) byStatus[r.status] = parseInt(r.count, 10);

        const byPlan: Record<string, number> = {};
        for (const r of planRes.rows) byPlan[r.plan] = parseInt(r.count, 10);

        res.json({
            total_tenants: Object.values(byStatus).reduce((a, b) => a + b, 0),
            total_users: parseInt(userRes.rows[0].total_users, 10),
            by_status: byStatus,
            by_plan: byPlan,
            trend_30d: trendRes.rows,
            recent: recentRes.rows,
            pool_stats: getPoolStats(),
        });
    } catch (err) {
        logger.error({ err }, "Tenant overview error");
        res.status(500).json({ error: "Failed to get overview" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  PLATFORM ADMIN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/platform-users — list all platform admins
router.get("/platform-users", async (req: Request, res: Response) => {
    try {
        const result = await masterQuery(
            "SELECT id, username, full_name, email, avatar, is_active, created_at FROM platform_users ORDER BY created_at DESC"
        );
        res.json(result.rows);
    } catch (err) {
        logger.error({ err }, "List platform users error");
        res.status(500).json({ error: "Failed to list platform users" });
    }
});

// POST /admin/tenants/platform-users — create a new platform admin
router.post("/platform-users", async (req: Request, res: Response) => {
    try {
        const { username, password, full_name, email } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: "username, password, full_name and email are required" });
        }

        const pwError = await validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: "Invalid email format" });
        }

        // Check uniqueness in platform_users
        const existing = await masterQuery(
            "SELECT id FROM platform_users WHERE username = $1 OR email = $2",
            [username.toLowerCase(), email.toLowerCase()]
        );
        if (existing.rows[0]) {
            return res.status(409).json({ error: "Username or email already exists" });
        }

        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const result = await masterQuery(
            "INSERT INTO platform_users (username, password, full_name, email) VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, email, is_active, created_at",
            [username.toLowerCase(), hash, full_name, email.toLowerCase()]
        );

        logPlatformAction(req, "platform_admin_created", "platform_user", result.rows[0].id, { username, full_name });
        res.status(201).json({ user: result.rows[0], message: "Platform admin created successfully" });
    } catch (err) {
        logger.error({ err }, "Create platform user error");
        res.status(500).json({ error: "Failed to create platform admin" });
    }
});

// PUT /admin/tenants/platform-users/:id/deactivate — toggle active status
router.put("/platform-users/:id/deactivate", async (req: Request, res: Response) => {
    try {
        const uid = Number(req.params.id);
        if (uid === req.userId) {
            return res.status(400).json({ error: "Cannot deactivate yourself" });
        }

        const userRes = await masterQuery("SELECT id, is_active, full_name FROM platform_users WHERE id = $1", [uid]);
        const target = userRes.rows[0];
        if (!target) return res.status(404).json({ error: "Platform user not found" });

        const newActive = !target.is_active;

        // Guard against locking everyone out of the platform: never allow the
        // last active platform admin to be deactivated. (The self-deactivate
        // guard above already protects the common case, but this defends
        // against deactivating the *other* admin when only two remain and one
        // is already inactive.)
        if (!newActive && target.is_active) {
            const activeCount = parseInt(
                (await masterQuery("SELECT COUNT(*) FROM platform_users WHERE is_active = TRUE")).rows[0].count,
                10,
            );
            if (activeCount <= 1) {
                return res.status(400).json({
                    error: "Cannot deactivate the last active platform admin. Create or reactivate another platform admin first.",
                    code: "LAST_PLATFORM_ADMIN",
                });
            }
        }

        await masterQuery("UPDATE platform_users SET is_active = $1, updated_at = NOW() WHERE id = $2", [newActive, uid]);

        logPlatformAction(req, newActive ? "platform_admin_reactivated" : "platform_admin_deactivated", "platform_user", uid, { full_name: target.full_name });
        res.json({ message: `${target.full_name} has been ${newActive ? "reactivated" : "deactivated"}`, is_active: newActive });
    } catch (err) {
        logger.error({ err }, "Deactivate platform user error");
        res.status(500).json({ error: "Failed to update platform user" });
    }
});

// POST /admin/tenants/platform-users/:id/reset-password — reset platform admin password
router.post("/platform-users/:id/reset-password", async (req: Request, res: Response) => {
    try {
        const uid = Number(req.params.id);
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters" });
        }
        if (new_password.length > 72) {
            return res.status(400).json({ error: "Password must be 72 characters or less" });
        }
        const pwErr = await validatePassword(new_password);
        if (pwErr) return res.status(400).json({ error: pwErr });

        const target = (await masterQuery("SELECT id, full_name FROM platform_users WHERE id = $1", [uid])).rows[0];
        if (!target) return res.status(404).json({ error: "Platform user not found" });

        const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
        await masterQuery(
            "UPDATE platform_users SET password = $1, token_version = COALESCE(token_version, 0) + 1, updated_at = NOW() WHERE id = $2",
            [hash, uid]
        );
        await redis.invalidateTokenVersion(null, uid);

        logPlatformAction(req, "platform_admin_reset_password", "platform_user", uid, { full_name: target.full_name });
        res.json({ message: `Password reset for ${target.full_name}` });
    } catch (err) {
        logger.error({ err }, "Reset platform user password error");
        res.status(500).json({ error: "Failed to reset password" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  IMPERSONATION POLICY  (platform-wide settings)
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/impersonation-policy
router.get("/impersonation-policy", async (req: Request, res: Response) => {
    try {
        const policy = await getImpersonationPolicy();
        res.json(policy);
    } catch (err) {
        logger.error({ err }, "Read impersonation policy failed");
        res.status(500).json({ error: "Failed to read policy" });
    }
});

// PUT /admin/tenants/impersonation-policy
router.put("/impersonation-policy", async (req: Request, res: Response) => {
    try {
        const {
            requires_consent,
            break_glass_allowed,
            max_session_minutes,
            code_ttl_minutes,
        } = req.body || {};

        const patch: Record<string, unknown> = {};
        if (typeof requires_consent === "boolean") patch.impersonation_requires_consent = requires_consent;
        if (typeof break_glass_allowed === "boolean") patch.impersonation_break_glass_allowed = break_glass_allowed;
        if (Number.isInteger(max_session_minutes)) {
            if (max_session_minutes < 5 || max_session_minutes > 240) {
                return res.status(400).json({ error: "max_session_minutes must be between 5 and 240" });
            }
            patch.impersonation_max_session_minutes = max_session_minutes;
        }
        if (Number.isInteger(code_ttl_minutes)) {
            if (code_ttl_minutes < 1 || code_ttl_minutes > 60) {
                return res.status(400).json({ error: "code_ttl_minutes must be between 1 and 60" });
            }
            patch.impersonation_code_ttl_minutes = code_ttl_minutes;
        }

        await updateImpersonationPolicy(patch);
        const policy = await getImpersonationPolicy();
        logPlatformAction(req, "impersonation_policy_updated", "platform_settings", null, { patch });
        res.json(policy);
    } catch (err) {
        logger.error({ err }, "Update impersonation policy failed");
        res.status(500).json({ error: "Failed to update policy" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  ACCESS REQUESTS  (platform-side: create, list own, cancel)
// ═══════════════════════════════════════════════════════════════

/**
 * Strip internal fields before returning a request to the platform admin.
 * Notably the `approval_code_hash` MUST never leave the server.
 */
function publicAccessRequest(row: any): any {
    if (!row) return null;
    const effective = computeEffectiveStatus(row);
    return {
        id: row.id,
        tenant_id: row.tenant_id,
        tenant_org_name: row.tenant_org_name,
        tenant_slug: row.tenant_slug,
        requested_by: row.requested_by,
        requested_by_name: row.requested_by_name,
        requested_by_email: row.requested_by_email,
        requested_at: row.requested_at,
        reason: row.reason,
        scope: row.scope,
        duration_minutes: row.duration_minutes,
        status: effective,
        raw_status: row.status,
        approved_by: row.approved_by,
        approved_by_name: row.approved_by_name,
        approved_at: row.approved_at,
        denied_reason: row.denied_reason,
        code_expires_at: row.code_expires_at,
        consumed_at: row.consumed_at,
        session_ends_at: row.session_ends_at,
        revoked_at: row.revoked_at,
        revoked_by_name: row.revoked_by_name,
        revoked_reason: row.revoked_reason,
        cancelled_at: row.cancelled_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// POST /admin/tenants/:id/access-requests — open a new access request
router.post("/:id/access-requests", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant || tenant.status !== "active") {
            return res.status(404).json({ error: "Tenant not found or not active" });
        }

        const { reason, scope, duration_minutes } = req.body || {};
        if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
            return res.status(400).json({ error: "A reason of at least 10 characters is required." });
        }
        if (reason.length > 500) {
            return res.status(400).json({ error: "Reason must be 500 characters or fewer." });
        }
        const reqScope = scope === "read" ? "read" : "write";

        const policy = await getImpersonationPolicy();
        const duration = Number.isInteger(duration_minutes)
            ? duration_minutes
            : 30;
        if (duration < 5 || duration > policy.maxSessionMinutes) {
            return res.status(400).json({
                error: `duration_minutes must be between 5 and ${policy.maxSessionMinutes}`,
            });
        }

        // Reject if this requester already has a live (pending OR approved-not-
        // expired) request open against this tenant — prevents inbox spam.
        await expireStaleRequests();
        const existing = await masterQuery(`
            SELECT id FROM tenant_access_requests
             WHERE tenant_id = $1
               AND requested_by = $2
               AND status IN ('pending','approved')
             LIMIT 1
        `, [tid, req.userId]);
        if (existing.rows[0]) {
            return res.status(409).json({
                error: "You already have an open access request for this tenant. Cancel it before opening a new one.",
                existing_id: existing.rows[0].id,
            });
        }

        const me = (await masterQuery(
            "SELECT id, full_name, email FROM platform_users WHERE id = $1",
            [req.userId]
        )).rows[0];

        const insert = await masterQuery(`
            INSERT INTO tenant_access_requests
                (tenant_id, requested_by, requested_by_name, requested_by_email,
                 reason, scope, duration_minutes, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            RETURNING *
        `, [
            tid, req.userId,
            me?.full_name || null, me?.email || null,
            reason.trim(), reqScope, duration,
        ]);
        const row = insert.rows[0];

        logPlatformAction(req, "tenant_access_request_created", "tenant_access_request", row.id, {
            reason: row.reason, scope: row.scope, duration_minutes: row.duration_minutes,
        }, tid);

        // Notify tenant super_admins via in-app notification + WebSocket so
        // their inbox lights up immediately. Best-effort: we still succeed
        // if the broadcast fails (e.g. WS not initialised in tests).
        try {
            const db = await getTenantPool(tenant.db_name, tenant.db_host);
            const admins = (await db.query(
                `SELECT id FROM users WHERE is_active = TRUE AND role IN ('super_admin','platform_admin')`
            )).rows;
            const { sendToUser } = require("../utils/ws");
            for (const a of admins) {
                try {
                    await db.query(
                        `INSERT INTO notifications (user_id, type, title, body)
                         VALUES ($1, 'platform_access_request', $2, $3)`,
                        [a.id,
                            "Platform support access requested",
                        `${me?.full_name || "A platform admin"} is requesting ${reqScope} access to your workspace. Open Admin → Platform Access to review.`],
                    );
                } catch { /* ignore — best effort */ }
                try {
                    sendToUser(tid, a.id, "platform_access_request_created", publicAccessRequest({
                        ...row, tenant_org_name: tenant.org_name, tenant_slug: tenant.slug,
                    }));
                } catch { /* ws not ready in tests */ }
            }
        } catch (e: any) {
            logger.warn({ err: e.message }, "access-request: could not notify tenant admins");
        }

        res.status(201).json({
            request: publicAccessRequest({
                ...row, tenant_org_name: tenant.org_name, tenant_slug: tenant.slug,
            })
        });
    } catch (err) {
        logger.error({ err }, "Create access request error");
        res.status(500).json({ error: "Failed to create access request" });
    }
});

// GET /admin/tenants/access-requests — list MY (current platform admin) requests
//
// NOTE: registered before any /:id route so the literal `access-requests`
// path doesn't get consumed as a tenant id.
router.get("/access-requests", async (req: Request, res: Response) => {
    try {
        await expireStaleRequests();
        const { status, tenant_id, limit: rawLimit, offset } = req.query as Record<string, string>;
        const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        const where = ["ar.requested_by = $1"];
        const params: unknown[] = [req.userId];
        let p = 2;
        if (status) { where.push(`ar.status = $${p++}`); params.push(status); }
        if (tenant_id) { where.push(`ar.tenant_id = $${p++}`); params.push(Number(tenant_id)); }

        const result = await masterQuery(`
            SELECT ar.*, t.org_name AS tenant_org_name, t.slug AS tenant_slug
              FROM tenant_access_requests ar
              JOIN tenants t ON t.id = ar.tenant_id
             WHERE ${where.join(" AND ")}
             ORDER BY ar.requested_at DESC
             LIMIT $${p++} OFFSET $${p++}
        `, [...params, limit, off]);

        res.json({ requests: result.rows.map(publicAccessRequest) });
    } catch (err) {
        logger.error({ err }, "List access requests error");
        res.status(500).json({ error: "Failed to list access requests" });
    }
});

// GET /admin/tenants/:id/access-requests — list requests for a specific tenant
router.get("/:id/access-requests", async (req: Request, res: Response) => {
    try {
        await expireStaleRequests();
        const tid = Number(req.params.id);
        const result = await masterQuery(`
            SELECT ar.*, t.org_name AS tenant_org_name, t.slug AS tenant_slug
              FROM tenant_access_requests ar
              JOIN tenants t ON t.id = ar.tenant_id
             WHERE ar.tenant_id = $1
               AND ar.requested_by = $2
             ORDER BY ar.requested_at DESC
             LIMIT 50
        `, [tid, req.userId]);
        res.json({ requests: result.rows.map(publicAccessRequest) });
    } catch (err) {
        logger.error({ err }, "List tenant access requests error");
        res.status(500).json({ error: "Failed to list access requests" });
    }
});

// DELETE /admin/tenants/access-requests/:reqId — cancel a pending/approved request
router.delete("/access-requests/:reqId", async (req: Request, res: Response) => {
    try {
        const rid = Number(req.params.reqId);
        const row = (await masterQuery(
            "SELECT * FROM tenant_access_requests WHERE id = $1 AND requested_by = $2",
            [rid, req.userId],
        )).rows[0];
        if (!row) return res.status(404).json({ error: "Request not found" });
        if (!["pending", "approved"].includes(row.status)) {
            return res.status(409).json({ error: `Cannot cancel a request in status '${row.status}'.` });
        }

        await masterQuery(`
            UPDATE tenant_access_requests
               SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
                   approval_code_hash = NULL, code_expires_at = NULL
             WHERE id = $1
        `, [rid]);

        logPlatformAction(req, "tenant_access_request_cancelled", "tenant_access_request", rid, {}, row.tenant_id);
        res.json({ message: "Request cancelled" });
    } catch (err) {
        logger.error({ err }, "Cancel access request error");
        res.status(500).json({ error: "Failed to cancel request" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  PLATFORM AUDIT LOGS
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/audit-logs — query platform-level audit trail
// NOTE: Must be defined BEFORE /:id routes to avoid being caught by the param.
router.get("/audit-logs", async (req: Request, res: Response) => {
    try {
        const { actor_id, entity_type, entity_id, action, tenant_id, from, to, limit, offset } = req.query as Record<string, string>;
        const result = await queryPlatformLogs({
            actorId: actor_id ? Number(actor_id) : null,
            entityType: entity_type || null,
            entityId: entity_id ? Number(entity_id) : null,
            action: action || null,
            tenantId: tenant_id ? Number(tenant_id) : null,
            from: from || null,
            to: to || null,
            limit: limit ? Number(limit) : 50,
            offset: offset ? Number(offset) : 0,
        });
        res.json(result);
    } catch (err) {
        logger.error({ err }, "Platform audit logs query error");
        res.status(500).json({ error: "Failed to query audit logs" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  PLATFORM CONFIGURATION
// ═══════════════════════════════════════════════════════════════
// NOTE: These literal-path routes (/platform-config, /alerts) MUST be
// defined BEFORE the /:id routes below — otherwise Express's path matcher
// will treat "platform-config", "alerts", etc. as the value of the :id
// parameter and the handler will fail with a 500 trying to look up a
// tenant whose id is "alerts".

// GET /admin/tenants/platform-config — all platform settings
router.get("/platform-config", async (req: Request, res: Response) => {
    try {
        const config = await getPlatformConfig();
        res.json(config);
    } catch (err) {
        logger.error({ err }, "Get platform config error");
        res.status(500).json({ error: "Failed to get platform config" });
    }
});

// PUT /admin/tenants/platform-config — update platform settings
router.put("/platform-config", async (req: Request, res: Response) => {
    try {
        const updated = await updatePlatformConfig(req.body);
        if ("maintenance_mode" in updated) {
            invalidateMaintenanceCache();
        }
        logPlatformAction(req, "platform_config_updated", "platform", null, { updated_keys: Object.keys(updated) });
        const config = await getPlatformConfig();
        res.json(config);
    } catch (err) {
        logger.error({ err }, "Update platform config error");
        res.status(500).json({ error: "Failed to update platform config" });
    }
});

// GET /admin/tenants/alerts — tenants approaching limits
//
// Returns a list of "things the platform admin should look at":
//   • users_approaching_limit     — tenant has >= 80% of its `max_users` cap
//   • storage_approaching_limit   — tenant DB on the SAME Postgres instance is
//                                   using >= 80% of its `max_storage_mb` cap.
//                                   Tenants on a separate `db_host` are skipped
//                                   (we'd need a remote query to size them).
//   • no_active_super_admin       — tenant has zero active `super_admin` users.
//                                   We query each tenant DB individually
//                                   because the master `user_directory` table
//                                   only stores email/username/tenant_id and
//                                   does NOT carry role / is_active. Querying
//                                   it for those columns is what was causing
//                                   the 500 ("Failed to get alerts").
router.get("/alerts", async (req: Request, res: Response) => {
    try {
        const alerts: any[] = [];

        // ─── 1) USER COUNT ALERTS ───
        // `user_directory` rows == active app users (entries are removed when
        // a tenant user is hard-deleted), so COUNT is a safe proxy here.
        try {
            const usersRes = await masterQuery(`
                SELECT t.id, t.org_name, t.slug, t.max_users,
                       COUNT(ud.id) AS current_users
                FROM tenants t
                LEFT JOIN user_directory ud ON ud.tenant_id = t.id
                WHERE t.status = 'active' AND t.max_users IS NOT NULL AND t.max_users > 0
                GROUP BY t.id
                HAVING COUNT(ud.id) >= t.max_users * 0.8
            `);
            for (const r of usersRes.rows) {
                alerts.push({
                    tenant_id: r.id,
                    tenant_name: r.org_name,
                    slug: r.slug,
                    alert_type: "users_approaching_limit",
                    current_value: parseInt(r.current_users, 10),
                    limit_value: r.max_users,
                    percentage: Math.round((parseInt(r.current_users, 10) / r.max_users) * 100),
                });
            }
        } catch (e: any) {
            logger.warn({ err: e.message }, "alerts: users_approaching_limit check failed");
        }

        // ─── 2) STORAGE ALERTS ───
        // `pg_database_size(name)` only works for databases on THIS Postgres
        // instance. Skip rows where db_host is set to anything other than the
        // master DB host (NULL or matching master host means "same instance").
        // We also guard the whole block — a missing pg_database_size privilege
        // shouldn't take down the entire endpoint.
        try {
            const storageRes = await masterQuery(`
                SELECT t.id, t.org_name, t.slug, t.max_storage_mb, t.db_name, t.db_host,
                       (pg_database_size(t.db_name) / (1024 * 1024))::bigint AS current_mb
                FROM tenants t
                WHERE t.status = 'active'
                  AND t.max_storage_mb IS NOT NULL AND t.max_storage_mb > 0
                  AND t.db_name IS NOT NULL
                  AND (t.db_host IS NULL OR t.db_host = '' OR t.db_host = current_setting('server_addr', true))
            `);
            for (const r of storageRes.rows) {
                const currentMb = Math.round(Number(r.current_mb) || 0);
                if (currentMb >= r.max_storage_mb * 0.8) {
                    alerts.push({
                        tenant_id: r.id,
                        tenant_name: r.org_name,
                        slug: r.slug,
                        alert_type: "storage_approaching_limit",
                        current_value: currentMb,
                        limit_value: r.max_storage_mb,
                        percentage: Math.round((currentMb / r.max_storage_mb) * 100),
                    });
                }
            }
        } catch (e: any) {
            logger.warn({ err: e.message }, "alerts: storage_approaching_limit check failed");
        }

        // ─── 3) NO ACTIVE SUPER_ADMIN ALERTS ───
        // Role / is_active live in each tenant's `users` table, not in the
        // master directory. Iterate active tenants and probe each tenant DB.
        // Failures (offline DB, missing pool, etc.) are swallowed per-tenant
        // so one broken tenant can't blank the whole alerts panel.
        try {
            const activeTenants = await masterQuery(`
                SELECT id, org_name, slug, db_name, db_host
                  FROM tenants
                 WHERE status = 'active' AND db_name IS NOT NULL
            `);
            for (const t of activeTenants.rows) {
                try {
                    const pool = await getTenantPool(t.db_name, t.db_host);
                    const r = await pool.query(
                        `SELECT COUNT(*)::int AS c
                           FROM users
                          WHERE is_active = TRUE
                            AND role IN ('super_admin', 'platform_admin')`
                    );
                    if ((r.rows[0]?.c || 0) === 0) {
                        alerts.push({
                            tenant_id: t.id,
                            tenant_name: t.org_name,
                            slug: t.slug,
                            alert_type: "no_active_super_admin",
                            current_value: 0,
                            limit_value: 1,
                            percentage: 100,
                        });
                    }
                } catch (e: any) {
                    logger.warn({ err: e.message, tenantId: t.id }, "alerts: super_admin probe failed for tenant");
                }
            }
        } catch (e: any) {
            logger.warn({ err: e.message }, "alerts: no_active_super_admin check failed");
        }

        alerts.sort((a, b) => b.percentage - a.percentage);
        res.json({ alerts });
    } catch (err) {
        logger.error({ err }, "Tenant alerts error");
        res.status(500).json({ error: "Failed to get alerts" });
    }
});

// NOTE: The legacy `POST /admin/tenants/smtp-test` route was removed.
// Platform-level SMTP configuration is no longer exposed in the admin panel —
// outbound email transport is configured via `process.env.SMTP_*` /
// `GMAIL_*` and consumed by `server/utils/mailer.js`. Per-tenant email
// template / branding overrides live under `/api/branding` (see
// `server/routes/branding.js`).

// ═══════════════════════════════════════════════════════════════
//  SINGLE TENANT DETAIL & LIFECYCLE
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/:id — single tenant detail
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const tenant = await getTenantById(Number(req.params.id));
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        const userCount = (await masterQuery(
            "SELECT COUNT(*) FROM user_directory WHERE tenant_id = $1", [tenant.id]
        )).rows[0].count;

        const effective_features = getEffectiveFeatures(tenant.plan, tenant.features);
        res.json({ ...tenant, user_count: parseInt(userCount, 10), effective_features });
    } catch (err) {
        logger.error({ err }, "Get tenant error");
        res.status(500).json({ error: "Failed to get tenant" });
    }
});

// PUT /admin/tenants/:id — update tenant config (general fields only).
//
// IMPORTANT: this endpoint NO LONGER accepts `features` — the previous
// behaviour was to wholesale-replace the JSON column, which silently wiped
// every per-tenant feature override the moment an admin updated `org_name`
// with a stale form payload. Use the dedicated endpoints instead:
//   PUT /:id/features  — merge feature overrides
//   PUT /:id/plan      — change subscription plan
//   PUT /:id/limits    — update user / storage caps
//
// `max_users` / `max_storage_mb` here remain for back-compat but emit a
// deprecation warning in the audit log.
router.put("/:id", async (req: Request, res: Response) => {
    try {
        const { org_name, max_users, max_storage_mb, features } = req.body;
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        // Explicitly reject `features` — too easy to clobber by accident.
        if (features !== undefined) {
            return res.status(400).json({
                error: "Cannot update features via PUT /:id. Use PUT /:id/features (merge) or PUT /:id/plan instead.",
                code: "FEATURES_REQUIRES_DEDICATED_ENDPOINT",
            });
        }

        const result = await masterQuery(
            `UPDATE tenants SET
                org_name = COALESCE($1, org_name),
                max_users = COALESCE($2, max_users),
                max_storage_mb = COALESCE($3, max_storage_mb),
                updated_at = NOW()
             WHERE id = $4 RETURNING *`,
            // Use `??` (nullish-coalescing) so an explicit 0 is rejected via
            // COALESCE rather than silently treated as "no change". The
            // previous `?? null` collapsed undefined and null indistinguishably.
            [
                org_name || null,
                Number.isFinite(max_users) && max_users > 0 ? max_users : null,
                Number.isFinite(max_storage_mb) && max_storage_mb > 0 ? max_storage_mb : null,
                tid,
            ]
        );

        // Invalidate tenant cache
        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        logPlatformAction(req, "tenant_updated", "tenant", tid, { changes: req.body }, tid);
        res.json({ tenant: result.rows[0] });
    } catch (err) {
        logger.error({ err }, "Update tenant error");
        res.status(500).json({ error: "Failed to update tenant" });
    }
});

// PUT /admin/tenants/:id/suspend
// Requires the acting platform admin to re-enter their password. The action
// (with the actor's identity) is recorded in the platform audit log.
router.put("/:id/suspend", async (req: Request, res: Response) => {
    try {
        const { reason, password } = req.body || {};
        const tid = Number(req.params.id);

        // Prevent suspension of the default (master) tenant. Suspending it would
        // 503 the default workspace and break email-based login routing for
        // platform admins (see auth.js resolveDefaultDomainUser), so it is
        // blocked here exactly like deletion is.
        const defaultCheck = await masterQuery("SELECT is_default FROM tenants WHERE id = $1", [tid]);
        if (defaultCheck.rows[0]?.is_default) {
            return res.status(403).json({ error: "The default platform tenant cannot be suspended." });
        }

        const check = await verifyActorPassword(req, password);
        if (!check.ok) {
            if (check.mismatch) {
                logPlatformAction(req, "tenant_suspend_reauth_failed", "tenant", tid, {}, tid);
            }
            return res.status(check.status as number).json({ error: check.error, code: check.code });
        }

        const tenant = await suspendTenant(tid, reason);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        logPlatformAction(req, "tenant_suspended", "tenant", tid, {
            reason,
            actor_id: check.actor.id,
            actor_name: check.actor.full_name,
        }, tid);
        res.json({ tenant });
    } catch (err) {
        logger.error({ err }, "Suspend tenant error");
        res.status(500).json({ error: "Failed to suspend tenant" });
    }
});

// PUT /admin/tenants/:id/reactivate
router.put("/:id/reactivate", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await reactivateTenant(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        logPlatformAction(req, "tenant_reactivated", "tenant", tid, null, tid);
        res.json({ tenant });
    } catch (err) {
        logger.error({ err }, "Reactivate tenant error");
        res.status(500).json({ error: "Failed to reactivate tenant" });
    }
});

// DELETE /admin/tenants/:id?hard=true
// Requires the acting platform admin to re-enter their password (accepted via
// the request body — DELETE with a JSON body). The action (with the actor's
// identity) is recorded in the platform audit log.
router.delete("/:id", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);

        // Prevent deletion of the default (master) tenant
        const defaultCheck = await masterQuery("SELECT is_default FROM tenants WHERE id = $1", [tid]);
        if (defaultCheck.rows[0]?.is_default) {
            return res.status(403).json({ error: "The default platform tenant cannot be deleted." });
        }

        const { password } = req.body || {};
        const check = await verifyActorPassword(req, password);
        if (!check.ok) {
            if (check.mismatch) {
                logPlatformAction(req, "tenant_delete_reauth_failed", "tenant", tid, {}, tid);
            }
            return res.status(check.status as number).json({ error: check.error, code: check.code });
        }

        const hard = req.query.hard === "true";
        const result = await deleteTenant(tid, hard);
        if (!result) return res.status(404).json({ error: "Tenant not found" });

        await redis.del(`tenant:id:${tid}`);

        logPlatformAction(req, hard ? "tenant_hard_deleted" : "tenant_soft_deleted", "tenant", tid, {
            hard,
            actor_id: check.actor.id,
            actor_name: check.actor.full_name,
        }, tid);
        res.json({ message: hard ? "Tenant permanently deleted." : "Tenant marked as deleted." });
    } catch (err) {
        logger.error({ err }, "Delete tenant error");
        res.status(500).json({ error: "Failed to delete tenant" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  TENANT HEALTH & STATS
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/:id/stats
router.get("/:id/stats", async (req: Request, res: Response) => {
    try {
        const tenant = await getTenantById(Number(req.params.id));
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        const db = await getTenantPool(tenant.db_name, tenant.db_host);

        const safeCount = (q: string) => db.query(q).then((r: any) => parseInt(r.rows[0].count, 10)).catch(() => 0);
        const [user_count, task_count, message_count, dbSize, lastActivity] = await Promise.all([
            safeCount("SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE"),
            safeCount("SELECT COUNT(*) AS count FROM tasks"),
            safeCount("SELECT COUNT(*) AS count FROM messages"),
            masterQuery(`SELECT pg_database_size($1) AS size`, [tenant.db_name]),
            db.query('SELECT MAX("timestamp") AS last_activity FROM time_entries').catch(() => ({ rows: [{}] })),
        ]);

        res.json({
            user_count,
            task_count,
            message_count,
            db_size_bytes: parseInt(dbSize.rows[0].size, 10),
            last_activity: lastActivity.rows[0]?.last_activity,
        });
    } catch (err) {
        logger.error({ err }, "Tenant stats error");
        res.status(500).json({ error: "Failed to get stats" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  DOMAIN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// PUT /admin/tenants/:id/domain
router.put("/:id/domain", async (req: Request, res: Response) => {
    try {
        const { custom_domain } = req.body;
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        // Basic domain validation
        if (custom_domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(custom_domain)) {
            return res.status(400).json({ error: "Invalid domain format" });
        }

        // Clear old domain cache
        if (tenant.custom_domain) {
            await redis.del(`tenant:domain:${tenant.custom_domain}`);
        }

        const result = await masterQuery(
            "UPDATE tenants SET custom_domain = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
            [custom_domain || null, tid]
        );

        await redis.del(`tenant:id:${tid}`);

        logPlatformAction(req, "tenant_domain_changed", "tenant", tid, { old: tenant.custom_domain, new: custom_domain }, tid);
        res.json({ tenant: result.rows[0] });
    } catch (err: any) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "This domain is already assigned to another tenant." });
        }
        logger.error({ err }, "Update domain error");
        res.status(500).json({ error: "Failed to update domain" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  FEATURE FLAGS & LIMITS
// ═══════════════════════════════════════════════════════════════

// PUT /admin/tenants/:id/features
//
// Merges per-tenant feature overrides into the existing JSON column. Only
// keys whitelisted by `FEATURE_LABELS` are persisted as overrides; arbitrary
// junk is dropped (defence in depth against the bug where a malformed
// override could silently flip a feature on). Non-feature config keys
// (e.g. `registration_mode`) are passed through unchanged via the `extras`
// namespace from `sanitizeFeatureOverrides`.
router.put("/:id/features", async (req: Request, res: Response) => {
    try {
        const { features } = req.body;
        if (!features || typeof features !== "object") {
            return res.status(400).json({ error: "features object is required" });
        }
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        // Sanitize the incoming patch — only whitelisted keys with strict
        // boolean values are kept.
        const sanitized = sanitizeFeatureOverrides(features);
        const incomingOverrides = sanitized.overrides;
        const incomingExtras = sanitized.extras;

        // Compute disabled-on-this-edit (so we can disconnect WS sockets).
        const beforeEffective = getEffectiveFeatures(tenant.plan, tenant.features);

        // Merge against existing JSON: preserve old overrides + extras the
        // patch didn't touch.
        const merged = { ...(tenant.features || {}), ...incomingOverrides, ...incomingExtras };

        const result = await masterQuery(
            "UPDATE tenants SET features = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
            [JSON.stringify(merged), tid]
        );

        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        const effective_features = getEffectiveFeatures(result.rows[0].plan, merged);

        // Notify connected clients so they re-render gated sections without F5.
        try {
            const { broadcast } = require("../utils/ws");
            broadcast(tid, "tenant_features_changed", { features: effective_features });
        } catch { /* ws not initialised in tests */ }

        logPlatformAction(req, "tenant_features_updated", "tenant", tid, {
            patch: incomingOverrides,
            // Emit a digest of newly-disabled features so the audit row is searchable.
            disabled_features: Object.keys(beforeEffective)
                .filter(k => beforeEffective[k] === true && effective_features[k] === false),
        }, tid);
        res.json({ tenant: result.rows[0], effective_features });
    } catch (err) {
        logger.error({ err }, "Update features error");
        res.status(500).json({ error: "Failed to update features" });
    }
});

// PUT /admin/tenants/:id/plan — change subscription plan
//
// Supports `?dry_run=true` to preview the impact (which features will be
// disabled, whether current usage exceeds the new plan's limits) WITHOUT
// applying the change. Use this from the admin UI to surface a confirmation
// dialog before a downgrade.
router.put("/:id/plan", async (req: Request, res: Response) => {
    try {
        const { plan, apply_plan_limits } = req.body;
        if (!plan || !PLAN_KEYS.includes(plan)) {
            return res.status(400).json({ error: `Invalid plan. Must be one of: ${PLAN_KEYS.join(", ")}` });
        }
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        const dryRun = req.query.dry_run === "true" || req.query.dry_run === "1";
        const diff = planFeatureDiff(tenant.plan, plan);
        const newLimits = getPlanLimits(plan);

        // Compute current usage so the UI can warn about over-the-cap downgrades.
        let currentUsers: number | null = null;
        try {
            const pool = await getTenantPool(tenant.db_name, tenant.db_host);
            const r = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE is_active = TRUE");
            currentUsers = parseInt(r.rows[0].c, 10);
        } catch (e: any) {
            logger.warn({ err: e.message, tenantId: tid }, "plan-change: could not read user count");
        }

        const preview = {
            from_plan: tenant.plan,
            to_plan: plan,
            features_disabled: diff.disabled,
            features_enabled: diff.enabled,
            new_max_users: newLimits.max_users,
            new_max_storage_mb: newLimits.max_storage_mb,
            current_users: currentUsers,
            over_user_limit: !!(newLimits.max_users && currentUsers != null && currentUsers > newLimits.max_users),
        };

        if (dryRun) {
            return res.json({ dry_run: true, preview });
        }

        const updates = ["plan = $1", "updated_at = NOW()"];
        const params: unknown[] = [plan];
        let p = 2;

        if (apply_plan_limits) {
            updates.push(`max_users = $${p++}`, `max_storage_mb = $${p++}`);
            params.push(newLimits.max_users, newLimits.max_storage_mb);
        }

        params.push(tid);
        const result = await masterQuery(
            `UPDATE tenants SET ${updates.join(", ")} WHERE id = $${p} RETURNING *`,
            params
        );

        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        const effective_features = getEffectiveFeatures(plan, result.rows[0].features);

        // Broadcast to all connected clients of this tenant. The frontend
        // listens for `plan_changed` and re-fetches /api/profile so the UI
        // updates instantly (no F5).
        try {
            const { broadcast } = require("../utils/ws");
            broadcast(tid, "plan_changed", {
                from: tenant.plan,
                to: plan,
                features: effective_features,
                features_disabled: diff.disabled,
            });
        } catch { /* ws not initialised in tests */ }

        logPlatformAction(req, "tenant_plan_changed", "tenant", tid, {
            from: tenant.plan,
            to: plan,
            preview,
        }, tid);
        res.json({ tenant: result.rows[0], effective_features, preview });
    } catch (err) {
        logger.error({ err }, "Update plan error");
        res.status(500).json({ error: "Failed to update plan" });
    }
});

// PUT /admin/tenants/:id/limits
router.put("/:id/limits", async (req: Request, res: Response) => {
    try {
        const { max_users, max_storage_mb } = req.body;
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        const result = await masterQuery(
            "UPDATE tenants SET max_users = $1, max_storage_mb = $2, updated_at = NOW() WHERE id = $3 RETURNING *",
            [max_users ?? tenant.max_users, max_storage_mb ?? tenant.max_storage_mb, tid]
        );

        await redis.del(`tenant:id:${tid}`);

        logPlatformAction(req, "tenant_limits_updated", "tenant", tid, { max_users, max_storage_mb }, tid);
        res.json({ tenant: result.rows[0] });
    } catch (err) {
        logger.error({ err }, "Update limits error");
        res.status(500).json({ error: "Failed to update limits" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  IMPERSONATION
// ═══════════════════════════════════════════════════════════════

// POST /admin/tenants/:id/impersonate
//
// Consent-gated. Body:
//   { approval_code: "123456",  ← 6-digit code from the tenant approver
//     password:      "...",     ← inspector's own platform_users password
//     break_glass:   true }     ← OPTIONAL bypass (only if policy allows it
//                                 AND the platform admin re-auths).
//
// Flow:
//   1. Re-verify the platform admin's password (defence against stolen
//      session cookies; required even in break-glass mode).
//   2. Unless break_glass=true: load the matching approved request and
//      bcrypt-compare the code. Mark consumed.
//   3. Mint a JWT whose `exp` matches the request's duration (capped by
//      the platform policy).
//   4. Audit & WS-notify the tenant that the session has started.
router.post("/:id/impersonate", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant || tenant.status !== "active") {
            return res.status(404).json({ error: "Tenant not found or not active" });
        }

        const { approval_code, password, break_glass } = req.body || {};
        const policy = await getImpersonationPolicy();

        // ── Step 1: re-authenticate the platform admin ──
        // We always require the platform admin to re-enter their password.
        // This makes the consent flow defensive against session-cookie theft
        // (the attacker would also need the inspector's password) and gives
        // us a fresh proof-of-identity moment for the audit row.
        if (!password || typeof password !== "string") {
            return res.status(400).json({
                error: "Password is required to start an impersonation session.",
                code: "REAUTH_REQUIRED",
            });
        }
        const me = (await masterQuery(
            "SELECT id, password, full_name, is_active FROM platform_users WHERE id = $1",
            [req.userId],
        )).rows[0];
        if (!me || !me.is_active) {
            return res.status(403).json({ error: "Your platform account is no longer active." });
        }
        const pwOk = await bcrypt.compare(password, me.password);
        if (!pwOk) {
            // Record the failed attempt — failed re-auth here is a strong
            // signal of misuse and worth flagging in the audit trail.
            logPlatformAction(req, "tenant_impersonation_reauth_failed", "tenant", tid, {}, tid);
            return res.status(401).json({ error: "Password did not match. Please try again." });
        }

        // ── Step 2: consent enforcement ──
        let request: any = null;
        let isBreakGlass = false;
        const requiresConsent = policy.requiresConsent;

        if (requiresConsent && break_glass === true) {
            if (!policy.breakGlassAllowed) {
                return res.status(403).json({
                    error: "Break-glass access is disabled by platform policy.",
                    code: "BREAK_GLASS_DISABLED",
                });
            }
            isBreakGlass = true;
        } else if (requiresConsent) {
            if (!approval_code || !/^\d{6}$/.test(String(approval_code))) {
                return res.status(400).json({
                    error: "A 6-digit approval code is required.",
                    code: "APPROVAL_CODE_REQUIRED",
                });
            }
            // Load every active approved request for this requester / tenant
            // and bcrypt-compare against each. Usually there's at most one,
            // but we handle the rare case where a previous code lingers
            // in 'approved' state alongside a fresh one.
            await expireStaleRequests();
            const candidates = (await masterQuery(`
                SELECT * FROM tenant_access_requests
                 WHERE tenant_id = $1
                   AND requested_by = $2
                   AND status = 'approved'
                   AND approval_code_hash IS NOT NULL
                   AND (code_expires_at IS NULL OR code_expires_at > NOW())
                 ORDER BY approved_at DESC
            `, [tid, req.userId])).rows;
            for (const c of candidates) {
                // eslint-disable-next-line no-await-in-loop
                if (await verifyApprovalCode(String(approval_code), c.approval_code_hash)) {
                    request = c;
                    break;
                }
            }
            if (!request) {
                logPlatformAction(req, "tenant_impersonation_bad_code", "tenant", tid, {}, tid);
                return res.status(401).json({
                    error: "The approval code is invalid or has expired. Ask the tenant to approve a new request.",
                    code: "INVALID_APPROVAL_CODE",
                });
            }
        }

        // ── Step 2.5: synthetic Platform Inspector identity ──
        // Historically we impersonated AS the tenant's highest-ranked active
        // user (typically a super_admin), which made every action during the
        // session look like that teammate took it. The new model gives each
        // platform admin a dedicated synthetic `users` row inside the tenant
        // DB — role='platform_admin', hidden_from_directory=TRUE — so the
        // session has its own honest identity that doesn't pollute team
        // directories or pretend to be somebody else.
        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const platUser = await getOrCreateInspectorUser(db, {
            id: req.userId,
            full_name: me.full_name,
        });

        // ── Step 3: bound session TTL ──
        // If we have an approved request, the session can only last as long
        // as the requested duration (capped by the platform policy). Without
        // a request (legacy/no-consent mode, or break-glass), we fall back
        // to the policy max session.
        const ttlMinutes = Math.min(
            policy.maxSessionMinutes,
            request?.duration_minutes || policy.maxSessionMinutes,
        );
        const sessionEndsAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

        const impersonationToken = jwt.sign(
            {
                id: platUser.id,
                username: platUser.username,
                tv: platUser.token_version || 0,
                tenant_id: tid,
                impersonated: true,
                impersonated_by: req.userId,
                impersonated_tenant_name: tenant.org_name,
                // The synthetic inspector row IS a real users row — no longer
                // a "virtual" placeholder. Keep the field for backwards
                // compatibility but always emit false now.
                is_virtual: false,
                access_request_id: request?.id || null,
                break_glass: isBreakGlass || false,
                scope: request?.scope || "write",
            },
            process.env.JWT_SECRET,
            { expiresIn: `${ttlMinutes}m` },
        );

        // Insert a single audit row for this session (ended_at filled on exit)
        const auditResult = await logPlatformAction(req, "tenant_impersonation_session", "tenant", tid, {
            target_user: platUser.id,
            target_username: platUser.username,
            synthetic_inspector: true,
            access_request_id: request?.id || null,
            break_glass: isBreakGlass,
            scope: request?.scope || "write",
            session_minutes: ttlMinutes,
            session_ends_at: sessionEndsAt,
        }, tid);
        const auditLogId = auditResult?.rows?.[0]?.id || null;

        // Mark request as consumed so it can't be replayed.
        if (request) {
            await masterQuery(`
                UPDATE tenant_access_requests
                   SET status = 'consumed',
                       consumed_at = NOW(),
                       session_ends_at = $1,
                       session_audit_log_id = $2,
                       approval_code_hash = NULL,
                       updated_at = NOW()
                 WHERE id = $3
            `, [sessionEndsAt, auditLogId, request.id]);
        } else if (isBreakGlass) {
            // For break-glass we still write a synthetic request row so the
            // tenant admin can see the active session + revoke it from their
            // inbox. The row's `approved_by` is NULL (no consent was given).
            await masterQuery(`
                INSERT INTO tenant_access_requests
                    (tenant_id, requested_by, requested_by_name, requested_by_email,
                     reason, scope, duration_minutes, status,
                     consumed_at, session_ends_at, session_audit_log_id,
                     approved_at)
                VALUES ($1, $2, $3, $4, $5, 'write', $6, 'consumed', NOW(), $7, $8, NOW())
            `, [
                tid, req.userId,
                me.full_name || null, null,
                "BREAK-GLASS EMERGENCY ACCESS",
                ttlMinutes, sessionEndsAt, auditLogId,
            ]);
        }

        // Start in-memory session tracker for action recording
        startImpSession(req.userId, tid, auditLogId);

        // Save the original platform admin token so we can restore it on exit
        const origToken = req.cookies.token;

        // Set impersonation token as HttpOnly cookie (replaces existing auth cookie)
        const ttlMs = ttlMinutes * 60 * 1000;
        res.cookie("token", impersonationToken, cookieOptions(req, ttlMs));
        // Store original token in a separate HttpOnly cookie for restoration
        if (origToken) {
            res.cookie("_wp_orig_token", origToken, cookieOptions(req, ttlMs));
        }

        // Tell connected tenant clients that an inspector just entered.
        try {
            const { broadcast } = require("../utils/ws");
            broadcast(tid, "platform_access_session_started", {
                request_id: request?.id || null,
                inspector_name: me.full_name,
                scope: request?.scope || "write",
                session_ends_at: sessionEndsAt,
                break_glass: isBreakGlass,
            });
        } catch { /* ws not initialised in tests */ }

        res.json({
            tenant: { id: tid, org_name: tenant.org_name, slug: tenant.slug },
            user: platUser,
            // Bearer-token clients (mobile) can't read the HttpOnly cookie —
            // return the impersonation JWT in the body too. They store their
            // original platform token locally and swap back on exit.
            token: impersonationToken,
            session: {
                request_id: request?.id || null,
                break_glass: isBreakGlass,
                scope: request?.scope || "write",
                ends_at: sessionEndsAt,
                duration_minutes: ttlMinutes,
            },
        });
    } catch (err) {
        logger.error({ err }, "Impersonation error");
        res.status(500).json({ error: "Failed to start impersonation" });
    }
});

// POST /admin/tenants/:id/exit-impersonate
router.post("/:id/exit-impersonate", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const actorId = req.impersonatedBy || req.userId;

        // Flush in-memory session and build summary
        const session = endImpSession(actorId, tid);
        const summary = buildSessionSummary(session);

        // Update the SAME audit row: set ended_at and full session details
        if (session.auditLogId) {
            updatePlatformAuditLog(session.auditLogId, {
                ended_at: new Date(),
                details: {
                    target_user: summary.actions[0]?.as_user || null,
                    duration_seconds: Math.round((Date.now() - new Date(summary.session_start).getTime()) / 1000),
                    total_actions: summary.total,
                    reads: summary.reads,
                    writes: summary.writes,
                    actions: summary.actions,
                },
            });
        }

        // Restore the original platform admin token from the saved cookie
        const origToken = req.cookies._wp_orig_token;
        if (origToken) {
            res.cookie("token", origToken, cookieOptions(req, 8 * 60 * 60 * 1000));
            res.clearCookie("_wp_orig_token", { httpOnly: true, sameSite: "strict", path: "/" });
        }

        res.json({
            message: "Impersonation ended.",
            session_summary: summary,
        });
    } catch (err) {
        logger.error({ err }, "Exit impersonation error");
        res.status(500).json({ error: "Failed to exit impersonation" });
    }
});

// GET /admin/tenants/:id/impersonation-session — live actions during current impersonation
router.get("/:id/impersonation-session", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const actorId = req.impersonatedBy || req.userId;
        const session = getImpSession(actorId, tid);
        res.json(buildSessionSummary(session));
    } catch (err) {
        logger.error({ err }, "Get impersonation session error");
        res.status(500).json({ error: "Failed to get session actions" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  CROSS-TENANT USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Default-tenant guard: per the privacy model, platform admins may only see
// individual user data (PII) for the DEFAULT tenant. For every other tenant,
// row-level user access is gated behind the consent-based impersonation flow.
// Aggregate counts (no PII) are unaffected — only these row-returning user
// endpoints are restricted.
const NON_DEFAULT_USER_DATA_MSG =
    "User data for non-default tenants is only accessible via approved impersonation.";

function ensureDefaultTenant(tenant: any, res: Response): boolean {
    if (!tenant.is_default) {
        res.status(403).json({ error: NON_DEFAULT_USER_DATA_MSG, code: "TENANT_USER_DATA_RESTRICTED" });
        return false;
    }
    return true;
}

// GET /admin/tenants/:id/users
router.get("/:id/users", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });
        if (!ensureDefaultTenant(tenant, res)) return;

        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const { search, limit: rawLimit, offset } = req.query as Record<string, string>;
        const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        let whereClause = "";
        const params: unknown[] = [];
        if (search) {
            whereClause = "WHERE u.full_name ILIKE $1 OR u.username ILIKE $1 OR u.email ILIKE $1";
            params.push(`%${search}%`);
        }

        const countRes = await db.query(`SELECT COUNT(*) FROM users u ${whereClause}`, params);
        const usersRes = await db.query(
            `SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active, u.org_id, u.created_at
             FROM users u ${whereClause}
             ORDER BY u.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, off]
        );

        res.json({ total: parseInt(countRes.rows[0].count, 10), users: usersRes.rows });
    } catch (err) {
        logger.error({ err }, "List tenant users error");
        res.status(500).json({ error: "Failed to list users" });
    }
});

// POST /admin/tenants/:id/users — create user in a tenant
router.post("/:id/users", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant || tenant.status !== "active") {
            return res.status(404).json({ error: "Tenant not found or not active" });
        }

        const { username, password, full_name, email, role } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: "username, password, full_name and email are required" });
        }

        const pwError = await validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });

        const db = await getTenantPool(tenant.db_name, tenant.db_host);

        // Default-tenant guard, with a bootstrap exception: platform admins may
        // create the INITIAL tenant administrator for a brand-new non-default
        // tenant during onboarding. Once the tenant has its own (non-platform)
        // user, further row-level user management is gated behind the
        // consent-based impersonation flow (see NON_DEFAULT_USER_DATA_MSG).
        if (!tenant.is_default) {
            const existing = await db.query(
                "SELECT 1 FROM users WHERE role <> 'platform_admin' LIMIT 1"
            );
            if (existing.rows[0]) {
                return res.status(403).json({ error: NON_DEFAULT_USER_DATA_MSG, code: "TENANT_USER_DATA_RESTRICTED" });
            }
        }

        // Check global uniqueness
        const dirCheck = await masterQuery(
            "SELECT 1 FROM user_directory WHERE email = $1 OR username = $2",
            [email.toLowerCase(), username.toLowerCase()]
        );
        if (dirCheck.rows[0]) {
            return res.status(409).json({ error: "Email or username already exists globally." });
        }

        // Check tenant user limit
        if (tenant.max_users) {
            const countRes = await masterQuery("SELECT COUNT(*) FROM user_directory WHERE tenant_id = $1", [tid]);
            if (parseInt(countRes.rows[0].count, 10) >= tenant.max_users) {
                return res.status(403).json({ error: `Tenant user limit (${tenant.max_users}) reached.` });
            }
        }

        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const validRole = ["super_admin", "hr_admin", "manager", "team_lead", "employee"].includes(role) ? role : "employee";

        const result = await db.query(
            "INSERT INTO users (username, password, full_name, email, org_id, role) VALUES ($1,$2,$3,$4,1,$5) RETURNING id, username, full_name, email, role",
            [username, hash, full_name, email, validRole]
        );

        // Add to user_directory
        await masterQuery(
            "INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4)",
            [email.toLowerCase(), username.toLowerCase(), tid, result.rows[0].id]
        );

        logPlatformAction(req, "tenant_user_created", "user", result.rows[0].id, { tenant_id: tid, username }, tid);
        res.status(201).json({ user: result.rows[0] });
    } catch (err) {
        logger.error({ err }, "Create tenant user error");
        res.status(500).json({ error: "Failed to create user" });
    }
});

// PUT /admin/tenants/:tenantId/users/:userId/deactivate
router.put("/:tenantId/users/:userId/deactivate", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.tenantId);
        const uid = Number(req.params.userId);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });
        if (!ensureDefaultTenant(tenant, res)) return;

        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const result = await db.query(
            "UPDATE users SET is_active = FALSE WHERE id = $1 RETURNING id, username",
            [uid]
        );
        if (!result.rows[0]) return res.status(404).json({ error: "User not found" });

        logPlatformAction(req, "tenant_user_deactivated", "user", uid, { tenant_id: tid }, tid);
        res.json({ message: "User deactivated", user: result.rows[0] });
    } catch (err) {
        logger.error({ err }, "Deactivate tenant user error");
        res.status(500).json({ error: "Failed to deactivate user" });
    }
});

// ═══════════════════════════════════════════════════════════════
//  TENANT SEED DATA
// ═══════════════════════════════════════════════════════════════

// POST /admin/tenants/:id/seed — seed default data for a new tenant
router.post("/:id/seed", async (req: Request, res: Response) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant || tenant.status !== "active") {
            return res.status(404).json({ error: "Tenant not found or not active" });
        }

        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const seeded = { departments: 0, leave_policies: 0 };

        // Seed default departments
        const defaultDepts = ["Engineering", "Product", "Design", "Marketing", "Sales", "Human Resources", "Finance"];
        for (const name of defaultDepts) {
            const exists = (await db.query("SELECT id FROM departments WHERE org_id = 1 AND LOWER(name) = LOWER($1)", [name])).rows[0];
            if (!exists) {
                await db.query("INSERT INTO departments (org_id, name) VALUES (1, $1)", [name]);
                seeded.departments++;
            }
        }

        // Seed default leave policies
        const defaultPolicies = [
            { leave_type: "Annual Leave", annual_quota: 20, carry_forward_limit: 5 },
            { leave_type: "Sick Leave", annual_quota: 10, carry_forward_limit: 0 },
            { leave_type: "Personal Leave", annual_quota: 5, carry_forward_limit: 0 },
        ];
        for (const pol of defaultPolicies) {
            const exists = (await db.query("SELECT id FROM leave_policies WHERE org_id = 1 AND LOWER(leave_type) = LOWER($1)", [pol.leave_type])).rows[0];
            if (!exists) {
                await db.query(
                    "INSERT INTO leave_policies (org_id, leave_type, annual_quota, carry_forward_limit) VALUES (1, $1, $2, $3)",
                    [pol.leave_type, pol.annual_quota, pol.carry_forward_limit]
                );
                seeded.leave_policies++;
            }
        }

        logPlatformAction(req, "tenant_seeded", "tenant", tid, seeded, tid);
        res.json({ message: "Seed data applied", seeded });
    } catch (err) {
        logger.error({ err }, "Seed tenant error");
        res.status(500).json({ error: "Failed to seed tenant data" });
    }
});

export = router;