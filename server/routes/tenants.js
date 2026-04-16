/**
 * Tenant Management Routes — platform_admin only.
 * All routes prefixed with /admin/tenants (mounted in index.js).
 */
const express = require('express');
const { masterQuery } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole } = require('../middleware/rbac');
const {
    createTenant, deleteTenant, suspendTenant, reactivateTenant,
    getTenantById, getTenantPool, getPoolStats, listActiveTenants,
} = require('../utils/tenantManager');
const { logAction } = require('../utils/audit');
const { logger } = require('../utils/logger');
const redis = require('../redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { validatePassword, validateUsername } = require('../utils/password');

const router = express.Router();
router.use(auth, loadUserContext, requireRole('platform_admin'));

// ═══════════════════════════════════════════════════════════════
//  TENANT CRUD & LIFECYCLE
// ═══════════════════════════════════════════════════════════════

// POST /admin/tenants — create a new tenant
router.post('/', async (req, res) => {
    try {
        const { org_name, slug, features, max_users, max_storage_mb } = req.body;
        if (!org_name || !slug) {
            return res.status(400).json({ error: 'org_name and slug are required' });
        }
        if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
            return res.status(400).json({ error: 'Slug must be 3-50 chars, lowercase alphanumeric with dashes, no leading/trailing dash.' });
        }

        const { tenant, db } = await createTenant({
            orgName: org_name,
            slug,
            features: features || {},
            maxUsers: max_users || null,
            maxStorageMb: max_storage_mb || null,
        });

        // Auto-seed a super_admin user for the platform admin who created this tenant
        if (req.isPlatformUser) {
            const platUser = (await masterQuery('SELECT * FROM platform_users WHERE id = $1', [req.userId])).rows[0];
            if (platUser) {
                const existing = (await db.query('SELECT id FROM users WHERE username = $1 OR email = $2', [platUser.username, platUser.email || ''])).rows[0];
                if (!existing) {
                    const newUser = (await db.query(
                        `INSERT INTO users (username, password, full_name, email, org_id, role)
                         VALUES ($1, $2, $3, $4, 1, 'super_admin') RETURNING id`,
                        [platUser.username, platUser.password, platUser.full_name, platUser.email || `${platUser.username}@platform.local`]
                    )).rows[0];
                    if (platUser.email) {
                        await masterQuery(
                            'INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                            [platUser.email.toLowerCase(), platUser.username.toLowerCase(), tenant.id, newUser.id]
                        );
                    }
                }
            }
        }

        logAction(req, 'tenant_created', 'tenant', tenant.id, { slug, org_name });
        res.status(201).json({ tenant });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A tenant with that slug already exists.' });
        }
        logger.error({ err }, 'Create tenant error');
        res.status(500).json({ error: 'Failed to create tenant' });
    }
});

