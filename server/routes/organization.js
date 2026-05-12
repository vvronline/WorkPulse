const express = require('express');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg, ROLE_LEVEL, ORG_ROLES, SYSTEM_ROLE_LEVEL, DEFAULT_TENANT_ROLES, getRoleLabels } = require('../middleware/rbac');
const redisClient = require('../redis');
const { logAction } = require('../utils/audit');
const { logger } = require('../utils/logger');
const redis = require('../redis');

const router = express.Router();
const { requireTenant } = require('../middleware/tenant');
router.use(auth, loadUserContext, requireTenant);

/**
 * Resolve the effective org_id for platform_admin (who has no user-level org).
 * For mutations, platform_admin passes org_id in the request body; for queries, via query params.
 */
function resolveOrgId(req, source = 'body') {
    if (req.userRole === 'platform_admin') {
        const id = source === 'body' ? req.body?.org_id : req.query?.org_id;
        return id ? Number(id) : req.userOrgId;
    }
    return req.userOrgId;
}

// ==================== ORGANIZATIONS ====================

router.post('/', requireRole('super_admin'), async (req, res) => {
    try {
        // platform_admin manages organizations via the admin panel, not this self-service route
        if (req.userRole === 'platform_admin') {
            return res.status(403).json({ error: 'Platform admins manage organizations via the admin panel' });
        }
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Organization name is required' });
        if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });

        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const existing = (await req.db.query('SELECT id FROM organizations WHERE slug = $1', [slug])).rows[0];
        if (existing) return res.status(400).json({ error: 'An organization with a similar name already exists' });

        const result = await req.db.query(
            'INSERT INTO organizations (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id',
            [name.trim(), slug, req.userId]
        );
        const orgId = result.rows[0].id;

        await req.db.query('UPDATE users SET org_id = $1, role = $2 WHERE id = $3', [orgId, 'super_admin', req.userId]);
        await redis.invalidateUserContext(req.tenantId, req.userId);
        logAction(req, 'create', 'organization', orgId, { name: name.trim() });

        res.json({ id: orgId, name: name.trim(), slug, message: 'Organization created successfully' });
    } catch (err) {
        req.log.error({ err }, 'POST /organizations error');
        res.status(500).json({ error: 'Failed to create organization' });
    }
});

router.get('/current', async (req, res) => {
    try {
        if (!req.userOrgId) return res.json(null);
        const org = (await req.db.query(`
            SELECT o.*,
                (SELECT COUNT(*) FROM users WHERE org_id = o.id AND is_active = TRUE)::integer AS "memberCount",
                (SELECT COUNT(*) FROM departments WHERE org_id = o.id)::integer AS "deptCount",
                (SELECT COUNT(*) FROM teams WHERE org_id = o.id)::integer AS "teamCount"
            FROM organizations o WHERE o.id = $1
        `, [req.userOrgId])).rows[0];
        if (!org) return res.json(null);

        // Role-based masking: only hr_admin+ sees org-wide counts
        const userLevel = ROLE_LEVEL[req.userRole] || 1;
        if (userLevel < ROLE_LEVEL['hr_admin']) {
            delete org.memberCount;
            delete org.deptCount;
            delete org.teamCount;
        }

        res.json(org);
    } catch (err) {
        req.log.error({ err }, 'GET /organizations/current error');
        res.status(500).json({ error: 'Failed to fetch organization' });
    }
});

