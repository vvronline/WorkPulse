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

// ==================== ORGANIZATIONS ====================

// List all organizations (super_admin only)
router.get('/organizations', requireRole('super_admin'), (req, res) => {
    const orgs = db.prepare(`
        SELECT o.id, o.name, o.slug,
               (SELECT COUNT(*) FROM users WHERE org_id = o.id AND is_active = 1) as member_count
        FROM organizations o
        ORDER BY o.name
    `).all();
    res.json(orgs);
});

// Get organization details (super_admin only)
router.get('/organizations/:id', requireRole('super_admin'), (req, res) => {
    const { id } = req.params;
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const memberCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE org_id = ? AND is_active = 1').get(id).count;
    const deptCount = db.prepare('SELECT COUNT(*) as count FROM departments WHERE org_id = ?').get(id).count;
    const teamCount = db.prepare('SELECT COUNT(*) as count FROM teams WHERE org_id = ?').get(id).count;

    res.json({ ...org, memberCount, deptCount, teamCount });
});

// Create organization (super_admin only)
router.post('/organizations', requireRole('super_admin'), (req, res) => {
    const { name, work_hours_per_day, work_days, timezone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Organization name is required' });
    if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });

    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
    if (existing) return res.status(400).json({ error: 'An organization with a similar name already exists' });

    const whpd = Number(work_hours_per_day) || 8;
    if (whpd < 1 || whpd > 24) return res.status(400).json({ error: 'Work hours per day must be between 1 and 24' });

    const result = db.prepare(
        'INSERT INTO organizations (name, slug, created_by, work_hours_per_day, work_days, timezone) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name.trim(), slug, req.userId, whpd, work_days || '1,2,3,4,5', timezone || 'UTC');

    logAction(req, 'admin_create', 'organization', result.lastInsertRowid, { name: name.trim() });

    res.json({ id: result.lastInsertRowid, name: name.trim(), slug, message: 'Organization created successfully' });
});

// Update organization (super_admin only)
router.put('/organizations/:id', requireRole('super_admin'), (req, res) => {
    const { id } = req.params;
    const { name, work_hours_per_day, work_days, timezone, fiscal_year_start } = req.body;

    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const updates = [];
    const params = [];

    if (name) {
        if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });
        updates.push('name = ?');
        params.push(name.trim());
    }
    if (work_hours_per_day !== undefined) {
        const whpd = Number(work_hours_per_day);
        if (isNaN(whpd) || whpd < 1 || whpd > 24) return res.status(400).json({ error: 'Work hours per day must be between 1 and 24' });
        updates.push('work_hours_per_day = ?'); params.push(whpd);
    }
    if (work_days) { updates.push('work_days = ?'); params.push(work_days); }
    if (timezone) { updates.push('timezone = ?'); params.push(timezone); }
    if (fiscal_year_start !== undefined) { updates.push('fiscal_year_start = ?'); params.push(Number(fiscal_year_start)); }
    updates.push('updated_at = CURRENT_TIMESTAMP');

    if (updates.length <= 1) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logAction(req, 'admin_update', 'organization', id, req.body);

    const updated = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
    res.json(updated);
});

// Delete organization (super_admin only)
router.delete('/organizations/:id', requireRole('super_admin'), (req, res) => {
    const { id } = req.params;
    const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Check if org has active users
    const activeUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE org_id = ? AND is_active = 1').get(id).count;
    if (activeUsers > 0) {
        return res.status(400).json({ error: `Cannot delete organization with ${activeUsers} active user(s). Deactivate or reassign users first.` });
    }

    // Delete related data first (departments, teams, inactive users)
    db.prepare('DELETE FROM teams WHERE org_id = ?').run(id);
    db.prepare('DELETE FROM departments WHERE org_id = ?').run(id);
    db.prepare('UPDATE users SET org_id = NULL, department_id = NULL, team_id = NULL WHERE org_id = ?').run(id);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(id);

    logAction(req, 'admin_delete', 'organization', id, { name: org.name });

    res.json({ message: `Organization "${org.name}" deleted successfully` });
});

// ==================== USER MANAGEMENT ====================

