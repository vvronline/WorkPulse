/**
 * Role-Based Access Control (RBAC) middleware.
 *
 * Roles hierarchy (higher includes all lower permissions):
 *   super_admin > hr_admin > manager > team_lead > employee
 */
const { query } = require('../db');
const { logger } = require('../utils/logger');

const ROLE_LEVEL = {
    employee: 1,
    team_lead: 2,
    manager: 3,
    hr_admin: 4,
    super_admin: 5,
};

const VALID_ROLES = Object.keys(ROLE_LEVEL);

/**
 * Middleware: populate req.userRole, req.userOrgId, req.userTeamId, req.userDeptId
 * Must be used AFTER auth middleware.
 */
async function loadUserContext(req, res, next) {
    try {
        const result = await query(
            'SELECT role, org_id, team_id, department_id, manager_id, is_active FROM users WHERE id = $1',
            [req.userId]
        );
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'User not found' });
        if (!user.is_active) return res.status(403).json({ error: 'Account has been deactivated. Contact your administrator.' });

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
 */
async function requireSameOrg(req, res, next) {
    if (req.userRole === 'super_admin') return next();
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
 */
async function getVisibleUserIds(userId, role, orgId, teamId) {
    const idSet = new Set();
    idSet.add(userId); // Always include the requesting user

    const directRes = await query(
        'SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE',
        [userId]
    );
    directRes.rows.forEach(u => idSet.add(u.id));

    if (orgId) {
        if (ROLE_LEVEL[role] >= ROLE_LEVEL.hr_admin) {
            const res = await query('SELECT id FROM users WHERE org_id = $1 AND is_active = TRUE', [orgId]);
            res.rows.forEach(u => idSet.add(u.id));
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.manager) {
            const userRes = await query('SELECT department_id FROM users WHERE id = $1', [userId]);
            const deptId = userRes.rows[0]?.department_id;
            if (deptId) {
                const res = await query(
                    'SELECT id FROM users WHERE org_id = $1 AND department_id = $2 AND is_active = TRUE',
                    [orgId, deptId]
                );
                res.rows.forEach(u => idSet.add(u.id));
            }
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.team_lead && teamId) {
            const res = await query(
                'SELECT id FROM users WHERE org_id = $1 AND team_id = $2 AND is_active = TRUE',
                [orgId, teamId]
            );
            res.rows.forEach(u => idSet.add(u.id));
        }
    }

    return [...idSet];
}

module.exports = {
    ROLE_LEVEL,
    VALID_ROLES,
    loadUserContext,
    requireRole,
    requireSameOrg,
    canManageUser,
    getVisibleUserIds,
};