router.put('/settings', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { name, work_hours_per_day, work_days, timezone, fiscal_year_start, min_hours_present, office_start_time } = req.body;
        const updates = [];
        const params = [];
        let pi = 1;

        // Only super_admin / platform_admin can change org name, work hours, and work days
        if (name && name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });
        if (timezone && timezone.length > 50) return res.status(400).json({ error: 'Timezone must be 50 characters or less' });
        if (work_days && work_days.length > 50) return res.status(400).json({ error: 'Work days value too long' });
        const canEditAll = req.userRole === 'super_admin' || req.userRole === 'platform_admin';
        if (name && canEditAll) { updates.push(`name = $${pi++}`); params.push(name.trim()); }
        if (work_hours_per_day !== undefined && canEditAll) {
            const whpd = Number(work_hours_per_day);
            if (isNaN(whpd) || whpd < 1 || whpd > 24) return res.status(400).json({ error: 'Work hours per day must be between 1 and 24' });
            updates.push(`work_hours_per_day = $${pi++}`); params.push(whpd);
        }
        if (work_days && canEditAll) { updates.push(`work_days = $${pi++}`); params.push(work_days); }
        if (timezone) { updates.push(`timezone = $${pi++}`); params.push(timezone); }
        if (fiscal_year_start !== undefined) { updates.push(`fiscal_year_start = $${pi++}`); params.push(Number(fiscal_year_start)); }
        // Minimum hours required to be marked present on a working day. Settable by hr_admin+ (any admin).
        // null/empty clears the override (system falls back to work_hours_per_day / 2).
        if (min_hours_present !== undefined) {
            if (min_hours_present === null || min_hours_present === '') {
                updates.push(`min_hours_present = NULL`);
            } else {
                const mhp = Number(min_hours_present);
                if (isNaN(mhp) || mhp < 0 || mhp > 24) {
                    return res.status(400).json({ error: 'Minimum hours present must be between 0 and 24' });
                }
                updates.push(`min_hours_present = $${pi++}`); params.push(mhp);
            }
        }
        // Regular office start time (HH:MM, 24h). Used as the default clock-in
        // time on manual-entry forms and as the reference for presence checks.
        // null/empty clears the override.
        if (office_start_time !== undefined) {
            if (office_start_time === null || office_start_time === '') {
                updates.push(`office_start_time = NULL`);
            } else {
                if (typeof office_start_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(office_start_time)) {
                    return res.status(400).json({ error: 'Office start time must be in HH:MM (24h) format, e.g. 09:30' });
                }
                updates.push(`office_start_time = $${pi++}`); params.push(office_start_time);
            }
        }
        updates.push('updated_at = CURRENT_TIMESTAMP');

        if (updates.length <= 1) return res.status(400).json({ error: 'No fields to update' });

        params.push(req.userOrgId);
        await req.db.query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${pi}`, params);
        await redis.invalidateOrgConfig(req.tenantId, req.userOrgId);
        logAction(req, 'update', 'organization', req.userOrgId, req.body);

        const org = (await req.db.query('SELECT * FROM organizations WHERE id = $1', [req.userOrgId])).rows[0];
        res.json(org);
    } catch (err) {
        req.log.error({ err }, 'PUT /organizations/settings error');
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

router.get('/members', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const { search, role, department_id, team_id, is_active } = req.query;
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page) || 50, 1), 100);

        const effectiveOrgId = resolveOrgId(req, 'query');
        if (!effectiveOrgId) return res.json({ data: [], total: 0, page: 1, perPage });

        const where = ['u.org_id = $1'];
        const params = [effectiveOrgId];
        let pi = 2;

        if (search) {
            const escaped = search.replace(/[%_]/g, c => `\\${c}`);
            const s = `%${escaped}%`;
            where.push(`(u.full_name ILIKE $${pi} OR u.username ILIKE $${pi} OR u.email ILIKE $${pi})`);
            params.push(s); pi++;
        }
        if (role) { where.push(`u.role = $${pi++}`); params.push(role); }
        if (department_id) { where.push(`u.department_id = $${pi++}`); params.push(Number(department_id)); }
        if (team_id) { where.push(`u.team_id = $${pi++}`); params.push(Number(team_id)); }
        if (is_active !== undefined) { where.push(`u.is_active = $${pi++}`); params.push(is_active === 'true'); }

        const whereClause = where.join(' AND ');
        const total = parseInt((await req.db.query(`SELECT COUNT(*) as count FROM users u WHERE ${whereClause}`, params)).rows[0].count, 10);

        const members = (await req.db.query(`
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
        req.log.error({ err }, 'GET /organizations/members error');
        res.status(500).json({ error: 'Failed to fetch members' });
    }
});