// List all users (optionally across all orgs for super_admin)
router.get('/users', (req, res) => {
    const { search, role, is_active, org_id } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.per_page) || 50, 1), 100);

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

    const total = db.prepare(`SELECT COUNT(*) as count FROM users u ${whereClause}`).get(...params).count;

    const users = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
               u.is_active, u.org_id, u.department_id, u.team_id, u.manager_id, u.created_at,
               o.name as org_name, d.name as department_name, t.name as team_name,
               m.full_name as manager_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.org_id
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        LEFT JOIN users m ON m.id = u.manager_id
        ${whereClause}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, perPage, (page - 1) * perPage);

    res.json({ data: users, total, page, perPage });
});

// Get single user details
router.get('/users/:id', (req, res) => {
    const { id } = req.params;
    const user = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
               u.is_active, u.org_id, u.department_id, u.team_id, u.manager_id, u.created_at, u.timezone_offset,
               o.name as org_name, d.name as department_name, t.name as team_name,
               m.full_name as manager_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.org_id
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        LEFT JOIN users m ON m.id = u.manager_id
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

    // Cannot modify a user whose current role is >= your own (except super_admin)
    if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, target.role)) {
        return res.status(403).json({ error: 'Cannot modify a user with a role equal to or higher than your own' });
    }
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