// GET /admin/tenants — list all tenants with user counts
router.get('/', async (req, res) => {
    try {
        const { status, search, limit: rawLimit, offset } = req.query;
        const where = [];
        const params = [];
        let p = 1;

        if (status) { where.push(`t.status = $${p++}`); params.push(status); }
        if (search) { where.push(`(t.org_name ILIKE $${p} OR t.slug ILIKE $${p})`); params.push(`%${search}%`); p++; }

        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        const countRes = await masterQuery(`SELECT COUNT(*) FROM tenants t ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].count, 10);

        const tenantsRes = await masterQuery(
            `SELECT t.*,
                    (SELECT COUNT(*) FROM user_directory ud WHERE ud.tenant_id = t.id) AS user_count
             FROM tenants t ${whereClause}
             ORDER BY t.created_at DESC
             LIMIT $${p++} OFFSET $${p++}`,
            [...params, limit, off]
        );

        res.json({ total, tenants: tenantsRes.rows });
    } catch (err) {
        logger.error({ err }, 'List tenants error');
        res.status(500).json({ error: 'Failed to list tenants' });
    }
});

// GET /admin/tenants/overview — aggregate dashboard stats
router.get('/overview', async (req, res) => {
    try {
        const [statusRes, userRes, recentRes] = await Promise.all([
            masterQuery(`SELECT status, COUNT(*) AS count FROM tenants GROUP BY status`),
            masterQuery(`SELECT COUNT(*) AS total_users FROM user_directory`),
            masterQuery(`SELECT id, org_name, slug, status, created_at FROM tenants ORDER BY created_at DESC LIMIT 5`),
        ]);

        const byStatus = {};
        for (const r of statusRes.rows) byStatus[r.status] = parseInt(r.count, 10);

        res.json({
            total_tenants: Object.values(byStatus).reduce((a, b) => a + b, 0),
            total_users: parseInt(userRes.rows[0].total_users, 10),
            by_status: byStatus,
            recent: recentRes.rows,
            pool_stats: getPoolStats(),
        });
    } catch (err) {
        logger.error({ err }, 'Tenant overview error');
        res.status(500).json({ error: 'Failed to get overview' });
    }
});

// GET /admin/tenants/:id — single tenant detail
router.get('/:id', async (req, res) => {
    try {
        const tenant = await getTenantById(Number(req.params.id));
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const userCount = (await masterQuery(
            'SELECT COUNT(*) FROM user_directory WHERE tenant_id = $1', [tenant.id]
        )).rows[0].count;

        res.json({ ...tenant, user_count: parseInt(userCount, 10) });
    } catch (err) {
        logger.error({ err }, 'Get tenant error');
        res.status(500).json({ error: 'Failed to get tenant' });
    }
});

// PUT /admin/tenants/:id — update tenant config
router.put('/:id', async (req, res) => {
    try {
        const { org_name, features, max_users, max_storage_mb } = req.body;
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const result = await masterQuery(
            `UPDATE tenants SET
                org_name = COALESCE($1, org_name),
                features = COALESCE($2, features),
                max_users = COALESCE($3, max_users),
                max_storage_mb = COALESCE($4, max_storage_mb),
                updated_at = NOW()
             WHERE id = $5 RETURNING *`,
            [org_name || null, features ? JSON.stringify(features) : null, max_users ?? null, max_storage_mb ?? null, tid]
        );

        // Invalidate tenant cache
        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        logAction(req, 'tenant_updated', 'tenant', tid, { changes: req.body });
        res.json({ tenant: result.rows[0] });
    } catch (err) {
        logger.error({ err }, 'Update tenant error');
        res.status(500).json({ error: 'Failed to update tenant' });
    }
});

// PUT /admin/tenants/:id/suspend
router.put('/:id/suspend', async (req, res) => {
    try {
        const { reason } = req.body;
        const tid = Number(req.params.id);
        const tenant = await suspendTenant(tid, reason);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        logAction(req, 'tenant_suspended', 'tenant', tid, { reason });
        res.json({ tenant });
    } catch (err) {
        logger.error({ err }, 'Suspend tenant error');
        res.status(500).json({ error: 'Failed to suspend tenant' });
    }
});

// PUT /admin/tenants/:id/reactivate
router.put('/:id/reactivate', async (req, res) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await reactivateTenant(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        await redis.del(`tenant:id:${tid}`);
        if (tenant.custom_domain) await redis.del(`tenant:domain:${tenant.custom_domain}`);

        logAction(req, 'tenant_reactivated', 'tenant', tid);
        res.json({ tenant });
    } catch (err) {
        logger.error({ err }, 'Reactivate tenant error');
        res.status(500).json({ error: 'Failed to reactivate tenant' });
    }
});

// DELETE /admin/tenants/:id?hard=true
router.delete('/:id', async (req, res) => {
    try {
        const tid = Number(req.params.id);
        const hard = req.query.hard === 'true';
        const result = await deleteTenant(tid, hard);
        if (!result) return res.status(404).json({ error: 'Tenant not found' });

        await redis.del(`tenant:id:${tid}`);

        logAction(req, hard ? 'tenant_hard_deleted' : 'tenant_soft_deleted', 'tenant', tid);
        res.json({ message: hard ? 'Tenant permanently deleted.' : 'Tenant marked as deleted.' });
    } catch (err) {
        logger.error({ err }, 'Delete tenant error');
        res.status(500).json({ error: 'Failed to delete tenant' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  TENANT HEALTH & STATS
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/:id/stats
router.get('/:id/stats', async (req, res) => {
    try {
        const tenant = await getTenantById(Number(req.params.id));
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const db = await getTenantPool(tenant.db_name, tenant.db_host);

        const safeCount = (q) => db.query(q).then(r => parseInt(r.rows[0].count, 10)).catch(() => 0);
        const [user_count, task_count, message_count, dbSize, lastActivity] = await Promise.all([
            safeCount('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE'),
            safeCount('SELECT COUNT(*) AS count FROM tasks'),
            safeCount('SELECT COUNT(*) AS count FROM messages'),
            masterQuery(`SELECT pg_database_size($1) AS size`, [tenant.db_name]),
            db.query('SELECT MAX("timestamp") AS last_activity FROM time_entries').catch(() => ({ rows: [{}] })),
        ]);

        res.json({
            user_count,
            task_count,
            message_count,
            db_size_bytes: parseInt(dbSize.rows[0].size, 10),
            last_activity: lastActivity.rows[0]?.last_activity,
        });
    } catch (err) {
        logger.error({ err }, 'Tenant stats error');
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  DOMAIN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// PUT /admin/tenants/:id/domain
router.put('/:id/domain', async (req, res) => {
    try {
        const { custom_domain } = req.body;
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        // Basic domain validation
        if (custom_domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(custom_domain)) {
            return res.status(400).json({ error: 'Invalid domain format' });
        }

        // Clear old domain cache
        if (tenant.custom_domain) {
            await redis.del(`tenant:domain:${tenant.custom_domain}`);
        }

        const result = await masterQuery(
            'UPDATE tenants SET custom_domain = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [custom_domain || null, tid]
        );

        await redis.del(`tenant:id:${tid}`);

        logAction(req, 'tenant_domain_changed', 'tenant', tid, { old: tenant.custom_domain, new: custom_domain });
        res.json({ tenant: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'This domain is already assigned to another tenant.' });
        }
        logger.error({ err }, 'Update domain error');
        res.status(500).json({ error: 'Failed to update domain' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  FEATURE FLAGS & LIMITS
// ═══════════════════════════════════════════════════════════════

// PUT /admin/tenants/:id/features
router.put('/:id/features', async (req, res) => {
    try {
        const { features } = req.body;
        if (!features || typeof features !== 'object') {
            return res.status(400).json({ error: 'features object is required' });
        }
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        // Merge with existing features
        const merged = { ...tenant.features, ...features };
        const result = await masterQuery(
            'UPDATE tenants SET features = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [JSON.stringify(merged), tid]
        );

        await redis.del(`tenant:id:${tid}`);

        logAction(req, 'tenant_features_updated', 'tenant', tid, { features });
        res.json({ tenant: result.rows[0] });
    } catch (err) {
        logger.error({ err }, 'Update features error');
        res.status(500).json({ error: 'Failed to update features' });
    }
});

// PUT /admin/tenants/:id/limits
router.put('/:id/limits', async (req, res) => {
    try {
        const { max_users, max_storage_mb } = req.body;
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const result = await masterQuery(
            'UPDATE tenants SET max_users = $1, max_storage_mb = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
            [max_users ?? tenant.max_users, max_storage_mb ?? tenant.max_storage_mb, tid]
        );

        await redis.del(`tenant:id:${tid}`);

        logAction(req, 'tenant_limits_updated', 'tenant', tid, { max_users, max_storage_mb });
        res.json({ tenant: result.rows[0] });
    } catch (err) {
        logger.error({ err }, 'Update limits error');
        res.status(500).json({ error: 'Failed to update limits' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  IMPERSONATION
// ═══════════════════════════════════════════════════════════════

// POST /admin/tenants/:id/impersonate
router.post('/:id/impersonate', async (req, res) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant || tenant.status !== 'active') {
            return res.status(404).json({ error: 'Tenant not found or not active' });
        }

        // Get the super_admin of the tenant to impersonate as
        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const adminRes = await db.query(
            "SELECT id, username, full_name, email, role FROM users WHERE role = 'super_admin' AND is_active = TRUE LIMIT 1"
        );
        const targetUser = adminRes.rows[0];
        if (!targetUser) {
            return res.status(404).json({ error: 'No active super_admin found in this tenant' });
        }

        // Short-lived impersonation token (15 min)
        const impersonationToken = jwt.sign(
            {
                id: targetUser.id,
                username: targetUser.username,
                tv: 0,
                tenant_id: tid,
                impersonated: true,
                impersonated_by: req.userId,
                original_token: req.cookies.token, // store original platform admin token
            },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        logAction(req, 'tenant_impersonation_started', 'tenant', tid, {
            target_user: targetUser.id,
            target_username: targetUser.username,
        });

        res.json({
            token: impersonationToken,
            tenant: { id: tid, org_name: tenant.org_name, slug: tenant.slug },
            user: targetUser,
        });
    } catch (err) {
        logger.error({ err }, 'Impersonation error');
        res.status(500).json({ error: 'Failed to start impersonation' });
    }
});

// POST /admin/tenants/:id/exit-impersonate
router.post('/:id/exit-impersonate', async (req, res) => {
    try {
        logAction(req, 'tenant_impersonation_ended', 'tenant', Number(req.params.id));
        // Client should restore the original platform admin token
        res.json({ message: 'Impersonation ended. Restore your admin session.' });
    } catch (err) {
        logger.error({ err }, 'Exit impersonation error');
        res.status(500).json({ error: 'Failed to exit impersonation' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  CROSS-TENANT USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// GET /admin/tenants/:id/users
router.get('/:id/users', async (req, res) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const { search, limit: rawLimit, offset } = req.query;
        const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        let whereClause = '';
        const params = [];
        if (search) {
            whereClause = 'WHERE u.full_name ILIKE $1 OR u.username ILIKE $1 OR u.email ILIKE $1';
            params.push(`%${search}%`);
        }

        const countRes = await db.query(`SELECT COUNT(*) FROM users u ${whereClause}`, params);
        const usersRes = await db.query(
            `SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active, u.org_id, u.created_at
             FROM users u ${whereClause}
             ORDER BY u.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, off]
        );

        res.json({ total: parseInt(countRes.rows[0].count, 10), users: usersRes.rows });
    } catch (err) {
        logger.error({ err }, 'List tenant users error');
        res.status(500).json({ error: 'Failed to list users' });
    }
});

