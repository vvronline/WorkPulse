const express = require('express');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg, canManageUser, VALID_ROLES, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction, queryLogs } = require('../utils/audit');
const { validatePassword, validateUsername } = require('../utils/password');
const { getOffsetMin, getTzModifier } = require('../utils/timezone');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(auth, loadUserContext, requireRole('hr_admin'));

// ==================== ORGANIZATIONS ====================

router.get('/organizations', requireRole('super_admin'), async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page) || 50, 1), 100);
        const offset = (page - 1) * perPage;
        const totalRes = await query('SELECT COUNT(*) as count FROM organizations');
        const total = parseInt(totalRes.rows[0].count, 10);
        const orgsRes = await query(`
            SELECT o.id, o.name, o.slug, o.timezone, o.work_hours_per_day, o.work_days, o.fiscal_year_start,
                   (SELECT COUNT(*) FROM users WHERE org_id = o.id AND is_active = TRUE) as member_count
            FROM organizations o ORDER BY o.name LIMIT $1 OFFSET $2
        `, [perPage, offset]);
        res.json({ data: orgsRes.rows, total, page, perPage });
    } catch (err) {
        req.log.error({ err }, 'List orgs error');
        res.status(500).json({ error: 'Failed to list organizations' });
    }
});

router.get('/organizations/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const orgRes = await query('SELECT * FROM organizations WHERE id = $1', [id]);
        const org = orgRes.rows[0];
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        const memberRes = await query('SELECT COUNT(*) as count FROM users WHERE org_id = $1 AND is_active = TRUE', [id]);
        const deptRes = await query('SELECT COUNT(*) as count FROM departments WHERE org_id = $1', [id]);
        const teamRes = await query('SELECT COUNT(*) as count FROM teams WHERE org_id = $1', [id]);
        res.json({
            ...org,
            memberCount: parseInt(memberRes.rows[0].count, 10),
            deptCount: parseInt(deptRes.rows[0].count, 10),
            teamCount: parseInt(teamRes.rows[0].count, 10),
        });
    } catch (err) {
        req.log.error({ err }, 'Get org error');
        res.status(500).json({ error: 'Failed to get organization' });
    }
});

router.post('/organizations', requireRole('super_admin'), async (req, res) => {
    try {
        const { name, work_hours_per_day, work_days, timezone } = req.body;
        const trimmedName = name?.trim();
        if (!trimmedName) return res.status(400).json({ error: 'Organization name is required' });
        if (trimmedName.length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });
        const slug = trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const existingRes = await query('SELECT id FROM organizations WHERE slug = $1', [slug]);
        if (existingRes.rows[0]) return res.status(400).json({ error: 'An organization with a similar name already exists' });
        const whpd = Number(work_hours_per_day) || 8;
        if (whpd < 1 || whpd > 24) return res.status(400).json({ error: 'Work hours per day must be between 1 and 24' });
        const result = await query(
            'INSERT INTO organizations (name, slug, created_by, work_hours_per_day, work_days, timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [trimmedName, slug, req.userId, whpd, work_days || '1,2,3,4,5', timezone || 'UTC']
        );
        const newId = result.rows[0].id;
        logAction(req, 'admin_create', 'organization', newId, { name: trimmedName });
        res.json({ id: newId, name: trimmedName, slug, message: 'Organization created successfully' });
    } catch (err) {
        req.log.error({ err }, 'Create org error');
        res.status(500).json({ error: 'Failed to create organization' });
    }
});