router.post('/invite', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { user_id, role, department_id, team_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'User ID is required' });

        const target = (await req.db.query('SELECT id, org_id, role, full_name FROM users WHERE id = $1', [user_id])).rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.org_id) return res.status(400).json({ error: 'User already belongs to an organization' });

        const assignRole = role || 'employee';
        // Validate against the tenant's actual role set (plus the canonical
        // fallbacks for legacy DBs). super_admin/platform_admin can never be
        // assigned via this self-service invite endpoint.
        const tenantRoleRows = (await req.db.query(
            `SELECT role_key, permission_level FROM tenant_roles WHERE org_id = $1`,
            [req.userOrgId]
        )).rows;
        const tenantRolesMap = {};
        tenantRoleRows.forEach(r => { tenantRolesMap[r.role_key] = Number(r.permission_level); });
        const allowed = tenantRoleRows.length > 0
            ? tenantRoleRows.map(r => r.role_key)
            : ['employee', 'team_lead', 'manager', 'hr_admin'];
        if (!allowed.includes(assignRole)) {
            return res.status(400).json({ error: `Invalid role. Valid roles: ${allowed.join(', ')}` });
        }
        const targetLevel = tenantRolesMap[assignRole] ?? (ROLE_LEVEL[assignRole] || 1);
        if (targetLevel >= (req.roleLevel || 1)) {
            return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
        }

        if (department_id) {
            const dept = (await req.db.query('SELECT id FROM departments WHERE id = $1 AND org_id = $2', [Number(department_id), req.userOrgId])).rows[0];
            if (!dept) return res.status(400).json({ error: 'Department not found in this organization' });
        }
        if (team_id) {
            const team = (await req.db.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [Number(team_id), req.userOrgId])).rows[0];
            if (!team) return res.status(400).json({ error: 'Team not found in this organization' });
        }

        await req.db.query('UPDATE users SET org_id = $1, role = $2, department_id = $3, team_id = $4 WHERE id = $5',
            [req.userOrgId, assignRole, department_id || null, team_id || null, user_id]);
        await redis.invalidateUserContext(req.tenantId, user_id);
        logAction(req, 'invite', 'user', user_id, { role: assignRole, department_id, team_id });

        res.json({ message: `${target.full_name} added to the organization` });
    } catch (err) {
        req.log.error({ err }, 'POST /organizations/invite error');
        res.status(500).json({ error: 'Failed to invite user' });
    }
});

router.post('/remove-member', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'User ID is required' });

        const target = (await req.db.query('SELECT id, org_id, role, full_name FROM users WHERE id = $1', [user_id])).rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.org_id !== req.userOrgId) return res.status(400).json({ error: 'User is not in your organization' });
        if (target.id === req.userId) return res.status(400).json({ error: 'You cannot remove yourself' });
        if ((ROLE_LEVEL[target.role] || 0) >= (ROLE_LEVEL[req.userRole] || 0)) {
            return res.status(403).json({ error: 'Cannot remove a member with an equal or higher role' });
        }

        await req.db.query("UPDATE users SET org_id = NULL, team_id = NULL, department_id = NULL, role = 'employee' WHERE id = $1", [user_id]);
        await redis.invalidateUserContext(req.tenantId, user_id);
        logAction(req, 'remove_member', 'user', user_id, { name: target.full_name });

        res.json({ message: `${target.full_name} has been removed from the organization` });
    } catch (err) {
        req.log.error({ err }, 'POST /organizations/remove-member error');
        res.status(500).json({ error: 'Failed to remove member' });
    }
});

// ==================== DEPARTMENTS ====================

