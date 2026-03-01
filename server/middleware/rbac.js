/**
 * Role-Based Access Control (RBAC) middleware.
 *
 * Roles hierarchy (higher includes all lower permissions):
 *   super_admin > hr_admin > manager > team_lead > employee
 *
 * Usage:
 *   router.get('/admin-only', auth, requireRole('hr_admin'), handler);
 *   router.get('/team-view', auth, requireRole('team_lead'), handler);
 */
const db = require('../db');

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
function loadUserContext(req, res, next) {
    const user = db.prepare(
        'SELECT role, org_id, team_id, department_id, is_active FROM users WHERE id = ?'
    ).get(req.userId);

    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.is_active) return res.status(403).json({ error: 'Account has been deactivated. Contact your administrator.' });

    req.userRole = user.role || 'employee';
    req.userOrgId = user.org_id || null;
    req.userTeamId = user.team_id || null;
    req.userDeptId = user.department_id || null;
    req.roleLevel = ROLE_LEVEL[req.userRole] || 1;
    next();
}

/**
 * Middleware factory: require minimum role level.
 * @param {string} minRole - minimum role required (e.g. 'manager')
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
 * Middleware: require that the user belongs to the same org.
 * Used for org-scoped operations.
 */
function requireSameOrg(req, res, next) {
    if (!req.userOrgId) {
        return res.status(403).json({ error: 'You are not part of any organization' });
    }
    next();
}

/**
 * Check if a user can manage another user (same org + higher role).
 */
function canManageUser(managerRole, targetRole) {
    return (ROLE_LEVEL[managerRole] || 1) > (ROLE_LEVEL[targetRole] || 1);
}

/**
 * Get all users that a manager/lead can see (same org, subordinates).
 */
function getVisibleUserIds(userId, role, orgId, teamId) {
    if (!orgId) return [userId];

    if (ROLE_LEVEL[role] >= ROLE_LEVEL.hr_admin) {
        // HR admins and super admins see entire org
        return db.prepare('SELECT id FROM users WHERE org_id = ? AND is_active = 1').all(orgId).map(u => u.id);
    }

    if (ROLE_LEVEL[role] >= ROLE_LEVEL.manager) {
        // Managers see their department
        const user = db.prepare('SELECT department_id FROM users WHERE id = ?').get(userId);
        if (user?.department_id) {
            return db.prepare('SELECT id FROM users WHERE org_id = ? AND department_id = ? AND is_active = 1')
                .all(orgId, user.department_id).map(u => u.id);
        }
    }

    if (ROLE_LEVEL[role] >= ROLE_LEVEL.team_lead && teamId) {
        // Team leads see their team
        return db.prepare('SELECT id FROM users WHERE org_id = ? AND team_id = ? AND is_active = 1')
            .all(orgId, teamId).map(u => u.id);
    }

    return [userId];
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