router.put('/organizations/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, work_hours_per_day, work_days, timezone, fiscal_year_start } = req.body;
        const orgRes = await query('SELECT id FROM organizations WHERE id = $1', [id]);
        if (!orgRes.rows[0]) return res.status(404).json({ error: 'Organization not found' });
        let pi = 1;
        const updates = [];
        const params = [];
        if (name) {
            if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });
            updates.push(`name = $${pi++}`); params.push(name.trim());
        }
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
        params.push(id);
        await query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${pi}`, params);
        logAction(req, 'admin_update', 'organization', id, req.body);
        const updated = await query('SELECT * FROM organizations WHERE id = $1', [id]);
        res.json(updated.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Update org error');
        res.status(500).json({ error: 'Failed to update organization' });
    }
});

router.delete('/organizations/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const orgRes = await query('SELECT id, name FROM organizations WHERE id = $1', [id]);
        const org = orgRes.rows[0];
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        const activeRes = await query('SELECT COUNT(*) as count FROM users WHERE org_id = $1 AND is_active = TRUE', [id]);
        const activeUsers = parseInt(activeRes.rows[0].count, 10);
        if (activeUsers > 0) return res.status(400).json({ error: `Cannot delete organization with ${activeUsers} active user(s). Deactivate or reassign users first.` });
        await transaction(async (client) => {
            await client.query('UPDATE approval_requests SET org_id = NULL WHERE org_id = $1', [id]);
            await client.query('UPDATE audit_logs SET org_id = NULL WHERE org_id = $1', [id]);
            await client.query('DELETE FROM invite_codes WHERE org_id = $1', [id]);
            await client.query('DELETE FROM teams WHERE org_id = $1', [id]);
            await client.query('DELETE FROM departments WHERE org_id = $1', [id]);
            await client.query('DELETE FROM leave_policies WHERE org_id = $1', [id]);
            await client.query('DELETE FROM holidays WHERE org_id = $1', [id]);
            await client.query('UPDATE users SET org_id = NULL, department_id = NULL, team_id = NULL WHERE org_id = $1', [id]);
            await client.query('DELETE FROM organizations WHERE id = $1', [id]);
        });
        logAction(req, 'admin_delete', 'organization', id, { name: org.name });
        res.json({ message: `Organization "${org.name}" deleted successfully` });
    } catch (err) {
        req.log.error({ err }, 'Delete org error');
        res.status(500).json({ error: 'Failed to delete organization.' });
    }
});

// ==================== USER MANAGEMENT ====================

router.get('/users', async (req, res) => {
    try {
        const { search, role, is_active, org_id } = req.query;
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page) || 50, 1), 100);
        let pi = 1;
        const where = [];
        const params = [];

        if (req.userRole === 'super_admin' && org_id) {
            where.push(`u.org_id = $${pi++}`); params.push(Number(org_id));
        } else if (req.userRole !== 'super_admin') {
            if (req.userOrgId) { where.push(`u.org_id = $${pi++}`); params.push(req.userOrgId); }
            else { where.push(`u.id = $${pi++}`); params.push(req.userId); }
        }

        if (search) {
            const escaped = search.replace(/[%_]/g, c => `\\${c}`);
            const s = `%${escaped}%`;
            where.push(`(u.full_name ILIKE $${pi} OR u.username ILIKE $${pi} OR u.email ILIKE $${pi})`);
            params.push(s); pi++;
        }
        if (role) { where.push(`u.role = $${pi++}`); params.push(role); }
        if (is_active !== undefined) { where.push(`u.is_active = $${pi++}`); params.push(is_active === 'true'); }

        const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
        const countRes = await query(`SELECT COUNT(*) as count FROM users u ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].count, 10);

        const usersRes = await query(`
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
            LIMIT $${pi++} OFFSET $${pi++}
        `, [...params, perPage, (page - 1) * perPage]);
        res.json({ data: usersRes.rows, total, page, perPage });
    } catch (err) {
        req.log.error({ err }, 'List users error');
        res.status(500).json({ error: 'Failed to list users' });
    }
});