router.get('/departments', requireSameOrg, async (req, res) => {
    try {
        const userLevel = ROLE_LEVEL[req.userRole] || 1;
        // platform_admin can query any org's departments by passing ?org_id=X
        const effectiveOrgId = req.userRole === 'platform_admin'
            ? (req.query.org_id ? Number(req.query.org_id) : null)
            : req.userOrgId;

        // Only hr_admin+ can see all departments with member counts
        if (userLevel >= ROLE_LEVEL['hr_admin']) {
            if (!effectiveOrgId) return res.json([]);
            const departments = (await req.db.query(`
                SELECT d.*, u.full_name as head_name,
                       (SELECT COUNT(*) FROM users WHERE department_id = d.id AND is_active = TRUE)::integer as member_count
                FROM departments d
                LEFT JOIN users u ON u.id = d.head_id
                WHERE d.org_id = $1
                ORDER BY d.name
            `, [effectiveOrgId])).rows;
            return res.json(departments);
        }

        // Everyone else: only see their own department (no member counts)
        const user = (await req.db.query('SELECT department_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!user?.department_id) return res.json([]);
        const departments = (await req.db.query(`
            SELECT d.id, d.name, u.full_name as head_name
            FROM departments d
            LEFT JOIN users u ON u.id = d.head_id
            WHERE d.id = $1 AND d.org_id = $2
        `, [user.department_id, req.userOrgId])).rows;
        res.json(departments);
    } catch (err) {
        req.log.error({ err }, 'GET /departments error');
        res.status(500).json({ error: 'Failed to fetch departments' });
    }
});

router.post('/departments', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { name, head_id } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Department name is required' });
        if (name.trim().length > 100) return res.status(400).json({ error: 'Department name must be 100 characters or less' });

        const effectiveOrgId = resolveOrgId(req, 'body');
        if (!effectiveOrgId) return res.status(400).json({ error: 'Organization ID is required' });

        const result = await req.db.query(
            'INSERT INTO departments (org_id, name, head_id) VALUES ($1, $2, $3) RETURNING id',
            [effectiveOrgId, name.trim(), head_id || null]
        );
        logAction(req, 'create', 'department', result.rows[0].id, { name: name.trim() });
        res.json({ id: result.rows[0].id, name: name.trim(), message: 'Department created' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Department name already exists' });
        req.log.error({ err }, 'POST /departments error');
        res.status(500).json({ error: 'Failed to create department' });
    }
});

router.put('/departments/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, head_id } = req.body;

        const deptQuery = req.userRole === 'platform_admin'
            ? await req.db.query('SELECT * FROM departments WHERE id = $1', [id])
            : await req.db.query('SELECT * FROM departments WHERE id = $1 AND org_id = $2', [id, req.userOrgId]);
        const dept = deptQuery.rows[0];
        if (!dept) return res.status(404).json({ error: 'Department not found' });

        await req.db.query('UPDATE departments SET name = $1, head_id = $2 WHERE id = $3',
            [name?.trim() || dept.name, head_id !== undefined ? head_id : dept.head_id, id]);
        logAction(req, 'update', 'department', Number(id), { name, head_id });
        res.json({ message: 'Department updated' });
    } catch (err) {
        req.log.error({ err }, 'PUT /departments/:id error');
        res.status(500).json({ error: 'Failed to update department' });
    }
});

router.delete('/departments/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const deptQuery = req.userRole === 'platform_admin'
            ? await req.db.query('SELECT * FROM departments WHERE id = $1', [id])
            : await req.db.query('SELECT * FROM departments WHERE id = $1 AND org_id = $2', [id, req.userOrgId]);
        const dept = deptQuery.rows[0];
        if (!dept) return res.status(404).json({ error: 'Department not found' });

        await req.db.query('UPDATE users SET department_id = NULL WHERE department_id = $1', [id]);
        await req.db.query('DELETE FROM departments WHERE id = $1', [id]);
        logAction(req, 'delete', 'department', Number(id), { name: dept.name });
        res.json({ message: 'Department deleted' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /departments/:id error');
        res.status(500).json({ error: 'Failed to delete department' });
    }
});

// ==================== TEAMS ====================

