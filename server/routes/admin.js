/**
 * Admin routes — user management, role assignment, audit logs, org-wide stats.
 * All routes require hr_admin+ role.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg, canManageUser, VALID_ROLES } = require('../middleware/rbac');
const { logAction, queryLogs } = require('../utils/audit');

const router = express.Router();

router.use(auth, loadUserContext, requireRole('hr_admin'));

// ==================== USER MANAGEMENT ====================

// List all users (optionally across all orgs for super_admin)
router.get('/users', (req, res) => {
    const { search, role, is_active, org_id } = req.query;

    let where = [];
    let params = [];

    // Super admin can see all users; others only see their org
    if (req.userRole === 'super_admin' && org_id) {
        where.push('u.org_id = ?');
        params.push(Number(org_id));
    } else if (req.userRole !== 'super_admin') {
        if (req.userOrgId) {
            where.push('u.org_id = ?');
            params.push(req.userOrgId);
        } else {
            where.push('u.id = ?');
            params.push(req.userId);
        }
    }

    if (search) {
        where.push("(u.full_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)");
        const s = `%${search}%`;
        params.push(s, s, s);
    }
    if (role) { where.push('u.role = ?'); params.push(role); }
    if (is_active !== undefined) { where.push('u.is_active = ?'); params.push(is_active === 'true' ? 1 : 0); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const users = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
               u.is_active, u.org_id, u.department_id, u.team_id, u.created_at,
               o.name as org_name, d.name as department_name, t.name as team_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.org_id
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        ${whereClause}
        ORDER BY u.created_at DESC
    `).all(...params);

    res.json(users);
});

// Get single user details
router.get('/users/:id', (req, res) => {
    const { id } = req.params;
    const user = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
               u.is_active, u.org_id, u.department_id, u.team_id, u.created_at, u.timezone_offset,
               o.name as org_name, d.name as department_name, t.name as team_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.org_id
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        WHERE u.id = ?
    `).get(Number(id));

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Non-super admins can only view users in their org
    if (req.userRole !== 'super_admin' && user.org_id !== req.userOrgId) {
        return res.status(403).json({ error: 'Cannot view users outside your organization' });
    }

    res.json(user);
});

// Update user role
router.put('/users/:id/role', (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Invalid role. Valid roles: ${VALID_ROLES.join(', ')}` });
    }

    const target = db.prepare('SELECT id, role, org_id, full_name FROM users WHERE id = ?').get(Number(id));
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Cannot promote to same or higher level than self (except super_admin)
    if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, role)) {
        return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
    }

    // Cannot modify own role (except super_admin)
    if (Number(id) === req.userId && req.userRole !== 'super_admin') {
        return res.status(400).json({ error: 'Cannot change your own role' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, Number(id));
    logAction(req, 'update_role', 'user', Number(id), { old_role: target.role, new_role: role });

    res.json({ message: `${target.full_name}'s role updated to ${role}` });
});

// Assign user to department/team
router.put('/users/:id/assignment', (req, res) => {
    const { id } = req.params;
    const { department_id, team_id } = req.body;

    const target = db.prepare('SELECT id, org_id, full_name FROM users WHERE id = ?').get(Number(id));
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (req.userRole !== 'super_admin' && target.org_id !== req.userOrgId) {
        return res.status(403).json({ error: 'User is not in your organization' });
    }

    db.prepare('UPDATE users SET department_id = ?, team_id = ? WHERE id = ?')
        .run(department_id || null, team_id || null, Number(id));

    logAction(req, 'update_assignment', 'user', Number(id), { department_id, team_id });
    res.json({ message: `${target.full_name}'s assignment updated` });
});

// Deactivate user
router.put('/users/:id/deactivate', (req, res) => {
    const { id } = req.params;
    const target = db.prepare('SELECT id, role, org_id, full_name, is_active FROM users WHERE id = ?').get(Number(id));
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (Number(id) === req.userId) return res.status(400).json({ error: 'Cannot deactivate yourself' });

    if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, target.role)) {
        return res.status(403).json({ error: 'Cannot deactivate a user with equal or higher role' });
    }

    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(target.is_active ? 0 : 1, Number(id));
    const action = target.is_active ? 'deactivate' : 'reactivate';
    logAction(req, action, 'user', Number(id), { name: target.full_name });

    res.json({ message: `${target.full_name} has been ${action}d`, is_active: !target.is_active });
});

// Reset user's password (admin-initiated)
router.post('/users/:id/reset-password', async (req, res) => {
    const { id } = req.params;
    const { new_password } = req.body;

    if (!new_password || new_password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const target = db.prepare('SELECT id, role, org_id, full_name FROM users WHERE id = ?').get(Number(id));
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, target.role)) {
        return res.status(403).json({ error: 'Cannot reset password for a user with equal or higher role' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    db.prepare('UPDATE users SET password = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(hash, Number(id));

    logAction(req, 'admin_reset_password', 'user', Number(id), { name: target.full_name });
    res.json({ message: `Password reset for ${target.full_name}` });
});

// Create user (admin-created account)
router.post('/users', async (req, res) => {
    const { username, password, full_name, email, role, department_id, team_id } = req.body;

    if (!username || !password || !full_name || !email) {
        return res.status(400).json({ error: 'Username, password, full name and email are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) return res.status(400).json({ error: 'Username or email already taken' });

    const assignRole = VALID_ROLES.includes(role) ? role : 'employee';
    const hash = await bcrypt.hash(password, 10);

    const result = db.prepare(
        'INSERT INTO users (username, password, full_name, email, role, org_id, department_id, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(username, hash, full_name, email, assignRole, req.userOrgId, department_id || null, team_id || null);

    logAction(req, 'admin_create', 'user', result.lastInsertRowid, { username, role: assignRole });

    res.json({ id: result.lastInsertRowid, message: `User ${username} created successfully` });
});

// ==================== AUDIT LOGS ====================

router.get('/audit-logs', (req, res) => {
    const { actor_id, entity_type, entity_id, action, from, to, limit, offset } = req.query;

    const orgId = req.userRole === 'super_admin' ? (req.query.org_id || null) : req.userOrgId;

    const result = queryLogs({
        orgId,
        actorId: actor_id ? Number(actor_id) : null,
        entityType: entity_type || null,
        entityId: entity_id ? Number(entity_id) : null,
        action: action || null,
        from: from || null,
        to: to || null,
        limit: Math.min(Number(limit) || 100, 500),
        offset: Number(offset) || 0,
    });

    res.json(result);
});

// ==================== ORG DASHBOARD STATS ====================

router.get('/stats', requireSameOrg, (req, res) => {
    const orgId = req.userOrgId;

    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE org_id = ?').get(orgId).c;
    const activeUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE org_id = ? AND is_active = 1').get(orgId).c;
    const departments = db.prepare('SELECT COUNT(*) as c FROM departments WHERE org_id = ?').get(orgId).c;
    const teams = db.prepare('SELECT COUNT(*) as c FROM teams WHERE org_id = ?').get(orgId).c;

    const pendingApprovals = db.prepare(
        'SELECT COUNT(*) as c FROM approval_requests WHERE org_id = ? AND status = ?'
    ).get(orgId, 'pending').c;

    // Today's attendance
    const today = new Date().toISOString().slice(0, 10);
    const clockedInToday = db.prepare(`
        SELECT COUNT(DISTINCT user_id) as c
        FROM time_entries
        WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)
          AND date(timestamp) = date(?)
          AND entry_type = 'clock_in'
    `).get(orgId, today).c;

    res.json({
        totalUsers, activeUsers, departments, teams,
        pendingApprovals, clockedInToday
    });
});

module.exports = router;