// Assign user to org/department/team
router.put('/users/:id/assignment', (req, res) => {
    const { id } = req.params;
    const { org_id, department_id, team_id, manager_id } = req.body;

    const target = db.prepare('SELECT id, org_id, full_name FROM users WHERE id = ?').get(Number(id));
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (req.userRole !== 'super_admin' && target.org_id !== req.userOrgId) {
        return res.status(403).json({ error: 'User is not in your organization' });
    }

    // Only super_admin can change org assignment
    if (org_id !== undefined && req.userRole !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admin can change organization assignment' });
    }

    // Validate org exists if provided
    if (org_id) {
        const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(Number(org_id));
        if (!org) return res.status(400).json({ error: 'Organization not found' });
    }

    // Validate manager_id exists if provided
    if (manager_id) {
        const mgr = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(Number(manager_id));
        if (!mgr) return res.status(400).json({ error: 'Manager not found' });
        if (Number(manager_id) === Number(id)) return res.status(400).json({ error: 'Cannot assign user as their own manager' });
    }

    // Validate department belongs to the target org
    if (department_id) {
        const dept = db.prepare('SELECT id FROM departments WHERE id = ? AND org_id = ?').get(Number(department_id), Number(newOrgId || 0));
        if (!dept) return res.status(400).json({ error: 'Department not found in the target organization' });
    }
    // Validate team belongs to the target org
    if (team_id) {
        const team = db.prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?').get(Number(team_id), Number(newOrgId || 0));
        if (!team) return res.status(400).json({ error: 'Team not found in the target organization' });
    }

    // If org changes, clear dept/team since they belong to the old org
    const newOrgId = org_id !== undefined ? (org_id || null) : target.org_id;
    const orgChanged = org_id !== undefined && Number(org_id || 0) !== Number(target.org_id || 0);
    const finalDeptId = orgChanged ? null : (department_id || null);
    const finalTeamId = orgChanged ? null : (team_id || null);
    const finalManagerId = orgChanged ? null : (manager_id || null);

    db.prepare('UPDATE users SET org_id = ?, department_id = ?, team_id = ?, manager_id = ? WHERE id = ?')
        .run(newOrgId, finalDeptId, finalTeamId, finalManagerId, Number(id));

    logAction(req, 'update_assignment', 'user', Number(id), { org_id: newOrgId, department_id: finalDeptId, team_id: finalTeamId, manager_id: finalManagerId });
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
    if (new_password.length > 72) {
        return res.status(400).json({ error: 'Password must be 72 characters or less' });
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
    const { username, password, full_name, email, role, org_id, department_id, team_id, manager_id } = req.body;

    if (!username || !password || !full_name || !email) {
        return res.status(400).json({ error: 'Username, password, full name and email are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (password.length > 72) return res.status(400).json({ error: 'Password must be 72 characters or less' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) return res.status(400).json({ error: 'Username or email already taken' });

    const assignRole = VALID_ROLES.includes(role) ? role : 'employee';
    const hash = await bcrypt.hash(password, 10);

    // super_admin can assign any org; hr_admin assigns to own org
    let assignOrgId = req.userOrgId;
    if (req.userRole === 'super_admin' && org_id !== undefined) {
        if (org_id) {
            const orgExists = db.prepare('SELECT id FROM organizations WHERE id = ?').get(org_id);
            if (!orgExists) return res.status(400).json({ error: 'Organization not found' });
        }
        assignOrgId = org_id || null;
    }

    const result = db.prepare(
        'INSERT INTO users (username, password, full_name, email, role, org_id, department_id, team_id, manager_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
    ).run(username, hash, full_name, email, assignRole, assignOrgId, department_id || null, team_id || null, manager_id || null);

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

    const counts = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM users WHERE org_id = ?) AS totalUsers,
            (SELECT COUNT(*) FROM users WHERE org_id = ? AND is_active = 1) AS activeUsers,
            (SELECT COUNT(*) FROM departments WHERE org_id = ?) AS departments,
            (SELECT COUNT(*) FROM teams WHERE org_id = ?) AS teams,
            (SELECT COUNT(*) FROM approval_requests WHERE org_id = ? AND status = 'pending') AS pendingApprovals
    `).get(orgId, orgId, orgId, orgId, orgId);

    // Today's attendance (use client timezone)
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const localNow = new Date(Date.now() - offsetMin * 60000);
    const today = localNow.toISOString().slice(0, 10);
    const shift = -offsetMin;
    const tzMod = `${shift >= 0 ? '+' : ''}${shift} minutes`;
    const clockedInToday = db.prepare(`
        SELECT COUNT(DISTINCT user_id) as c
        FROM time_entries
        WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)
          AND date(timestamp, ?) = date(?)
          AND entry_type = 'clock_in'
    `).get(orgId, tzMod, today).c;

    res.json({ ...counts, clockedInToday });
});

// ============= REGISTRATION SETTINGS =============

// Get current registration mode
router.get('/registration-settings', (req, res) => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'registration_mode'").get();
    res.json({ mode: row?.value || 'open' });
});

// Update registration mode
router.put('/registration-settings', (req, res) => {
    const { mode } = req.body;
    if (!['open', 'invite_only', 'closed'].includes(mode)) {
        return res.status(400).json({ error: 'Mode must be open, invite_only, or closed' });
    }
    const existing = db.prepare("SELECT 1 FROM app_settings WHERE key = 'registration_mode'").get();
    if (existing) {
        db.prepare("UPDATE app_settings SET value = ? WHERE key = 'registration_mode'").run(mode);
    } else {
        db.prepare("INSERT INTO app_settings (key, value) VALUES ('registration_mode', ?)").run(mode);
    }
    res.json({ mode, message: 'Registration mode updated' });
});

// List invite codes
router.get('/invite-codes', (req, res) => {
    const orgId = req.userOrgId;
    const codes = db.prepare(`
        SELECT ic.*, u.full_name as created_by_name
        FROM invite_codes ic
        LEFT JOIN users u ON u.id = ic.created_by
        WHERE ic.org_id = ? OR ic.org_id IS NULL
        ORDER BY ic.id DESC
    `).all(orgId || -1);
    res.json(codes);
});

// Create invite code
router.post('/invite-codes', (req, res) => {
    const { role, max_uses, expires_days } = req.body;
    const validRoles = ['employee', 'team_lead', 'manager', 'hr_admin'];
    if (role && !validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role for invite' });
    }
    const code = require('crypto').randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = expires_days ? new Date(Date.now() + expires_days * 86400000).toISOString() : null;
    db.prepare(`
        INSERT INTO invite_codes (code, created_by, org_id, role, max_uses, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(code, req.userId, req.userOrgId || null, role || 'employee', max_uses || 0, expiresAt);
    res.json({ code, message: 'Invite code created' });
});

// Deactivate invite code
router.delete('/invite-codes/:id', (req, res) => {
    // Scope to own org (or org-less codes for super_admin)
    const code = db.prepare('SELECT id, org_id FROM invite_codes WHERE id = ?').get(Number(req.params.id));
    if (!code) return res.status(404).json({ error: 'Invite code not found' });
    if (req.userRole !== 'super_admin' && code.org_id !== req.userOrgId) {
        return res.status(403).json({ error: 'Cannot deactivate invite codes from another organization' });
    }
    db.prepare('UPDATE invite_codes SET is_active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ message: 'Invite code deactivated' });
});

module.exports = router;