router.get('/teams', requireSameOrg, async (req, res) => {
    try {
        const { department_id } = req.query;
        const userLevel = ROLE_LEVEL[req.userRole] || 1;
        // platform_admin can query any org's teams by passing ?org_id=X
        const effectiveOrgId = req.userRole === 'platform_admin'
            ? (req.query.org_id ? Number(req.query.org_id) : null)
            : req.userOrgId;

        // Only hr_admin+ can see all teams with member counts
        if (userLevel >= ROLE_LEVEL['hr_admin']) {
            if (!effectiveOrgId) return res.json([]);
            const where = ['t.org_id = $1'];
            const params = [effectiveOrgId];
            let pi = 2;
            if (department_id) { where.push(`t.department_id = $${pi++}`); params.push(Number(department_id)); }

            const teams = (await req.db.query(`
                SELECT t.*, u.full_name as lead_name, d.name as department_name,
                       (SELECT COUNT(*) FROM users WHERE team_id = t.id AND is_active = TRUE)::integer as member_count
                FROM teams t
                LEFT JOIN users u ON u.id = t.lead_id
                LEFT JOIN departments d ON d.id = t.department_id
                WHERE ${where.join(' AND ')}
                ORDER BY t.name
            `, params)).rows;
            return res.json(teams);
        }

        // Everyone else: only see their own team (no member counts)
        const user = (await req.db.query('SELECT team_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!user?.team_id) return res.json([]);
        const teams = (await req.db.query(`
            SELECT t.id, t.name, t.department_id, t.sprint_duration_weeks, t.sprint_start_date,
                   u.full_name as lead_name, d.name as department_name
            FROM teams t
            LEFT JOIN users u ON u.id = t.lead_id
            LEFT JOIN departments d ON d.id = t.department_id
            WHERE t.id = $1 AND t.org_id = $2
        `, [user.team_id, req.userOrgId])).rows;
        res.json(teams);
    } catch (err) {
        req.log.error({ err }, 'GET /teams error');
        res.status(500).json({ error: 'Failed to fetch teams' });
    }
});

router.post('/teams', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { name, department_id, lead_id } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Team name is required' });
        if (name.trim().length > 100) return res.status(400).json({ error: 'Team name must be 100 characters or less' });

        const effectiveOrgId = resolveOrgId(req, 'body');
        if (!effectiveOrgId) return res.status(400).json({ error: 'Organization ID is required' });

        const result = await req.db.query(
            'INSERT INTO teams (org_id, department_id, name, lead_id) VALUES ($1, $2, $3, $4) RETURNING id',
            [effectiveOrgId, department_id || null, name.trim(), lead_id || null]
        );
        logAction(req, 'create', 'team', result.rows[0].id, { name: name.trim(), department_id });
        res.json({ id: result.rows[0].id, name: name.trim(), message: 'Team created' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Team name already exists' });
        req.log.error({ err }, 'POST /teams error');
        res.status(500).json({ error: 'Failed to create team' });
    }
});

router.put('/teams/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, department_id, lead_id } = req.body;

        const teamQuery = req.userRole === 'platform_admin'
            ? await req.db.query('SELECT * FROM teams WHERE id = $1', [id])
            : await req.db.query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId]);
        const team = teamQuery.rows[0];
        if (!team) return res.status(404).json({ error: 'Team not found' });

        await req.db.query('UPDATE teams SET name = $1, department_id = $2, lead_id = $3 WHERE id = $4',
            [name?.trim() || team.name, department_id !== undefined ? department_id : team.department_id, lead_id !== undefined ? lead_id : team.lead_id, id]);
        logAction(req, 'update', 'team', Number(id), { name, department_id, lead_id });
        res.json({ message: 'Team updated' });
    } catch (err) {
        req.log.error({ err }, 'PUT /teams/:id error');
        res.status(500).json({ error: 'Failed to update team' });
    }
});

router.delete('/teams/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const teamQuery = req.userRole === 'platform_admin'
            ? await req.db.query('SELECT * FROM teams WHERE id = $1', [id])
            : await req.db.query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId]);
        const team = teamQuery.rows[0];
        if (!team) return res.status(404).json({ error: 'Team not found' });

        await req.db.query('UPDATE users SET team_id = NULL WHERE team_id = $1', [id]);
        await req.db.query('DELETE FROM teams WHERE id = $1', [id]);
        logAction(req, 'delete', 'team', Number(id), { name: team.name });
        res.json({ message: 'Team deleted' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /teams/:id error');
        res.status(500).json({ error: 'Failed to delete team' });
    }
});

router.get('/teams/:id/sprint-config', requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const teamQuery = req.userRole === 'platform_admin'
            ? await req.db.query('SELECT * FROM teams WHERE id = $1', [id])
            : await req.db.query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId]);
        const team = teamQuery.rows[0];
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
        req.log.error({ err }, 'GET /teams/:id/sprint-config error');
        res.status(500).json({ error: 'Failed to fetch sprint config' });
    }
});

router.put('/teams/:id/sprint-config', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const { sprint_duration_weeks, sprint_start_date } = req.body;

        const teamQuery = req.userRole === 'platform_admin'
            ? await req.db.query('SELECT * FROM teams WHERE id = $1', [id])
            : await req.db.query('SELECT * FROM teams WHERE id = $1 AND org_id = $2', [id, req.userOrgId]);
        const team = teamQuery.rows[0];
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

        await req.db.query('UPDATE teams SET sprint_duration_weeks = $1, sprint_start_date = $2 WHERE id = $3',
            [sprint_duration_weeks !== undefined ? sprint_duration_weeks : team.sprint_duration_weeks,
            sprint_start_date !== undefined ? sprint_start_date : team.sprint_start_date,
                id]);
        logAction(req, 'update', 'team', Number(id), { sprint_duration_weeks, sprint_start_date });
        res.json({ message: 'Sprint configuration updated' });
    } catch (err) {
        req.log.error({ err }, 'PUT /teams/:id/sprint-config error');
        res.status(500).json({ error: 'Failed to update sprint config' });
    }
});

// ==================== ORG CHART ====================

