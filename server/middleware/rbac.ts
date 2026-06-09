/**
 * Role-Based Access Control (RBAC) middleware.
 *
 * Permission levels (higher includes all lower permissions):
 *   1 = employee   (standard team member)
 *   2 = team_lead
 *   3 = manager
 *   4 = hr_admin
 *   5 = super_admin   (org-wide admin — system role, NOT in tenant_roles)
 *   6 = platform_admin (cross-org system operator)
 *
 * Tenants can define their own custom role *keys* and pin each one to a
 * permission level 1..4 via the `tenant_roles` table. The two top-level
 * roles (super_admin / platform_admin) are hardcoded here and apply
 * across every tenant.
 *
 * Throughout the codebase we use named role aliases (employee / team_lead
 * / manager / hr_admin) for `requireRole(...)` checks. These aliases map
 * to fixed permission levels — this means a tenant can rename the
 * `manager` role to `engineering_lead` (or add a brand-new "principal"
 * role at level 3) and the `requireRole('manager')` checks will still
 * fire correctly because they're driven by `req.roleLevel`, not by the
 * literal role string.
 */
import type { Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import * as redis from "../redis";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
interface DbLike { query: Query; }
type RolesMap = Record<string, number>;

/**
 * System-level roles. These names are NOT tenant-customisable; they are
 * referenced directly by middleware like impersonationAudit.js,
 * agileEditor.js, etc.
 *
 * Values are the *canonical permission levels*.
 */
const SYSTEM_ROLE_LEVEL: Record<string, number> = {
    super_admin: 5,
    platform_admin: 6,
};

/**
 * Permission-level constants. Used by `requireRole(name)` so existing
 * route handlers ("requireRole('manager')") keep working even when the
 * tenant has renamed the `manager` role.
 */
const ROLE_LEVEL: Record<string, number> = {
    employee: 1,
    team_lead: 2,
    manager: 3,
    hr_admin: 4,
    super_admin: SYSTEM_ROLE_LEVEL.super_admin,
    platform_admin: SYSTEM_ROLE_LEVEL.platform_admin,
};

/**
 * Canonical role keys that ship out-of-the-box for every tenant.
 * These are also the only valid `role` values for super_admin / platform_admin.
 *
 * Tenants may add new keys (and even delete the seeded ones, as long as no
 * users hold them) — this constant is just the seed list & the system
 * fallback used when tenant_roles can't be queried.
 */
const ORG_ROLES = ["employee", "team_lead", "manager", "hr_admin", "super_admin"];
const VALID_ROLES = Object.keys(ROLE_LEVEL);

/**
 * Default presentation for the canonical seeded roles. Used by the API
 * fallback when `tenant_roles` is missing (legacy DBs).
 */
const DEFAULT_TENANT_ROLES = [
    { role_key: "employee", label: "Employee", description: "Standard team member.", color: "#6b7280", permission_level: 1, is_system: true, sort_order: 1 },
    { role_key: "team_lead", label: "Team Lead", description: "Leads a single team, can review their team's work.", color: "#0ea5e9", permission_level: 2, is_system: true, sort_order: 2 },
    { role_key: "manager", label: "Manager", description: "Manages a department; approves leaves and tasks.", color: "#8b5cf6", permission_level: 3, is_system: true, sort_order: 3 },
    { role_key: "hr_admin", label: "HR Admin", description: "People-ops: invites, removes, manages org members.", color: "#f59e0b", permission_level: 4, is_system: true, sort_order: 4 },
];

/**
 * Resolve the effective permission level for a role string.
 *
 * Lookup order:
 *   1. SYSTEM_ROLE_LEVEL (super_admin / platform_admin)            – fixed
 *   2. Provided rolesMap (loaded from tenant_roles for the org)
 *   3. ROLE_LEVEL canonical fallback (employee/team_lead/manager/hr_admin)
 *   4. 1 (employee equivalent) — last resort so an unknown role can't
 *      escalate privileges; it just lands at the lowest level.
 */
function levelForRole(roleKey: string | null | undefined, rolesMap: RolesMap | null = null): number {
    if (!roleKey) return 1;
    if (SYSTEM_ROLE_LEVEL[roleKey] != null) return SYSTEM_ROLE_LEVEL[roleKey];
    if (rolesMap && rolesMap[roleKey] != null) return rolesMap[roleKey];
    if (ROLE_LEVEL[roleKey] != null) return ROLE_LEVEL[roleKey];
    return 1;
}

/**
 * Load all tenant_roles for an org as a key→level map. Cached in Redis
 * for 5 minutes per org.
 *
 * Falls back to {} (then to canonical defaults via levelForRole) if the
 * table is missing on a legacy DB (PG error 42P01).
 */
async function getTenantRolesMap(db: DbLike, orgId: number | null | undefined, tenantId: number | null | undefined): Promise<RolesMap> {
    if (!orgId) return {};
    try {
        const cached = await redis.getOrgRolesMap?.(tenantId, orgId) as RolesMap | null;
        if (cached) return cached;
    } catch { /* redis miss — fall through */ }
    try {
        const rows = (await db.query(
            "SELECT role_key, permission_level FROM tenant_roles WHERE org_id = $1",
            [orgId],
        )).rows;
        const map: RolesMap = {};
        for (const r of rows) map[r.role_key] = Number(r.permission_level);
        try { await redis.setOrgRolesMap?.(tenantId, orgId, map); } catch { /* best-effort */ }
        return map;
    } catch (err: any) {
        if (err && err.code !== "42P01") {
            logger.warn({ err: err.message, orgId }, "getTenantRolesMap failed; falling back to defaults");
        }
        return {};
    }
}

/**
 * Load the full label set for an org (including labels/colours/descriptions)
 * to be returned to the UI.
 */
async function getRoleLabels(db: DbLike, orgId: number | null | undefined): Promise<any[]> {
    if (!orgId) {
        return DEFAULT_TENANT_ROLES.map((r) => ({ ...r, customised: false }));
    }
    try {
        const rows = (await db.query(
            `SELECT role_key, label, description, color, permission_level, is_system, sort_order
             FROM tenant_roles
             WHERE org_id = $1
             ORDER BY sort_order ASC, role_key ASC`,
            [orgId],
        )).rows;
        if (rows.length === 0) {
            return DEFAULT_TENANT_ROLES.map((r) => ({ ...r, customised: false }));
        }
        return rows.map((r) => ({
            role_key: r.role_key,
            label: r.label,
            description: r.description,
            color: r.color,
            permission_level: Number(r.permission_level),
            is_system: r.is_system,
            sort_order: r.sort_order,
            customised: !r.is_system, // any non-system row is by definition tenant-defined
        }));
    } catch (err: any) {
        if (err && err.code !== "42P01") {
            logger.warn({ err: err.message, orgId }, "getRoleLabels fallback to defaults");
        }
        return DEFAULT_TENANT_ROLES.map((r) => ({ ...r, customised: false }));
    }
}

/**
 * Resolve req.roleLevel for the current request.
 *
 * Optimisation: when the user's role matches one of the canonical fallback
 * keys (employee/team_lead/manager/hr_admin/super_admin/platform_admin) we
 * return the level directly without touching the DB. Only custom tenant
 * keys trigger a tenant_roles lookup. This keeps the hot loadUserContext
 * path zero-extra-query for >99% of requests.
 */
async function resolveRoleLevel(req: any): Promise<number> {
    const role = req.userRole;
    if (!role) return 1;
    if (SYSTEM_ROLE_LEVEL[role] != null) return SYSTEM_ROLE_LEVEL[role];
    if (ROLE_LEVEL[role] != null) return ROLE_LEVEL[role];
    // Custom tenant role — load the map (cached) to find the level.
    const rolesMap = await getTenantRolesMap(req.db, req.userOrgId, req.tenantId);
    return levelForRole(role, rolesMap);
}

/**
 * Middleware: populate req.userRole, req.userOrgId, req.userTeamId, req.userDeptId,
 * req.roleLevel.
 *
 * Must be used AFTER auth middleware.
 */
async function loadUserContext(req: any, res: Response, next: NextFunction): Promise<void | Response> {
    try {
        // Platform admin WITHOUT tenant context: skip user table lookup
        if (req.isPlatformUser && !req.tenantId) {
            req.userRole = "platform_admin";
            req.userOrgId = null;
            req.userTeamId = null;
            req.userDeptId = null;
            req.userManagerId = null;
            req.roleLevel = SYSTEM_ROLE_LEVEL.platform_admin;
            return next();
        }

        // Virtual impersonation: platform admin entered a tenant with no users
        if (req.isImpersonated && req.userId === 0) {
            req.userRole = "platform_admin";
            req.userOrgId = null;
            req.userTeamId = null;
            req.userDeptId = null;
            req.userManagerId = null;
            req.roleLevel = SYSTEM_ROLE_LEVEL.platform_admin;
            return next();
        }

        const isPlatformWithTenant = (req.isPlatformUser && !!req.tenantId) || (req.isImpersonated && !!req.impersonatedBy);

        // Try Redis cache first
        const cached = await redis.getUserContext(req.tenantId, req.userId) as any;
        if (cached) {
            req.userRole = isPlatformWithTenant ? "platform_admin" : (cached.role || "employee");
            req.userOrgId = cached.org_id || null;
            req.userTeamId = cached.team_id || null;
            req.userDeptId = cached.department_id || null;
            req.userManagerId = cached.manager_id || null;
            req.roleLevel = await resolveRoleLevel(req);

            if (!cached.is_active) return res.status(403).json({ error: "Account has been deactivated. Contact your administrator." });
            return next();
        }

        const result = await req.db.query(
            "SELECT role, org_id, team_id, department_id, manager_id, is_active FROM users WHERE id = $1",
            [req.userId],
        );
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: "User not found" });
        if (!user.is_active) return res.status(403).json({ error: "Account has been deactivated. Contact your administrator." });

        await redis.setUserContext(req.tenantId, req.userId, {
            role: user.role, org_id: user.org_id, team_id: user.team_id,
            department_id: user.department_id, manager_id: user.manager_id, is_active: user.is_active,
        });

        req.userRole = isPlatformWithTenant ? "platform_admin" : (user.role || "employee");
        req.userOrgId = user.org_id || null;
        req.userTeamId = user.team_id || null;
        req.userDeptId = user.department_id || null;
        req.userManagerId = user.manager_id || null;
        req.roleLevel = await resolveRoleLevel(req);

        next();
    } catch (err) {
        logger.error({ err, userId: req.userId }, "loadUserContext error");
        return res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Middleware factory: require minimum permission level.
 * The arg can be a name (employee/team_lead/manager/hr_admin/super_admin/
 * platform_admin) or a numeric level.
 */
function requireRole(minRole: string | number) {
    const minLevel = typeof minRole === "number"
        ? minRole
        : (ROLE_LEVEL[minRole] || 1);
    return (req: any, res: Response, next: NextFunction): void | Response => {
        if ((req.roleLevel || 1) < minLevel) {
            return res.status(403).json({ error: "Insufficient permissions" });
        }
        next();
    };
}

/**
 * Middleware: require that the user belongs to an org OR has direct reports.
 * platform_admin is the only role that can operate cross-org without an org.
 */
async function requireSameOrg(req: any, res: Response, next: NextFunction): Promise<void | Response> {
    if (req.userRole === "platform_admin") return next();
    if (req.userOrgId) return next();
    try {
        const result = await req.db.query(
            "SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1",
            [req.userId],
        );
        if (result.rowCount > 0) return next();
        return res.status(403).json({ error: "You are not part of any organization and have no team members assigned" });
    } catch (err) {
        return res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Check if a user can manage another user (higher level required).
 * Looks up both roles in the same tenant rolesMap.
 */
function canManageUser(managerRole: string, targetRole: string, rolesMap: RolesMap | null = null): boolean {
    return levelForRole(managerRole, rolesMap) > levelForRole(targetRole, rolesMap);
}

/**
 * Get all user IDs visible to a manager/lead (async).
 * Only includes users with a strictly lower level (except self and direct reports).
 */
async function getVisibleUserIds(userId: number, role: string, orgId: number | null | undefined, teamId: number | null | undefined, db: DbLike, tenantId: number | null | undefined): Promise<number[]> {
    const idSet = new Set<number>();
    idSet.add(userId);

    const directRes = await db.query(
        "SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE",
        [userId],
    );
    directRes.rows.forEach((u) => idSet.add(u.id));

    const rolesMap = await getTenantRolesMap(db, orgId, tenantId);
    const myLevel = levelForRole(role, rolesMap);

    // Build list of role keys that are strictly below the requester's level
    const lowerKeys: string[] = [];
    for (const [k, lvl] of Object.entries(rolesMap)) {
        if (lvl < myLevel) lowerKeys.push(k);
    }
    // Also include the canonical system fallbacks (in case any users still
    // hold those keys but the tenant_roles row was deleted — defensive).
    for (const [k, lvl] of Object.entries(ROLE_LEVEL)) {
        if (lvl < myLevel && !lowerKeys.includes(k)) lowerKeys.push(k);
    }

    if (orgId && lowerKeys.length > 0) {
        if (myLevel >= SYSTEM_ROLE_LEVEL.super_admin) {
            const res = await db.query(
                "SELECT id FROM users WHERE org_id = $1 AND is_active = TRUE",
                [orgId],
            );
            res.rows.forEach((u) => idSet.add(u.id));
        } else if (myLevel >= ROLE_LEVEL.hr_admin) {
            const res = await db.query(
                "SELECT id FROM users WHERE org_id = $1 AND is_active = TRUE AND role = ANY($2::text[])",
                [orgId, lowerKeys],
            );
            res.rows.forEach((u) => idSet.add(u.id));
        } else if (myLevel >= ROLE_LEVEL.manager) {
            const userRes = await db.query("SELECT department_id FROM users WHERE id = $1", [userId]);
            const deptId = userRes.rows[0]?.department_id;
            if (deptId) {
                const res = await db.query(
                    "SELECT id FROM users WHERE org_id = $1 AND department_id = $2 AND is_active = TRUE AND role = ANY($3::text[])",
                    [orgId, deptId, lowerKeys],
                );
                res.rows.forEach((u) => idSet.add(u.id));
            }
        } else if (myLevel >= ROLE_LEVEL.team_lead && teamId) {
            const res = await db.query(
                "SELECT id FROM users WHERE org_id = $1 AND team_id = $2 AND is_active = TRUE AND role = ANY($3::text[])",
                [orgId, teamId, lowerKeys],
            );
            res.rows.forEach((u) => idSet.add(u.id));
        }
    }

    return [...idSet];
}

export {
    ROLE_LEVEL,
    SYSTEM_ROLE_LEVEL,
    VALID_ROLES,
    ORG_ROLES,
    DEFAULT_TENANT_ROLES,
    levelForRole,
    getTenantRolesMap,
    getRoleLabels,
    loadUserContext,
    requireRole,
    requireSameOrg,
    canManageUser,
    getVisibleUserIds,
};