router.get('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userRes = await query(`
            SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role,
                   u.is_active, u.org_id, u.department_id, u.team_id, u.manager_id, u.created_at, u.timezone_offset,
                   o.name as org_name, d.name as department_name, t.name as team_name,
                   m.full_name as manager_name
            FROM users u
            LEFT JOIN organizations o ON o.id = u.org_id
            LEFT JOIN departments d ON d.id = u.department_id
            LEFT JOIN teams t ON t.id = u.team_id
            LEFT JOIN users m ON m.id = u.manager_id
            WHERE u.id = $1
        `, [Number(id)]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (req.userRole !== 'super_admin' && user.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Cannot view users outside your organization' });
        }
        res.json(user);
    } catch (err) {
        req.log.error({ err }, 'Get user error');
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// Helper: determine which role levels must approve a role change
function getRequiredApprovals(requestedRole) {
    const allRoles = ['employee', 'team_lead', 'manager', 'hr_admin', 'super_admin'];
    const targetLevel = ROLE_LEVEL[requestedRole] || 1;
    // Every role strictly above the requested role must approve
    return allRoles.filter(r => ROLE_LEVEL[r] > targetLevel);
}

router.put('/users/:id/role', async (req, res) => {
    try {
        const { id } = req.params;
        const { role, reason } = req.body;
        if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role. Valid roles: ${VALID_ROLES.join(', ')}` });
        const targetRes = await query('SELECT id, role, org_id, full_name FROM users WHERE id = $1', [Number(id)]);
        const target = targetRes.rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.role === role) return res.status(400).json({ error: 'User already has this role' });
        if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, target.role)) {
            return res.status(403).json({ error: 'Cannot modify a user with a role equal to or higher than your own' });
        }
        if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, role)) {
            return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
        }
        if (Number(id) === req.userId && req.userRole !== 'super_admin') {
            return res.status(400).json({ error: 'Cannot change your own role' });
        }
        // Check for existing pending request
        const existingRes = await query('SELECT id FROM role_change_requests WHERE target_user_id = $1 AND status = $2', [Number(id), 'pending']);
        if (existingRes.rows[0]) return res.status(400).json({ error: 'A role change request is already pending for this user' });

        // Super admin: apply immediately (no one higher to approve)
        if (req.userRole === 'super_admin') {
            await query('UPDATE users SET role = $1 WHERE id = $2', [role, Number(id)]);
            await query(
                `INSERT INTO role_change_requests (org_id, target_user_id, requested_by, from_role, to_role, status, reason, approvals, resolved_at)
                 VALUES ($1,$2,$3,$4,$5,'approved',$6,$7,NOW())`,
                [req.userOrgId, Number(id), req.userId, target.role, role, reason || null, JSON.stringify({ super_admin: { status: 'approved', by: req.userId, at: new Date().toISOString() } })]
            );
            logAction(req, 'update_role', 'user', Number(id), { old_role: target.role, new_role: role });
            return res.json({ message: `${target.full_name}'s role updated to ${role}`, immediate: true });
        }

        // Non-super-admin: create approval request
        const required = getRequiredApprovals(role);
        const approvals = {};
        for (const r of required) approvals[r] = { status: 'pending' };

        const result = await query(
            `INSERT INTO role_change_requests (org_id, target_user_id, requested_by, from_role, to_role, reason, approvals)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [req.userOrgId, Number(id), req.userId, target.role, role, reason || null, JSON.stringify(approvals)]
        );
        logAction(req, 'request_role_change', 'user', Number(id), { from_role: target.role, to_role: role, request_id: result.rows[0].id });
        res.json({ message: `Role change request created for ${target.full_name}. Awaiting approval.`, request_id: result.rows[0].id, pending: true });
    } catch (err) {
        req.log.error({ err }, 'Update role error');
        res.status(500).json({ error: 'Failed to update role' });
    }
});

// ==================== ROLE CHANGE REQUESTS ====================

router.get('/role-requests', async (req, res) => {
    try {
        const status = req.query.status || null;
        const validStatuses = ['pending', 'approved', 'rejected', 'cancelled'];
        const conditions = ['1=1'];
        const params = [];
        let pi = 1;

        if (req.userRole !== 'super_admin') {
            conditions.push(`r.org_id = $${pi++}`);
            params.push(req.userOrgId);
        }
        if (status && validStatuses.includes(status)) {
            conditions.push(`r.status = $${pi++}`);
            params.push(status);
        }

        const result = await query(`
            SELECT r.*, u.full_name AS target_name, u.username AS target_username,
                   req.full_name AS requester_name,
                   r.from_role AS current_role, r.to_role AS requested_role
            FROM role_change_requests r
            JOIN users u ON u.id = r.target_user_id
            JOIN users req ON req.id = r.requested_by
            WHERE ${conditions.join(' AND ')}
            ORDER BY r.created_at DESC LIMIT 100
        `, params);
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'List role requests error');
        res.status(500).json({ error: 'Failed to fetch role change requests' });
    }
});

router.post('/role-requests/:id/approve', async (req, res) => {
    try {
        const reqId = Number(req.params.id);
        const rcRes = await query('SELECT * FROM role_change_requests WHERE id = $1', [reqId]);
        const rc = rcRes.rows[0];
        if (!rc) return res.status(404).json({ error: 'Request not found' });
        if (rc.status !== 'pending') return res.status(400).json({ error: `Request is already ${rc.status}` });
        if (req.userRole === 'super_admin' || (rc.org_id && rc.org_id !== req.userOrgId && req.userRole !== 'super_admin')) {
            // super_admin can approve any; others must be same org
        }
        if (rc.org_id && rc.org_id !== req.userOrgId && req.userRole !== 'super_admin') {
            return res.status(403).json({ error: 'Cannot approve requests from another organization' });
        }

        const approvals = rc.approvals || {};
        // Check if this user's role level is required
        if (!approvals[req.userRole] || approvals[req.userRole].status !== 'pending') {
            return res.status(400).json({ error: 'Your role level is not required for this approval or you have already approved' });
        }

        // Mark this level as approved
        approvals[req.userRole] = { status: 'approved', by: req.userId, at: new Date().toISOString() };

        // Check if all levels are now approved
        const allApproved = Object.values(approvals).every(a => a.status === 'approved');

        if (allApproved) {
            // Apply the role change
            await transaction(async (client) => {
                await client.query('UPDATE users SET role = $1 WHERE id = $2', [rc.to_role, rc.target_user_id]);
                await client.query(
                    'UPDATE role_change_requests SET status = $1, approvals = $2, resolved_at = NOW() WHERE id = $3',
                    ['approved', JSON.stringify(approvals), reqId]
                );
            });
            logAction(req, 'approve_role_change', 'user', rc.target_user_id, { from: rc.from_role, to: rc.to_role, request_id: reqId });
            const targetUser = (await query('SELECT full_name FROM users WHERE id = $1', [rc.target_user_id])).rows[0];
            res.json({ message: `Role change approved. ${targetUser?.full_name}'s role updated to ${rc.to_role}.`, fully_approved: true });
        } else {
            await query('UPDATE role_change_requests SET approvals = $1 WHERE id = $2', [JSON.stringify(approvals), reqId]);
            logAction(req, 'partial_approve_role_change', 'role_change_request', reqId, { role_level: req.userRole });
            const remaining = Object.entries(approvals).filter(([, a]) => a.status === 'pending').map(([r]) => r);
            res.json({ message: `Approved at ${req.userRole} level. Still awaiting: ${remaining.join(', ')}`, fully_approved: false });
        }
    } catch (err) {
        req.log.error({ err }, 'Approve role request error');
        res.status(500).json({ error: 'Failed to approve role change request' });
    }
});

