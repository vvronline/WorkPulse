const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');

const router = express.Router();
router.use(auth, loadUserContext);

// ==================== ORGANIZATIONS ====================

router.post('/', requireRole('super_admin'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Organization name is required' });
        if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });

        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const existing = (await query('SELECT id FROM organizations WHERE slug = $1', [slug])).rows[0];
        if (existing) return res.status(400).json({ error: 'An organization with a similar name already exists' });

        const result = await query(
            'INSERT INTO organizations (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id',
            [name.trim(), slug, req.userId]
        );
        const orgId = result.rows[0].id;

        await query('UPDATE users SET org_id = $1, role = $2 WHERE id = $3', [orgId, 'super_admin', req.userId]);
        logAction(req, 'create', 'organization', orgId, { name: name.trim() });

        res.json({ id: orgId, name: name.trim(), slug, message: 'Organization created successfully' });
    } catch (err) {
        console.error('POST /organizations error:', err.message);
        res.status(500).json({ error: 'Failed to create organization' });
    }
});

router.get('/current', async (req, res) => {
    try {
        if (!req.userOrgId) return res.json(null);
        const org = (await query(`
            SELECT o.*,
                (SELECT COUNT(*) FROM users WHERE org_id = o.id AND is_active = TRUE)::integer AS "memberCount",
                (SELECT COUNT(*) FROM departments WHERE org_id = o.id)::integer AS "deptCount",
                (SELECT COUNT(*) FROM teams WHERE org_id = o.id)::integer AS "teamCount"
            FROM organizations o WHERE o.id = $1
        `, [req.userOrgId])).rows[0];
        if (!org) return res.json(null);
        res.json(org);
    } catch (err) {
        console.error('GET /organizations/current error:', err.message);
        res.status(500).json({ error: 'Failed to fetch organization' });
    }
});