router.get('/chart', requireSameOrg, async (req, res) => {
    try {
        const effectiveOrgId = resolveOrgId(req, 'query');
        if (!effectiveOrgId) return res.json({ departments: [], teams: [], members: [] });

        const departments = (await req.db.query(`
            SELECT d.id, d.name, d.head_id, u.full_name as head_name, u.avatar as head_avatar
            FROM departments d LEFT JOIN users u ON u.id = d.head_id
            WHERE d.org_id = $1 ORDER BY d.name
        `, [effectiveOrgId])).rows;

        const teams = (await req.db.query(`
            SELECT t.id, t.name, t.department_id, t.lead_id, u.full_name as lead_name, u.avatar as lead_avatar
            FROM teams t LEFT JOIN users u ON u.id = t.lead_id
            WHERE t.org_id = $1 ORDER BY t.name
        `, [effectiveOrgId])).rows;

        const members = (await req.db.query(`
            SELECT u.id, u.full_name, u.email, u.avatar, u.role, u.department_id, u.team_id,
                   u.manager_id, m.full_name AS manager_name,
                   d.name AS department_name, t.name AS team_name
            FROM users u
            LEFT JOIN users m ON m.id = u.manager_id
            LEFT JOIN departments d ON d.id = u.department_id
            LEFT JOIN teams t ON t.id = u.team_id
            WHERE u.org_id = $1 AND u.is_active = TRUE
            ORDER BY u.full_name
        `, [effectiveOrgId])).rows;

        res.json({ departments, teams, members });
    } catch (err) {
        req.log.error({ err }, 'GET /chart error');
        res.status(500).json({ error: 'Failed to fetch org chart' });
    }
});

// ==================== ROLES ====================
//
// Each tenant has its own fully-customisable set of roles, each pinned to
// one of four RBAC permission_levels (1=employee, 2=team_lead, 3=manager,
// 4=hr_admin). Tenants can rename, recolour, add, and remove rows freely.
//
// The two top-level system roles — super_admin (5) and platform_admin (6)
// — are NOT tenant-managed. They're hardcoded in middleware/rbac.js.
//
// Reads (`GET /org/roles`) are open to any org member so the UI can render
// the correct labels everywhere.
//
// Mutations (POST/PATCH/DELETE) are restricted to super_admin /
// platform_admin and are guarded by:
//   - role_key uniqueness inside the org (DB constraint)
//   - permission_level pinned to 1..4
//   - DELETE blocked while users still hold the role
//   - the requester cannot delete or downgrade their own role
//
// Bus invalidation: every mutation invalidates the cached roles map and
// every active user-context entry for the org so the change is picked up
// on the next request without waiting for cache TTL.

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function effectiveOrgIdFor(req, source) {
    return req.userRole === 'platform_admin'
        ? (source?.org_id ? Number(source.org_id) : req.userOrgId)
        : req.userOrgId;
}

async function invalidateOrgRoleCaches(req, orgId) {
    try { await redisClient.invalidateOrgRolesMap?.(req.tenantId, orgId); } catch { /* best-effort */ }
    try {
        // Clear every cached user-context row for this org so the next
        // request recomputes role_level from the new tenant_roles map.
        await redisClient.invalidateOrgUserContexts?.(req.tenantId, orgId);
    } catch { /* best-effort */ }
}

/**
 * GET /org/roles
 * Returns the tenant's role catalog plus the system-default fallback the
 * UI uses for "reset to default" actions.
 *
 * Response: { defaults: [...], roles: [...] }
 */
router.get('/roles', async (req, res) => {
    try {
        const orgId = effectiveOrgIdFor(req, req.query);
        const roles = await getRoleLabels(req.db, orgId);
        // Attach in_use counts so the UI can disable Delete on roles
        // currently held by users.
        if (orgId && roles.length) {
            const counts = (await req.db.query(
                `SELECT role, COUNT(*)::int AS cnt
                 FROM users
                 WHERE org_id = $1 AND is_active = TRUE
                 GROUP BY role`,
                [orgId]
            )).rows.reduce((acc, r) => { acc[r.role] = r.cnt; return acc; }, {});
            for (const r of roles) r.user_count = counts[r.role_key] || 0;
        } else {
            for (const r of roles) r.user_count = 0;
        }
        res.json({ defaults: DEFAULT_TENANT_ROLES, roles });
    } catch (err) {
        req.log.error({ err }, 'GET /org/roles error');
        res.status(500).json({ error: 'Failed to fetch roles' });
    }
});

