/**
 * Organization, Department & Team management routes.
 */
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');

const router = express.Router();

// All routes require auth + RBAC context
router.use(auth, loadUserContext);

// ==================== ORGANIZATIONS ====================

// Create an organization (super_admin only)
router.post('/', requireRole('super_admin'), (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Organization name is required' });
    if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });

    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
    if (existing) return res.status(400).json({ error: 'An organization with a similar name already exists' });

    const result = db.prepare(
        'INSERT INTO organizations (name, slug, created_by) VALUES (?, ?, ?)'
    ).run(name.trim(), slug, req.userId);

    // Assign the creator as super_admin of this org
    db.prepare('UPDATE users SET org_id = ?, role = ? WHERE id = ?').run(result.lastInsertRowid, 'super_admin', req.userId);

    logAction(req, 'create', 'organization', result.lastInsertRowid, { name: name.trim() });

    res.json({
        id: result.lastInsertRowid,
        name: name.trim(),
        slug,
        message: 'Organization created successfully'
    });
});

// Get current user's org details
router.get('/current', (req, res) => {
    if (!req.userOrgId) return res.json(null);

    const org = db.prepare(`
        SELECT o.*,
            (SELECT COUNT(*) FROM users WHERE org_id = o.id AND is_active = 1) AS memberCount,
            (SELECT COUNT(*) FROM departments WHERE org_id = o.id) AS deptCount,
            (SELECT COUNT(*) FROM teams WHERE org_id = o.id) AS teamCount
        FROM organizations o WHERE o.id = ?
    `).get(req.userOrgId);
    if (!org) return res.json(null);

    res.json(org);
});

// Update org settings (hr_admin+)
router.put('/settings', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { name, work_hours_per_day, work_days, timezone, fiscal_year_start } = req.body;

    const updates = [];
    const params = [];

    if (name) { updates.push('name = ?'); params.push(name.trim()); }
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

    params.push(req.userOrgId);
    db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logAction(req, 'update', 'organization', req.userOrgId, req.body);

    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.userOrgId);
    res.json(org);
});

// Get org members (team_lead+)
router.get('/members', requireRole('team_lead'), requireSameOrg, (req, res) => {
    const { search, role, department_id, team_id, is_active } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.per_page) || 50, 1), 100);

    let where = ['u.org_id = ?'];
    let params = [req.userOrgId];

    if (search) {
        where.push("(u.full_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)");
        const s = `%${search}%`;
        params.push(s, s, s);
    }
    if (role) { where.push('u.role = ?'); params.push(role); }
    if (department_id) { where.push('u.department_id = ?'); params.push(Number(department_id)); }
    if (team_id) { where.push('u.team_id = ?'); params.push(Number(team_id)); }
    if (is_active !== undefined) { where.push('u.is_active = ?'); params.push(is_active === 'true' ? 1 : 0); }

    const whereClause = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) as count FROM users u WHERE ${whereClause}`).get(...params).count;

    const members = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
               u.department_id, u.team_id, u.is_active, u.created_at,
               d.name as department_name, t.name as team_name
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN teams t ON t.id = u.team_id
        WHERE ${whereClause}
        ORDER BY u.full_name ASC
        LIMIT ? OFFSET ?
    `).all(...params, perPage, (page - 1) * perPage);

    res.json({ data: members, total, page, perPage });
});

// Invite / add a user to org (hr_admin+)
router.post('/invite', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { user_id, role, department_id, team_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'User ID is required' });

    const target = db.prepare('SELECT id, org_id, role, full_name FROM users WHERE id = ?').get(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.org_id) return res.status(400).json({ error: 'User already belongs to an organization' });

    const assignRole = role || 'employee';
    // Validate the assigned role and prevent assigning a role >= your own
    const validInviteRoles = ['employee', 'team_lead', 'manager', 'hr_admin'];
    if (!validInviteRoles.includes(assignRole)) {
        return res.status(400).json({ error: `Invalid role. Valid roles: ${validInviteRoles.join(', ')}` });
    }
    if ((ROLE_LEVEL[assignRole] || 1) >= (req.roleLevel || 1)) {
        return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
    }

    // Validate department belongs to this org
    if (department_id) {
        const dept = db.prepare('SELECT id FROM departments WHERE id = ? AND org_id = ?').get(Number(department_id), req.userOrgId);
        if (!dept) return res.status(400).json({ error: 'Department not found in this organization' });
    }
    // Validate team belongs to this org
    if (team_id) {
        const team = db.prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?').get(Number(team_id), req.userOrgId);
        if (!team) return res.status(400).json({ error: 'Team not found in this organization' });
    }

    db.prepare('UPDATE users SET org_id = ?, role = ?, department_id = ?, team_id = ? WHERE id = ?')
        .run(req.userOrgId, assignRole, department_id || null, team_id || null, user_id);

    logAction(req, 'invite', 'user', user_id, { role: assignRole, department_id, team_id });

    res.json({ message: `${target.full_name} added to the organization` });
});

// Remove user from org (hr_admin+)
router.post('/remove-member', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'User ID is required' });

    const target = db.prepare('SELECT id, org_id, role, full_name FROM users WHERE id = ?').get(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.org_id !== req.userOrgId) return res.status(400).json({ error: 'User is not in your organization' });
    if (target.id === req.userId) return res.status(400).json({ error: 'You cannot remove yourself' });

    db.prepare('UPDATE users SET org_id = NULL, team_id = NULL, department_id = NULL, role = ? WHERE id = ?')
        .run('employee', user_id);

    logAction(req, 'remove_member', 'user', user_id, { name: target.full_name });

    res.json({ message: `${target.full_name} has been removed from the organization` });
});

// ==================== DEPARTMENTS ====================