router.put('/settings', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { name, work_hours_per_day, work_days, timezone, fiscal_year_start } = req.body;
        const updates = [];
        const params = [];
        let pi = 1;

        if (name) { updates.push(`name = $${pi++}`); params.push(name.trim()); }
        if (work_hours_per_day !== undefined) {
            const whpd = Number(work_hours_per_day);
            if (isNaN(whpd) || whpd < 1 || whpd > 24) return res.status(400).json({ error: 'Work hours per day must be between 1 and 24' });
            updates.push(`work_hours_per_day = $${pi++}`); params.push(whpd);
        }
        if (work_days) { updates.push(`work_days = $${pi++}`); params.push(work_days); }
        if (timezone) { updates.push(`timezone = $${pi++}`); params.push(timezone); }
        if (fiscal_year_start !== undefined) { updates.push(`fiscal_year_start = $${pi++}`); params.push(Number(fiscal_year_start)); }
        updates.push('updated_at = CURRENT_TIMESTAMP');

        if (updates.length <= 1) return res.status(400).json({ error: 'No fields to update' });

        params.push(req.userOrgId);
        await query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${pi}`, params);
        logAction(req, 'update', 'organization', req.userOrgId, req.body);

        const org = (await query('SELECT * FROM organizations WHERE id = $1', [req.userOrgId])).rows[0];
        res.json(org);
    } catch (err) {
        console.error('PUT /organizations/settings error:', err.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

router.get('/members', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const { search, role, department_id, team_id, is_active } = req.query;
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page) || 50, 1), 100);

        const where = ['u.org_id = $1'];
        const params = [req.userOrgId];
        let pi = 2;

        if (search) {
            const s = `%${search}%`;
            where.push(`(u.full_name ILIKE $${pi} OR u.username ILIKE $${pi} OR u.email ILIKE $${pi})`);
            params.push(s); pi++;
        }
        if (role) { where.push(`u.role = $${pi++}`); params.push(role); }
        if (department_id) { where.push(`u.department_id = $${pi++}`); params.push(Number(department_id)); }
        if (team_id) { where.push(`u.team_id = $${pi++}`); params.push(Number(team_id)); }
        if (is_active !== undefined) { where.push(`u.is_active = $${pi++}`); params.push(is_active === 'true'); }

        const whereClause = where.join(' AND ');
        const total = parseInt((await query(`SELECT COUNT(*) as count FROM users u WHERE ${whereClause}`, params)).rows[0].count, 10);

        const members = (await query(`
            SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
                   u.department_id, u.team_id, u.is_active, u.created_at,
                   d.name as department_name, t.name as team_name
            FROM users u
            LEFT JOIN departments d ON d.id = u.department_id
            LEFT JOIN teams t ON t.id = u.team_id
            WHERE ${whereClause}
            ORDER BY u.full_name ASC
            LIMIT $${pi} OFFSET $${pi + 1}
        `, [...params, perPage, (page - 1) * perPage])).rows;

        res.json({ data: members, total, page, perPage });
    } catch (err) {
        console.error('GET /organizations/members error:', err.message);
        res.status(500).json({ error: 'Failed to fetch members' });
    }
});

router.post('/invite', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { user_id, role, department_id, team_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'User ID is required' });

        const target = (await query('SELECT id, org_id, role, full_name FROM users WHERE id = $1', [user_id])).rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.org_id) return res.status(400).json({ error: 'User already belongs to an organization' });

        const assignRole = role || 'employee';
        const validInviteRoles = ['employee', 'team_lead', 'manager', 'hr_admin'];
        if (!validInviteRoles.includes(assignRole)) {
            return res.status(400).json({ error: `Invalid role. Valid roles: ${validInviteRoles.join(', ')}` });
        }
        if ((ROLE_LEVEL[assignRole] || 1) >= (req.roleLevel || 1)) {
            return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
        }

        if (department_id) {
            const dept = (await query('SELECT id FROM departments WHERE id = $1 AND org_id = $2', [Number(department_id), req.userOrgId])).rows[0];
            if (!dept) return res.status(400).json({ error: 'Department not found in this organization' });
        }
        if (team_id) {
            const team = (await query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [Number(team_id), req.userOrgId])).rows[0];
            if (!team) return res.status(400).json({ error: 'Team not found in this organization' });
        }

        await query('UPDATE users SET org_id = $1, role = $2, department_id = $3, team_id = $4 WHERE id = $5',
            [req.userOrgId, assignRole, department_id || null, team_id || null, user_id]);
        logAction(req, 'invite', 'user', user_id, { role: assignRole, department_id, team_id });

        res.json({ message: `${target.full_name} added to the organization` });
    } catch (err) {
        console.error('POST /organizations/invite error:', err.message);
        res.status(500).json({ error: 'Failed to invite user' });
    }
});

router.post('/remove-member', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'User ID is required' });

        const target = (await query('SELECT id, org_id, role, full_name FROM users WHERE id = $1', [user_id])).rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.org_id !== req.userOrgId) return res.status(400).json({ error: 'User is not in your organization' });
        if (target.id === req.userId) return res.status(400).json({ error: 'You cannot remove yourself' });

        await query("UPDATE users SET org_id = NULL, team_id = NULL, department_id = NULL, role = 'employee' WHERE id = $1", [user_id]);
        logAction(req, 'remove_member', 'user', user_id, { name: target.full_name });

        res.json({ message: `${target.full_name} has been removed from the organization` });
    } catch (err) {
        console.error('POST /organizations/remove-member error:', err.message);
        res.status(500).json({ error: 'Failed to remove member' });
    }
});

// ==================== DEPARTMENTS ====================

router.get('/departments', requireSameOrg, async (req, res) => {
    try {
        const departments = (await query(`
            SELECT d.*, u.full_name as head_name,
                   (SELECT COUNT(*) FROM users WHERE department_id = d.id AND is_active = TRUE)::integer as member_count
            FROM departments d
            LEFT JOIN users u ON u.id = d.head_id
            WHERE d.org_id = $1
            ORDER BY d.name
        `, [req.userOrgId])).rows;
        res.json(departments);
    } catch (err) {
        console.error('GET /departments error:', err.message);
        res.status(500).json({ error: 'Failed to fetch departments' });
    }
});

router.post('/departments', requireRole('manager'), requireSameOrg, async (req, res) => {
    try {
        const { name, head_id } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Department name is required' });

        const result = await query(
            'INSERT INTO departments (org_id, name, head_id) VALUES ($1, $2, $3) RETURNING id',
            [req.userOrgId, name.trim(), head_id || null]
        );
        logAction(req, 'create', 'department', result.rows[0].id, { name: name.trim() });
        res.json({ id: result.rows[0].id, name: name.trim(), message: 'Department created' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Department name already exists' });
        console.error('POST /departments error:', err.message);
        res.status(500).json({ error: 'Failed to create department' });
    }
});

router.put('/departments/:id', requireRole('manager'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, head_id } = req.body;

        const dept = (await query('SELECT * FROM departments WHERE id = $1 AND org_id = $2', [id, req.userOrgId])).rows[0];
        if (!dept) return res.status(404).json({ error: 'Department not found' });

        await query('UPDATE departments SET name = $1, head_id = $2 WHERE id = $3',
            [name?.trim() || dept.name, head_id !== undefined ? head_id : dept.head_id, id]);
        logAction(req, 'update', 'department', Number(id), { name, head_id });
        res.json({ message: 'Department updated' });
    } catch (err) {
        console.error('PUT /departments/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update department' });
    }
});

router.delete('/departments/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const dept = (await query('SELECT * FROM departments WHERE id = $1 AND org_id = $2', [id, req.userOrgId])).rows[0];
        if (!dept) return res.status(404).json({ error: 'Department not found' });

        await query('UPDATE users SET department_id = NULL WHERE department_id = $1', [id]);
        await query('DELETE FROM departments WHERE id = $1', [id]);
        logAction(req, 'delete', 'department', Number(id), { name: dept.name });
        res.json({ message: 'Department deleted' });
    } catch (err) {
        console.error('DELETE /departments/:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete department' });
    }
});

// ==================== TEAMS ====================

router.get('/teams', requireSameOrg, async (req, res) => {
    try {
        const { department_id } = req.query;
        const where = ['t.org_id = $1'];
        const params = [req.userOrgId];
        let pi = 2;

        if (department_id) { where.push(`t.department_id = $${pi++}`); params.push(Number(department_id)); }

        const teams = (await query(`
            SELECT t.*, u.full_name as lead_name, d.name as department_name,
                   (SELECT COUNT(*) FROM users WHERE team_id = t.id AND is_active = TRUE)::integer as member_count
            FROM teams t
            LEFT JOIN users u ON u.id = t.lead_id
            LEFT JOIN departments d ON d.id = t.department_id
            WHERE ${where.join(' AND ')}
            ORDER BY t.name
        `, params)).rows;
        res.json(teams);
    } catch (err) {
        console.error('GET /teams error:', err.message);
        res.status(500).json({ error: 'Failed to fetch teams' });
    }
});

router.post('/teams', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const { name, department_id, lead_id } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Team name is required' });

        const result = await query(
            'INSERT INTO teams (org_id, department_id, name, lead_id) VALUES ($1, $2, $3, $4) RETURNING id',
            [req.userOrgId, department_id || null, name.trim(), lead_id || null]
        );
        logAction(req, 'create', 'team', result.rows[0].id, { name: name.trim(), department_id });
        res.json({ id: result.rows[0].id, name: name.trim(), message: 'Team created' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Team name already exists' });
        console.error('POST /teams error:', err.message);
        res.status(500).json({ error: 'Failed to create team' });
    }
});

router.put('/teams/:id', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, department_id, lead_id } = req.body;

        const team = (await query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId])).rows[0];
        if (!team) return res.status(404).json({ error: 'Team not found' });

        await query('UPDATE teams SET name = $1, department_id = $2, lead_id = $3 WHERE id = $4',
            [name?.trim() || team.name, department_id !== undefined ? department_id : team.department_id, lead_id !== undefined ? lead_id : team.lead_id, id]);
        logAction(req, 'update', 'team', Number(id), { name, department_id, lead_id });
        res.json({ message: 'Team updated' });
    } catch (err) {
        console.error('PUT /teams/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update team' });
    }
});

router.delete('/teams/:id', requireRole('manager'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const team = (await query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId])).rows[0];
        if (!team) return res.status(404).json({ error: 'Team not found' });

        await query('UPDATE users SET team_id = NULL WHERE team_id = $1', [id]);
        await query('DELETE FROM teams WHERE id = $1', [id]);
        logAction(req, 'delete', 'team', Number(id), { name: team.name });
        res.json({ message: 'Team deleted' });
    } catch (err) {
        console.error('DELETE /teams/:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete team' });
    }
});

router.get('/teams/:id/sprint-config', requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const team = (await query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId])).rows[0];
        if (!team) return res.status(404).json({ error: 'Team not found' });

        let currentSprint = null;
        if (team.sprint_start_date) {
            const tzOffset = req.headers['x-timezone-offset'];
            let todayStr;
            if (tzOffset !== undefined) {
                const now = new Date();
                const localNow = new Date(now.getTime() - Number(tzOffset) * 60000);
                todayStr = localNow.toISOString().split('T')[0];
            } else {
                const now = new Date();
                todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            }

            const [sy, sm, sd] = team.sprint_start_date.split('-').map(Number);
            const [ty, tm, td] = todayStr.split('-').map(Number);
            const startMs = Date.UTC(sy, sm - 1, sd);
            const todayMs = Date.UTC(ty, tm - 1, td);
            const daysSinceStart = Math.floor((todayMs - startMs) / 86400000);
            const sprintDurationDays = team.sprint_duration_weeks * 7;
            const sprintNumber = daysSinceStart < 0 ? 1 : Math.floor(daysSinceStart / sprintDurationDays) + 1;
            const currentSprintStartDays = (sprintNumber - 1) * sprintDurationDays;
            const sprintStartMs = startMs + currentSprintStartDays * 86400000;
            const sprintEndMs = sprintStartMs + (sprintDurationDays - 1) * 86400000;
            const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
            currentSprint = { number: sprintNumber, startDate: fmt(sprintStartMs), endDate: fmt(sprintEndMs), daysRemaining: Math.max(0, Math.ceil((sprintEndMs - todayMs) / 86400000)), durationWeeks: team.sprint_duration_weeks };
        }

        res.json({ teamId: team.id, teamName: team.name, sprintDurationWeeks: team.sprint_duration_weeks, sprintStartDate: team.sprint_start_date, currentSprint });
    } catch (err) {
        console.error('GET /teams/:id/sprint-config error:', err.message);
        res.status(500).json({ error: 'Failed to fetch sprint config' });
    }
});

router.put('/teams/:id/sprint-config', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const { sprint_duration_weeks, sprint_start_date } = req.body;

        const team = (await query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId])).rows[0];
        if (!team) return res.status(404).json({ error: 'Team not found' });

        if (sprint_duration_weeks !== undefined) {
            const weeks = Number(sprint_duration_weeks);
            if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) {
                return res.status(400).json({ error: 'Sprint duration must be between 1-8 weeks' });
            }
        }
        if (sprint_start_date !== undefined && sprint_start_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(sprint_start_date)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        await query('UPDATE teams SET sprint_duration_weeks = $1, sprint_start_date = $2 WHERE id = $3',
            [sprint_duration_weeks !== undefined ? sprint_duration_weeks : team.sprint_duration_weeks,
             sprint_start_date !== undefined ? sprint_start_date : team.sprint_start_date,
             id]);
        logAction(req, 'update', 'team', Number(id), { sprint_duration_weeks, sprint_start_date });
        res.json({ message: 'Sprint configuration updated' });
    } catch (err) {
        console.error('PUT /teams/:id/sprint-config error:', err.message);
        res.status(500).json({ error: 'Failed to update sprint config' });
    }
});

// ==================== ORG CHART ====================

router.get('/chart', requireSameOrg, async (req, res) => {
    try {
        const departments = (await query(`
            SELECT d.id, d.name, d.head_id, u.full_name as head_name, u.avatar as head_avatar
            FROM departments d LEFT JOIN users u ON u.id = d.head_id
            WHERE d.org_id = $1 ORDER BY d.name
        `, [req.userOrgId])).rows;

        const teams = (await query(`
            SELECT t.id, t.name, t.department_id, t.lead_id, u.full_name as lead_name, u.avatar as lead_avatar
            FROM teams t LEFT JOIN users u ON u.id = t.lead_id
            WHERE t.org_id = $1 ORDER BY t.name
        `, [req.userOrgId])).rows;

        const members = (await query(`
            SELECT id, full_name, avatar, role, department_id, team_id
            FROM users WHERE org_id = $1 AND is_active = TRUE ORDER BY full_name
        `, [req.userOrgId])).rows;

        res.json({ departments, teams, members });
    } catch (err) {
        console.error('GET /chart error:', err.message);
        res.status(500).json({ error: 'Failed to fetch org chart' });
    }
});

module.exports = router;