/**
 * POST /org/roles
 * Create a brand-new role.
 *
 * Body: { role_key, label, description?, color?, permission_level }
 *   - role_key:        ^[a-z][a-z0-9_]{0,39}$, must be unique in the org,
 *                      cannot collide with the two system roles.
 *   - label:           1..40 chars
 *   - description:     <=200 chars
 *   - color:           #RRGGBB
 *   - permission_level: 1..4
 */
router.post('/roles', requireRole('super_admin'), requireSameOrg, async (req, res) => {
    try {
        const orgId = effectiveOrgIdFor(req, req.body);
        if (!orgId) return res.status(400).json({ error: 'Organization ID is required' });

        const role_key = (req.body.role_key || '').toString().trim().toLowerCase();
        const label = (req.body.label || '').toString().trim();
        const description = req.body.description == null
            ? null
            : req.body.description.toString().trim().slice(0, 200);
        const color = (req.body.color || '#6366f1').toString().trim();
        const permission_level = Number(req.body.permission_level);

        if (!ROLE_KEY_RE.test(role_key)) {
            return res.status(400).json({ error: 'role_key must be lowercase letters, numbers, or underscores (start with letter, 1..40 chars)' });
        }
        if (['super_admin', 'platform_admin'].includes(role_key)) {
            return res.status(400).json({ error: `"${role_key}" is a reserved system role` });
        }
        if (!label || label.length > 40) {
            return res.status(400).json({ error: 'label must be 1..40 chars' });
        }
        if (!HEX_RE.test(color)) {
            return res.status(400).json({ error: 'color must be a valid #RRGGBB hex' });
        }
        if (!Number.isInteger(permission_level) || permission_level < 1 || permission_level > 4) {
            return res.status(400).json({ error: 'permission_level must be an integer 1..4' });
        }
        // Don't let an admin create a role at or above their own permission level
        if (permission_level >= (req.roleLevel || 1) && req.userRole !== 'platform_admin') {
            return res.status(403).json({ error: 'Cannot create a role with permission level equal to or higher than your own' });
        }

        // Determine sort_order: max + 1
        const maxRow = (await req.db.query(
            'SELECT COALESCE(MAX(sort_order), 0) AS m FROM tenant_roles WHERE org_id = $1',
            [orgId]
        )).rows[0];
        const sortOrder = Number(maxRow.m) + 1;

        try {
            await req.db.query(
                `INSERT INTO tenant_roles (org_id, role_key, label, description, color, permission_level, is_system, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)`,
                [orgId, role_key, label, description, color, permission_level, sortOrder]
            );
        } catch (e) {
            if (e.code === '23505') {
                return res.status(400).json({ error: `Role "${role_key}" already exists` });
            }
            throw e;
        }

        await invalidateOrgRoleCaches(req, orgId);
        logAction(req, 'create', 'role', null, { org_id: orgId, role_key, permission_level });
        const merged = await getRoleLabels(req.db, orgId);
        res.json({ defaults: DEFAULT_TENANT_ROLES, roles: merged });
    } catch (err) {
        req.log.error({ err }, 'POST /org/roles error');
        res.status(500).json({ error: 'Failed to create role' });
    }
});

/**
 * PATCH /org/roles/:role_key
 * Update label, description, color, permission_level, or sort_order.
 * role_key itself is immutable (changing it would orphan all existing
 * users and audit-log references). To "rename" a role's identifier, the
 * admin should create a new one and migrate users.
 */