router.post('/role-requests/:id/reject', async (req, res) => {
    try {
        const reqId = Number(req.params.id);
        const { reject_reason } = req.body;
        const rcRes = await query('SELECT * FROM role_change_requests WHERE id = $1', [reqId]);
        const rc = rcRes.rows[0];
        if (!rc) return res.status(404).json({ error: 'Request not found' });
        if (rc.status !== 'pending') return res.status(400).json({ error: `Request is already ${rc.status}` });
        if (rc.org_id && rc.org_id !== req.userOrgId && req.userRole !== 'super_admin') {
            return res.status(403).json({ error: 'Cannot reject requests from another organization' });
        }
        const approvals = rc.approvals || {};
        if (!approvals[req.userRole]) {
            return res.status(400).json({ error: 'Your role level is not part of the approval chain for this request' });
        }

        await query(
            'UPDATE role_change_requests SET status = $1, reject_reason = $2, rejected_by = $3, resolved_at = NOW() WHERE id = $4',
            ['rejected', reject_reason || null, req.userId, reqId]
        );
        logAction(req, 'reject_role_change', 'role_change_request', reqId, { role_level: req.userRole, reason: reject_reason });
        const targetUser = (await query('SELECT full_name FROM users WHERE id = $1', [rc.target_user_id])).rows[0];
        res.json({ message: `Role change request for ${targetUser?.full_name} has been rejected.` });
    } catch (err) {
        req.log.error({ err }, 'Reject role request error');
        res.status(500).json({ error: 'Failed to reject role change request' });
    }
});