// POST /admin/tenants/:id/users — create user in a tenant
router.post('/:id/users', async (req, res) => {
    try {
        const tid = Number(req.params.id);
        const tenant = await getTenantById(tid);
        if (!tenant || tenant.status !== 'active') {
            return res.status(404).json({ error: 'Tenant not found or not active' });
        }

        const { username, password, full_name, email, role } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: 'username, password, full_name and email are required' });
        }

        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });

        // Check global uniqueness
        const dirCheck = await masterQuery(
            'SELECT 1 FROM user_directory WHERE email = $1 OR username = $2',
            [email.toLowerCase(), username.toLowerCase()]
        );
        if (dirCheck.rows[0]) {
            return res.status(409).json({ error: 'Email or username already exists globally.' });
        }

        // Check tenant user limit
        if (tenant.max_users) {
            const countRes = await masterQuery('SELECT COUNT(*) FROM user_directory WHERE tenant_id = $1', [tid]);
            if (parseInt(countRes.rows[0].count, 10) >= tenant.max_users) {
                return res.status(403).json({ error: `Tenant user limit (${tenant.max_users}) reached.` });
            }
        }

        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const hash = await bcrypt.hash(password, 10);
        const validRole = ['super_admin', 'hr_admin', 'manager', 'team_lead', 'employee'].includes(role) ? role : 'employee';

        const result = await db.query(
            'INSERT INTO users (username, password, full_name, email, org_id, role) VALUES ($1,$2,$3,$4,1,$5) RETURNING id, username, full_name, email, role',
            [username, hash, full_name, email, validRole]
        );

        // Add to user_directory
        await masterQuery(
            'INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4)',
            [email.toLowerCase(), username.toLowerCase(), tid, result.rows[0].id]
        );

        logAction(req, 'tenant_user_created', 'user', result.rows[0].id, { tenant_id: tid, username });
        res.status(201).json({ user: result.rows[0] });
    } catch (err) {
        logger.error({ err }, 'Create tenant user error');
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// PUT /admin/tenants/:tenantId/users/:userId/deactivate
router.put('/:tenantId/users/:userId/deactivate', async (req, res) => {
    try {
        const tid = Number(req.params.tenantId);
        const uid = Number(req.params.userId);
        const tenant = await getTenantById(tid);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const db = await getTenantPool(tenant.db_name, tenant.db_host);
        const result = await db.query(
            'UPDATE users SET is_active = FALSE WHERE id = $1 RETURNING id, username',
            [uid]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

        logAction(req, 'tenant_user_deactivated', 'user', uid, { tenant_id: tid });
        res.json({ message: 'User deactivated', user: result.rows[0] });
    } catch (err) {
        logger.error({ err }, 'Deactivate tenant user error');
        res.status(500).json({ error: 'Failed to deactivate user' });
    }
});

module.exports = router;