router.patch('/roles/:role_key', requireRole('super_admin'), requireSameOrg, async (req, res) => {
    try {
        const orgId = effectiveOrgIdFor(req, req.body);
        if (!orgId) return res.status(400).json({ error: 'Organization ID is required' });

        const role_key = req.params.role_key;
        if (['super_admin', 'platform_admin'].includes(role_key)) {
            return res.status(400).json({ error: `"${role_key}" is a system role and cannot be edited` });
        }

        const existing = (await req.db.query(
            'SELECT * FROM tenant_roles WHERE org_id = $1 AND role_key = $2',
            [orgId, role_key]
        )).rows[0];
        if (!existing) return res.status(404).json({ error: 'Role not found' });

        const updates = {};
        if (req.body.label !== undefined) {
            const label = req.body.label.toString().trim();
            if (!label || label.length > 40) return res.status(400).json({ error: 'label must be 1..40 chars' });
            updates.label = label;
        }
        if (req.body.description !== undefined) {
            updates.description = req.body.description == null
                ? null
                : req.body.description.toString().trim().slice(0, 200);
        }
        if (req.body.color !== undefined) {
            const color = req.body.color.toString().trim();
            if (!HEX_RE.test(color)) return res.status(400).json({ error: 'color must be a valid #RRGGBB hex' });
            updates.color = color;
        }
        if (req.body.permission_level !== undefined) {
            const lvl = Number(req.body.permission_level);
            if (!Number.isInteger(lvl) || lvl < 1 || lvl > 4) {
                return res.status(400).json({ error: 'permission_level must be an integer 1..4' });
            }
            if (lvl >= (req.roleLevel || 1) && req.userRole !== 'platform_admin') {
                return res.status(403).json({ error: 'Cannot promote a role to your own level or higher' });
            }
            // Block changing the level of a role the requester themselves holds —
            // would let them silently raise their own permissions to the cap.
            if (req.userRole === role_key) {
                return res.status(403).json({ error: "You can't change the permission level of your own role" });
            }
            updates.permission_level = lvl;
        }
        if (req.body.sort_order !== undefined) {
            const so = Number(req.body.sort_order);
            if (!Number.isFinite(so)) return res.status(400).json({ error: 'sort_order must be a number' });
            updates.sort_order = so;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        const setClauses = [];
        const params = [];
        let i = 1;
        for (const [k, v] of Object.entries(updates)) {
            setClauses.push(`${k} = $${i++}`);
            params.push(v);
        }
        setClauses.push('updated_at = NOW()');
        params.push(orgId, role_key);

        await req.db.query(
            `UPDATE tenant_roles SET ${setClauses.join(', ')}
             WHERE org_id = $${i++} AND role_key = $${i}`,
            params
        );

        await invalidateOrgRoleCaches(req, orgId);
        logAction(req, 'update', 'role', null, { org_id: orgId, role_key, ...updates });
        const merged = await getRoleLabels(req.db, orgId);
        res.json({ defaults: DEFAULT_TENANT_ROLES, roles: merged });
    } catch (err) {
        req.log.error({ err }, 'PATCH /org/roles/:role_key error');
        res.status(500).json({ error: 'Failed to update role' });
    }
});

/**
 * DELETE /org/roles/:role_key
 * Delete a role. Blocked if any active user still holds it.
 *
 * System-seeded rows (is_system=TRUE) can be deleted too, but only if
 * unused — the UI should warn the admin first since dropping `employee`
 * would prevent inviting any new standard members until they create a
 * replacement at level 1.
 */
router.delete('/roles/:role_key', requireRole('super_admin'), requireSameOrg, async (req, res) => {
    try {
        const orgId = effectiveOrgIdFor(req, req.query);
        if (!orgId) return res.status(400).json({ error: 'Organization ID is required' });

        const role_key = req.params.role_key;
        if (['super_admin', 'platform_admin'].includes(role_key)) {
            return res.status(400).json({ error: `"${role_key}" is a system role and cannot be deleted` });
        }
        if (req.userRole === role_key) {
            return res.status(403).json({ error: "You can't delete your own role" });
        }

        const role = (await req.db.query(
            'SELECT * FROM tenant_roles WHERE org_id = $1 AND role_key = $2',
            [orgId, role_key]
        )).rows[0];
        if (!role) return res.status(404).json({ error: 'Role not found' });

        const inUse = parseInt((await req.db.query(
            'SELECT COUNT(*) AS c FROM users WHERE org_id = $1 AND role = $2',
            [orgId, role_key]
        )).rows[0].c, 10);
        if (inUse > 0) {
            return res.status(400).json({
                error: `Cannot delete: ${inUse} user${inUse === 1 ? '' : 's'} still hold${inUse === 1 ? 's' : ''} this role. Reassign them first.`,
            });
        }

        await req.db.query(
            'DELETE FROM tenant_roles WHERE org_id = $1 AND role_key = $2',
            [orgId, role_key]
        );

        await invalidateOrgRoleCaches(req, orgId);
        logAction(req, 'delete', 'role', null, { org_id: orgId, role_key });
        const merged = await getRoleLabels(req.db, orgId);
        res.json({ defaults: DEFAULT_TENANT_ROLES, roles: merged });
    } catch (err) {
        req.log.error({ err }, 'DELETE /org/roles/:role_key error');
        res.status(500).json({ error: 'Failed to delete role' });
    }
});

module.exports = router;
