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
        'SELECT role, org_id, team_id, department_id, manager_id, is_active FROM users WHERE id = ?'
    ).get(req.userId);

    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.is_active) return res.status(403).json({ error: 'Account has been deactivated. Contact your administrator.' });

    req.userRole = user.role || 'employee';
    req.userOrgId = user.org_id || null;
    req.userTeamId = user.team_id || null;
    req.userDeptId = user.department_id || null;
    req.userManagerId = user.manager_id || null;
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
 * Middleware: require that the user belongs to an org OR has direct reports.
 * Used for org-scoped operations and manager views.
 */
function requireSameOrg(req, res, next) {
    // Super admins can access any org-scoped endpoint
    if (req.userRole === 'super_admin') return next();
    if (req.userOrgId) return next();
    // Allow if user has direct reports (is someone's manager)
    const hasReports = db.prepare('SELECT 1 FROM users WHERE manager_id = ? AND is_active = 1 LIMIT 1').get(req.userId);
    if (hasReports) return next();
    return res.status(403).json({ error: 'You are not part of any organization and have no team members assigned' });
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
    const idSet = new Set();

    // Always include direct reports (users who have this user as manager_id)
    const directReports = db.prepare('SELECT id FROM users WHERE manager_id = ? AND is_active = 1').all(userId);
    directReports.forEach(u => idSet.add(u.id));

    if (orgId) {
        if (ROLE_LEVEL[role] >= ROLE_LEVEL.hr_admin) {
            // HR admins and super admins see entire org
            db.prepare('SELECT id FROM users WHERE org_id = ? AND is_active = 1').all(orgId).forEach(u => idSet.add(u.id));
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.manager) {
            // Managers see their department
            const user = db.prepare('SELECT department_id FROM users WHERE id = ?').get(userId);
            if (user?.department_id) {
                db.prepare('SELECT id FROM users WHERE org_id = ? AND department_id = ? AND is_active = 1')
                    .all(orgId, user.department_id).forEach(u => idSet.add(u.id));
            }
        } else if (ROLE_LEVEL[role] >= ROLE_LEVEL.team_lead && teamId) {
            // Team leads see their team
            db.prepare('SELECT id FROM users WHERE org_id = ? AND team_id = ? AND is_active = 1')
                .all(orgId, teamId).forEach(u => idSet.add(u.id));
        }
    }

    // If still empty, include self
    if (idSet.size === 0) idSet.add(userId);

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