router.post('/role-requests/:id/cancel', async (req, res) => {
    try {
        const reqId = Number(req.params.id);
        const rcRes = await query('SELECT * FROM role_change_requests WHERE id = $1', [reqId]);
        const rc = rcRes.rows[0];
        if (!rc) return res.status(404).json({ error: 'Request not found' });
        if (rc.status !== 'pending') return res.status(400).json({ error: `Request is already ${rc.status}` });
        if (rc.requested_by !== req.userId && req.userRole !== 'super_admin') {
            return res.status(403).json({ error: 'Only the requester or a super admin can cancel' });
        }
        await query('UPDATE role_change_requests SET status = $1, resolved_at = NOW() WHERE id = $2', ['cancelled', reqId]);
        logAction(req, 'cancel_role_change', 'role_change_request', reqId, {});
        res.json({ message: 'Role change request cancelled.' });
    } catch (err) {
        req.log.error({ err }, 'Cancel role request error');
        res.status(500).json({ error: 'Failed to cancel role change request' });
    }
});

router.put('/users/:id/assignment', async (req, res) => {
    try {
        const { id } = req.params;
        const { org_id, department_id, team_id, manager_id } = req.body;
        const targetRes = await query('SELECT id, org_id, full_name FROM users WHERE id = $1', [Number(id)]);
        const target = targetRes.rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (req.userRole !== 'super_admin' && target.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'User is not in your organization' });
        }
        if (org_id !== undefined && req.userRole !== 'super_admin') {
            return res.status(403).json({ error: 'Only super admin can change organization assignment' });
        }
        if (org_id) {
            const orgRes = await query('SELECT id FROM organizations WHERE id = $1', [Number(org_id)]);
            if (!orgRes.rows[0]) return res.status(400).json({ error: 'Organization not found' });
        }
        if (manager_id) {
            const mgrRes = await query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [Number(manager_id)]);
            if (!mgrRes.rows[0]) return res.status(400).json({ error: 'Manager not found' });
            if (Number(manager_id) === Number(id)) return res.status(400).json({ error: 'Cannot assign user as their own manager' });
        }
        const newOrgId = org_id !== undefined ? (org_id || null) : target.org_id;
        if (department_id) {
            const deptRes = await query('SELECT id FROM departments WHERE id = $1 AND org_id = $2', [Number(department_id), Number(newOrgId || 0)]);
            if (!deptRes.rows[0]) return res.status(400).json({ error: 'Department not found in the target organization' });
        }
        if (team_id) {
            const teamRes = await query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [Number(team_id), Number(newOrgId || 0)]);
            if (!teamRes.rows[0]) return res.status(400).json({ error: 'Team not found in the target organization' });
        }
        const orgChanged = org_id !== undefined && Number(org_id || 0) !== Number(target.org_id || 0);
        const finalDeptId = orgChanged ? null : (department_id || null);
        const finalTeamId = orgChanged ? null : (team_id || null);
        const finalManagerId = orgChanged ? null : (manager_id || null);
        await query('UPDATE users SET org_id = $1, department_id = $2, team_id = $3, manager_id = $4 WHERE id = $5',
            [newOrgId, finalDeptId, finalTeamId, finalManagerId, Number(id)]);
        logAction(req, 'update_assignment', 'user', Number(id), { org_id: newOrgId, department_id: finalDeptId, team_id: finalTeamId, manager_id: finalManagerId });
        res.json({ message: `${target.full_name}'s assignment updated` });
    } catch (err) {
        req.log.error({ err }, 'Update assignment error');
        res.status(500).json({ error: 'Failed to update assignment' });
    }
});

router.put('/users/:id/deactivate', async (req, res) => {
    try {
        const { id } = req.params;
        const targetRes = await query('SELECT id, role, org_id, full_name, is_active FROM users WHERE id = $1', [Number(id)]);
        const target = targetRes.rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (Number(id) === req.userId) return res.status(400).json({ error: 'Cannot deactivate yourself' });
        if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, target.role)) {
            return res.status(403).json({ error: 'Cannot deactivate a user with equal or higher role' });
        }
        const newActive = !target.is_active;
        await query('UPDATE users SET is_active = $1 WHERE id = $2', [newActive, Number(id)]);
        const action = target.is_active ? 'deactivate' : 'reactivate';
        logAction(req, action, 'user', Number(id), { name: target.full_name });
        res.json({ message: `${target.full_name} has been ${action}d`, is_active: newActive });
    } catch (err) {
        req.log.error({ err }, 'Deactivate error');
        res.status(500).json({ error: 'Failed to update user' });
    }
});

