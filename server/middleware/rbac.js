/**
 * Role-Based Access Control (RBAC) middleware.
 *
 * Roles hierarchy (higher includes all lower permissions):
 *   super_admin > hr_admin > manager > team_lead > employee
 */
const { query } = require('../db');
const { logger } = require('../utils/logger');
const redis = require('../redis');

const ROLE_LEVEL = {
    employee: 1,
    team_lead: 2,
    manager: 3,
    hr_admin: 4,
    super_admin: 5,
    platform_admin: 6, // System operator only — cross-org, no tenant assignment
};

// Roles that can be assigned to org members (excludes platform_admin)
const ORG_ROLES = ['employee', 'team_lead', 'manager', 'hr_admin', 'super_admin'];
const VALID_ROLES = Object.keys(ROLE_LEVEL);

/**
 * Middleware: populate req.userRole, req.userOrgId, req.userTeamId, req.userDeptId
 * Must be used AFTER auth middleware.
 */
async function loadUserContext(req, res, next) {
    try {
        // Try Redis cache first
        const cached = await redis.getUserContext(req.userId);
        if (cached) {
            req.userRole = cached.role || 'employee';
            req.userOrgId = cached.org_id || null;
            req.userTeamId = cached.team_id || null;
            req.userDeptId = cached.department_id || null;
            req.userManagerId = cached.manager_id || null;
            req.roleLevel = ROLE_LEVEL[req.userRole] || 1;
            if (!cached.is_active) return res.status(403).json({ error: 'Account has been deactivated. Contact your administrator.' });
            return next();
        }

        const result = await query(
            'SELECT role, org_id, team_id, department_id, manager_id, is_active FROM users WHERE id = $1',
            [req.userId]
        );
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'User not found' });
        if (!user.is_active) return res.status(403).json({ error: 'Account has been deactivated. Contact your administrator.' });

        // Cache user context in Redis
        await redis.setUserContext(req.userId, {
            role: user.role, org_id: user.org_id, team_id: user.team_id,
            department_id: user.department_id, manager_id: user.manager_id, is_active: user.is_active,
        });

        req.userRole = user.role || 'employee';
        req.userOrgId = user.org_id || null;
        req.userTeamId = user.team_id || null;
        req.userDeptId = user.department_id || null;
        req.userManagerId = user.manager_id || null;
        req.roleLevel = ROLE_LEVEL[req.userRole] || 1;
        next();
    } catch (err) {
        logger.error({ err, userId: req.userId }, 'loadUserContext error');
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * Middleware factory: require minimum role level.
 */
function requireRole(minRole) {
    const minLevel = ROLE_LEVEL[minRole] || 1;
    return (req, res, next) => {
        if ((req.roleLevel || 1) < minLevel) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

/**
 * Middleware: require that the user belongs to an org OR has direct reports.
 * platform_admin is the only role that can operate cross-org without an org.
 */
async function requireSameOrg(req, res, next) {
    if (req.userRole === 'platform_admin') return next(); // System operator — cross-org allowed
    if (req.userOrgId) return next();
    try {
        const result = await query(
            'SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1',
            [req.userId]
        );
        if (result.rowCount > 0) return next();
        return res.status(403).json({ error: 'You are not part of any organization and have no team members assigned' });
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * Check if a user can manage another user (higher role required).
 */
function canManageUser(managerRole, targetRole) {
    return (ROLE_LEVEL[managerRole] || 1) > (ROLE_LEVEL[targetRole] || 1);
}

/**
 * Get all user IDs visible to a manager/lead (async).
 * Only includes users with a strictly lower role level (except self and direct reports).
 */
async function getVisibleUserIds(userId, role, orgId, teamId) {
    const idSet = new Set();
    idSet.add(userId); // Always include the requesting user

    const directRes = await query(
        'SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE',
        [userId]
    );
    directRes.rows.forEach(u => idSet.add(u.id));

    const roleLevel = ROLE_LEVEL[role] || 1;
    // Determine which roles are strictly below the requester
    const lowerRoles = Object.entries(ROLE_LEVEL)
        .filter(([, lvl]) => lvl < roleLevel)
        .map(([r]) => r);

    if (orgId && lowerRoles.length > 0) {
        if (ROLE_LEVEL[role] >= ROLE_LEVEL.super_admin) {
            // super_admin sees all active org members (fully org-scoped tenant admin)
            const res = await query(
                'SELECT id FROM users WHERE org_id = $1 AND is_active = TRUE',
                [orgId]
            );
            res.rows.forEach(u => idSet.add(u.id));
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.hr_admin) {
            const res = await query(
                'SELECT id FROM users WHERE org_id = $1 AND is_active = TRUE AND role = ANY($2::text[])',
                [orgId, lowerRoles]
            );
            res.rows.forEach(u => idSet.add(u.id));
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.manager) {
            const userRes = await query('SELECT department_id FROM users WHERE id = $1', [userId]);
            const deptId = userRes.rows[0]?.department_id;
            if (deptId) {
                const res = await query(
                    'SELECT id FROM users WHERE org_id = $1 AND department_id = $2 AND is_active = TRUE AND role = ANY($3::text[])',
                    [orgId, deptId, lowerRoles]
                );
                res.rows.forEach(u => idSet.add(u.id));
            }
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.team_lead && teamId) {
            const res = await query(
                'SELECT id FROM users WHERE org_id = $1 AND team_id = $2 AND is_active = TRUE AND role = ANY($3::text[])',
                [orgId, teamId, lowerRoles]
            );
            res.rows.forEach(u => idSet.add(u.id));
        }
    }

    return [...idSet];
}

module.exports = {
    ROLE_LEVEL,
    VALID_ROLES,
    ORG_ROLES,
    loadUserContext,
    requireRole,
    requireSameOrg,
    canManageUser,
    getVisibleUserIds,
};