// List departments
router.get('/departments', requireSameOrg, (req, res) => {
    const departments = db.prepare(`
        SELECT d.*, u.full_name as head_name,
               (SELECT COUNT(*) FROM users WHERE department_id = d.id AND is_active = 1) as member_count
        FROM departments d
        LEFT JOIN users u ON u.id = d.head_id
        WHERE d.org_id = ?
        ORDER BY d.name
    `).all(req.userOrgId);

    res.json(departments);
});

// Create department (manager+)
router.post('/departments', requireRole('manager'), requireSameOrg, (req, res) => {
    const { name, head_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Department name is required' });

    try {
        const result = db.prepare('INSERT INTO departments (org_id, name, head_id) VALUES (?, ?, ?)')
            .run(req.userOrgId, name.trim(), head_id || null);
        logAction(req, 'create', 'department', result.lastInsertRowid, { name: name.trim() });
        res.json({ id: result.lastInsertRowid, name: name.trim(), message: 'Department created' });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Department name already exists' });
        throw e;
    }
});

// Update department (manager+)
router.put('/departments/:id', requireRole('manager'), requireSameOrg, (req, res) => {
    const { id } = req.params;
    const { name, head_id } = req.body;

    const dept = db.prepare('SELECT * FROM departments WHERE id = ? AND org_id = ?').get(id, req.userOrgId);
    if (!dept) return res.status(404).json({ error: 'Department not found' });

    db.prepare('UPDATE departments SET name = ?, head_id = ? WHERE id = ?')
        .run(name?.trim() || dept.name, head_id !== undefined ? head_id : dept.head_id, id);

    logAction(req, 'update', 'department', Number(id), { name, head_id });
    res.json({ message: 'Department updated' });
});

// Delete department (hr_admin+)
router.delete('/departments/:id', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { id } = req.params;
    const dept = db.prepare('SELECT * FROM departments WHERE id = ? AND org_id = ?').get(id, req.userOrgId);
    if (!dept) return res.status(404).json({ error: 'Department not found' });

    // Remove department association from users
    db.prepare('UPDATE users SET department_id = NULL WHERE department_id = ?').run(id);
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);

    logAction(req, 'delete', 'department', Number(id), { name: dept.name });
    res.json({ message: 'Department deleted' });
});

// ==================== TEAMS ====================

// List teams
router.get('/teams', requireSameOrg, (req, res) => {
    const { department_id } = req.query;
    let where = 't.org_id = ?';
    let params = [req.userOrgId];

    if (department_id) {
        where += ' AND t.department_id = ?';
        params.push(Number(department_id));
    }

    const teams = db.prepare(`
        SELECT t.*, u.full_name as lead_name, d.name as department_name,
               (SELECT COUNT(*) FROM users WHERE team_id = t.id AND is_active = 1) as member_count
        FROM teams t
        LEFT JOIN users u ON u.id = t.lead_id
        LEFT JOIN departments d ON d.id = t.department_id
        WHERE ${where}
        ORDER BY t.name
    `).all(...params);

    res.json(teams);
});

// Create team (team_lead+)
router.post('/teams', requireRole('team_lead'), requireSameOrg, (req, res) => {
    const { name, department_id, lead_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Team name is required' });

    try {
        const result = db.prepare('INSERT INTO teams (org_id, department_id, name, lead_id) VALUES (?, ?, ?, ?)')
            .run(req.userOrgId, department_id || null, name.trim(), lead_id || null);
        logAction(req, 'create', 'team', result.lastInsertRowid, { name: name.trim(), department_id });
        res.json({ id: result.lastInsertRowid, name: name.trim(), message: 'Team created' });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Team name already exists' });
        throw e;
    }
});

// Update team (team_lead+)
router.put('/teams/:id', requireRole('team_lead'), requireSameOrg, (req, res) => {
    const { id } = req.params;
    const { name, department_id, lead_id } = req.body;

    const team = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(id, req.userOrgId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    db.prepare('UPDATE teams SET name = ?, department_id = ?, lead_id = ? WHERE id = ?')
        .run(name?.trim() || team.name, department_id !== undefined ? department_id : team.department_id, lead_id !== undefined ? lead_id : team.lead_id, id);

    logAction(req, 'update', 'team', Number(id), { name, department_id, lead_id });
    res.json({ message: 'Team updated' });
});

// Delete team (manager+)
router.delete('/teams/:id', requireRole('manager'), requireSameOrg, (req, res) => {
    const { id } = req.params;
    const team = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(id, req.userOrgId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    db.prepare('UPDATE users SET team_id = NULL WHERE team_id = ?').run(id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(id);

    logAction(req, 'delete', 'team', Number(id), { name: team.name });
    res.json({ message: 'Team deleted' });
});

// ==================== ORG CHART ====================

router.get('/chart', requireSameOrg, (req, res) => {
    const departments = db.prepare(`
        SELECT d.id, d.name, d.head_id, u.full_name as head_name, u.avatar as head_avatar
        FROM departments d
        LEFT JOIN users u ON u.id = d.head_id
        WHERE d.org_id = ?
        ORDER BY d.name
    `).all(req.userOrgId);

    const teams = db.prepare(`
        SELECT t.id, t.name, t.department_id, t.lead_id, u.full_name as lead_name, u.avatar as lead_avatar
        FROM teams t
        LEFT JOIN users u ON u.id = t.lead_id
        WHERE t.org_id = ?
        ORDER BY t.name
    `).all(req.userOrgId);

    const members = db.prepare(`
        SELECT id, full_name, avatar, role, department_id, team_id
        FROM users
        WHERE org_id = ? AND is_active = 1
        ORDER BY full_name
    `).all(req.userOrgId);

    res.json({ departments, teams, members });
});

module.exports = router;