router.post('/users/:id/reset-password', requireRole('hr_admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if (new_password.length > 72) return res.status(400).json({ error: 'Password must be 72 characters or less' });
        const pwErr = validatePassword(new_password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        const targetRes = await query('SELECT id, role, org_id, full_name FROM users WHERE id = $1', [Number(id)]);
        const target = targetRes.rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (req.userRole !== 'super_admin' && !canManageUser(req.userRole, target.role)) {
            return res.status(403).json({ error: 'Cannot reset password for a user with equal or higher role' });
        }
        const hash = await bcrypt.hash(new_password, 10);
        await query('UPDATE users SET password = $1, token_version = COALESCE(token_version, 0) + 1, must_change_password = TRUE WHERE id = $2', [hash, Number(id)]);
        logAction(req, 'admin_reset_password', 'user', Number(id), { name: target.full_name });
        res.json({ message: `Password reset for ${target.full_name}. User will be required to change password on next login.` });
    } catch (err) {
        req.log.error({ err }, 'Reset password error');
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

router.delete('/users/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const targetRes = await query('SELECT id, role, full_name, is_active FROM users WHERE id = $1', [userId]);
        const target = targetRes.rows[0];
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (userId === req.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
        if (target.role === 'super_admin') return res.status(400).json({ error: 'Cannot delete another super admin' });
        await transaction(async (client) => {
            await client.query('DELETE FROM time_entries WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM leaves WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM leave_balances WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM approval_requests WHERE requester_id = $1', [userId]);
            await client.query('UPDATE approval_requests SET approver_id = NULL WHERE approver_id = $1', [userId]);
            await client.query('UPDATE departments SET head_id = NULL WHERE head_id = $1', [userId]);
            await client.query('UPDATE teams SET lead_id = NULL WHERE lead_id = $1', [userId]);
            await client.query('UPDATE users SET manager_id = NULL WHERE manager_id = $1', [userId]);
            await client.query('UPDATE leaves SET approved_by = NULL WHERE approved_by = $1', [userId]);
            await client.query('UPDATE time_entries SET approved_by = NULL WHERE approved_by = $1', [userId]);
            await client.query('UPDATE audit_logs SET actor_id = NULL WHERE actor_id = $1', [userId]);
            await client.query('DELETE FROM users WHERE id = $1', [userId]);
        });
        logAction(req, 'admin_delete', 'user', userId, { name: target.full_name });
        res.json({ message: `User "${target.full_name}" has been permanently deleted` });
    } catch (err) {
        req.log.error({ err }, 'Delete user error');
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

router.post('/users', requireRole('hr_admin'), async (req, res) => {
    try {
        const { username, password, full_name, email, role, org_id, department_id, team_id, manager_id } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: 'Username, password, full name and email are required' });
        }
        const pwErr = validatePassword(password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        const usernameErr = validateUsername(username);
        if (usernameErr) return res.status(400).json({ error: usernameErr });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
        const existingRes = await query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (existingRes.rows[0]) return res.status(400).json({ error: 'Username or email already taken' });
        const assignRole = VALID_ROLES.includes(role) ? role : 'employee';
        if (req.userRole !== 'super_admin' && ROLE_LEVEL[assignRole] >= ROLE_LEVEL[req.userRole]) {
            return res.status(403).json({ error: 'Cannot create a user with a role equal to or higher than your own' });
        }
        const hash = await bcrypt.hash(password, 10);
        let assignOrgId = req.userOrgId;
        if (req.userRole === 'super_admin' && org_id !== undefined) {
            if (org_id) {
                const orgRes = await query('SELECT id FROM organizations WHERE id = $1', [org_id]);
                if (!orgRes.rows[0]) return res.status(400).json({ error: 'Organization not found' });
            }
            assignOrgId = org_id || null;
        }
        const result = await query(
            'INSERT INTO users (username, password, full_name, email, role, org_id, department_id, team_id, manager_id, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE) RETURNING id',
            [username, hash, full_name, email, assignRole, assignOrgId, department_id || null, team_id || null, manager_id || null]
        );
        logAction(req, 'admin_create', 'user', result.rows[0].id, { username, role: assignRole });
        res.json({ id: result.rows[0].id, message: `User ${username} created successfully` });
    } catch (err) {
        req.log.error({ err }, 'Create user error');
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// ==================== AUDIT LOGS ====================

router.get('/audit-logs', async (req, res) => {
    try {
        const { actor_id, entity_type, entity_id, action, from, to, limit, offset } = req.query;
        const orgId = req.userRole === 'super_admin' ? (req.query.org_id || null) : req.userOrgId;
        const result = await queryLogs({
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
    } catch (err) {
        req.log.error({ err }, 'Audit logs error');
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});

// ==================== ORG DASHBOARD STATS ====================

router.get('/stats', requireSameOrg, async (req, res) => {
    try {
        const orgId = req.userOrgId;
        if (!orgId) {
            return res.json({ totalUsers: 0, activeUsers: 0, departments: 0, teams: 0, pendingApprovals: 0, clockedInToday: 0 });
        }
        const countsRes = await query(`
            SELECT
                (SELECT COUNT(*) FROM users WHERE org_id = $1) AS "totalUsers",
                (SELECT COUNT(*) FROM users WHERE org_id = $1 AND is_active = TRUE) AS "activeUsers",
                (SELECT COUNT(*) FROM departments WHERE org_id = $1) AS departments,
                (SELECT COUNT(*) FROM teams WHERE org_id = $1) AS teams,
                (SELECT COUNT(*) FROM approval_requests WHERE org_id = $1 AND status = 'pending') AS "pendingApprovals"
        `, [orgId]);
        const counts = countsRes.rows[0];
        const today = (() => {
            const offsetMin = getOffsetMin(req);
            const localNow = new Date(Date.now() - offsetMin * 60000);
            return `${localNow.getUTCFullYear()}-${String(localNow.getUTCMonth() + 1).padStart(2, '0')}-${String(localNow.getUTCDate()).padStart(2, '0')}`;
        })();
        const tzMod = getTzModifier(req);
        const clockedRes = await query(`
            SELECT COUNT(DISTINCT user_id) as c
            FROM time_entries
            WHERE user_id IN (SELECT id FROM users WHERE org_id = $1)
              AND (timestamp + $2::interval)::date = $3::date
              AND entry_type = 'clock_in'
        `, [orgId, tzMod, today]);
        res.json({
            totalUsers: parseInt(counts.totalUsers, 10),
            activeUsers: parseInt(counts.activeUsers, 10),
            departments: parseInt(counts.departments, 10),
            teams: parseInt(counts.teams, 10),
            pendingApprovals: parseInt(counts.pendingApprovals, 10),
            clockedInToday: parseInt(clockedRes.rows[0].c, 10),
        });
    } catch (err) {
        req.log.error({ err }, 'Stats error');
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ============= REGISTRATION SETTINGS =============

router.get('/registration-settings', async (req, res) => {
    try {
        const res2 = await query("SELECT value FROM app_settings WHERE key = 'registration_mode'");
        res.json({ mode: res2.rows[0]?.value || 'open' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get registration settings' });
    }
});

router.put('/registration-settings', requireRole('super_admin'), async (req, res) => {
    try {
        const { mode } = req.body;
        if (!['open', 'invite_only', 'closed'].includes(mode)) {
            return res.status(400).json({ error: 'Mode must be open, invite_only, or closed' });
        }
        await query(
            "INSERT INTO app_settings (key, value) VALUES ('registration_mode', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
            [mode]
        );
        res.json({ mode, message: 'Registration mode updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update registration settings' });
    }
});

// LIST INVITE CODES
router.get('/invite-codes', async (req, res) => {
    try {
        const orgId = req.userOrgId;
        let codesRes;
        if (orgId) {
            codesRes = await query(`
                SELECT ic.*, u.full_name as created_by_name
                FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by
                WHERE ic.org_id = $1 OR ic.org_id IS NULL ORDER BY ic.id DESC
            `, [orgId]);
        } else {
            codesRes = await query(`
                SELECT ic.*, u.full_name as created_by_name
                FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by
                ORDER BY ic.id DESC
            `);
        }
        res.json(codesRes.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list invite codes' });
    }
});

router.post('/invite-codes', async (req, res) => {
    try {
        const { role, max_uses, expires_days } = req.body;
        const validRoles = ['employee', 'team_lead', 'manager', 'hr_admin'];
        if (role && !validRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role for invite' });
        }
        if (role && ROLE_LEVEL[role] >= (ROLE_LEVEL[req.userRole] || 0)) {
            return res.status(403).json({ error: 'Cannot create invite for a role at or above your own level' });
        }
        const code = require('crypto').randomBytes(6).toString('hex').toUpperCase();
        const expiresAt = expires_days ? new Date(Date.now() + expires_days * 86400000).toISOString() : null;
        await query(
            'INSERT INTO invite_codes (code, created_by, org_id, role, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [code, req.userId, req.userOrgId || null, role || 'employee', max_uses || 0, expiresAt]
        );
        res.json({ code, message: 'Invite code created' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create invite code' });
    }
});

router.delete('/invite-codes/:id', async (req, res) => {
    try {
        const codeRes = await query('SELECT id, org_id FROM invite_codes WHERE id = $1', [Number(req.params.id)]);
        const code = codeRes.rows[0];
        if (!code) return res.status(404).json({ error: 'Invite code not found' });
        if (req.userRole !== 'super_admin' && code.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Cannot deactivate invite codes from another organization' });
        }
        await query('UPDATE invite_codes SET is_active = FALSE WHERE id = $1', [Number(req.params.id)]);
        res.json({ message: 'Invite code deactivated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to deactivate invite code' });
    }
});

// ─── Task Label Management ───────────────────────────────────────────────

router.get('/task-labels', async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const result = await query(
            'SELECT tl.*, u.username as created_by_username FROM task_labels tl LEFT JOIN users u ON u.id = tl.created_by WHERE tl.org_id = $1 ORDER BY tl.name ASC',
            [req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'Fetch labels error');
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
});

router.post('/task-labels', async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization required' });
        const { name, color } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Label name is required' });
        if (name.trim().length > 30) return res.status(400).json({ error: 'Label name must be 30 characters or less' });
        const existingRes = await query('SELECT id FROM task_labels WHERE org_id = $1 AND LOWER(name) = LOWER($2)', [req.userOrgId, name.trim()]);
        if (existingRes.rows[0]) return res.status(409).json({ error: 'A label with this name already exists' });
        const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#6366f1';
        const result = await query(
            'INSERT INTO task_labels (org_id, name, color, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.userOrgId, name.trim(), validColor, req.userId]
        );
        const label = result.rows[0];
        logAction(req, 'create', 'task_label', label.id, { name: label.name });
        res.json(label);
    } catch (err) {
        req.log.error({ err }, 'Create label error');
        res.status(500).json({ error: 'Failed to create label' });
    }
});

router.put('/task-labels/:id', async (req, res) => {
    try {
        const labelRes = await query('SELECT * FROM task_labels WHERE id = $1', [Number(req.params.id)]);
        const label = labelRes.rows[0];
        if (!label) return res.status(404).json({ error: 'Label not found' });
        if (req.userRole !== 'super_admin' && label.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Cannot edit labels from another organization' });
        }
        const { name, color } = req.body;
        const newName = name?.trim() || label.name;
        if (newName.length > 30) return res.status(400).json({ error: 'Label name must be 30 characters or less' });
        if (newName.toLowerCase() !== label.name.toLowerCase()) {
            const existingRes = await query('SELECT id FROM task_labels WHERE org_id = $1 AND LOWER(name) = LOWER($2) AND id != $3', [label.org_id, newName, label.id]);
            if (existingRes.rows[0]) return res.status(409).json({ error: 'A label with this name already exists' });
        }
        const newColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : label.color;
        await query('UPDATE task_labels SET name = $1, color = $2 WHERE id = $3', [newName, newColor, label.id]);
        const updated = await query('SELECT * FROM task_labels WHERE id = $1', [label.id]);
        logAction(req, 'update', 'task_label', label.id, { name: newName });
        res.json(updated.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Update label error');
        res.status(500).json({ error: 'Failed to update label' });
    }
});

router.delete('/task-labels/:id', async (req, res) => {
    try {
        const labelRes = await query('SELECT * FROM task_labels WHERE id = $1', [Number(req.params.id)]);
        const label = labelRes.rows[0];
        if (!label) return res.status(404).json({ error: 'Label not found' });
        if (req.userRole !== 'super_admin' && label.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Cannot delete labels from another organization' });
        }
        await query('DELETE FROM task_label_map WHERE label_id = $1', [label.id]);
        await query('DELETE FROM task_labels WHERE id = $1', [label.id]);
        logAction(req, 'delete', 'task_label', label.id, { name: label.name });
        res.json({ message: 'Label deleted' });
    } catch (err) {
        req.log.error({ err }, 'Delete label error');
        res.status(500).json({ error: 'Failed to delete label' });
    }
});

module.exports = router;