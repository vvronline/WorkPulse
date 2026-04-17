const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const redis = require('../redis');
const { masterQuery } = require('../db');
const { getTenantPool, getTenantById, createTenant } = require('../utils/tenantManager');
const { validatePassword, validateUsername } = require('../utils/password');
const { logger } = require('../utils/logger');
const { getTransporter, sendMail } = require('../utils/mailer');
const auth = require('../middleware/auth');

const router = express.Router();

const isProduction = process.env.NODE_ENV === 'production';
// Use secure cookies only when HTTPS is actually configured.
// When serving over plain HTTP (e.g. IP-only deployment), secure:true would
// cause browsers to silently drop the cookie on every request.
const useSecureCookie = isProduction && process.env.USE_HTTPS === 'true';

function cookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000,
    };
}

const MAX_SESSIONS = 2;

/**
 * Resolve a tenant's DB handle from its id.
 * Returns { query, transaction } or null.
 */
async function getTenantDb(tenantId) {
    const tenant = await getTenantById(tenantId);
    if (!tenant || tenant.status !== 'active') return null;
    const poolEntry = await getTenantPool(tenant.db_name, tenant.db_host);
    return { query: poolEntry.query, transaction: poolEntry.transaction, tenant };
}

/**
 * Resolve user for login on the default domain (no tenant in req).
 * Checks user_directory (email) then platform_users (username/email).
 */
async function resolveDefaultDomainUser(identifier) {
    // 1. Try user_directory (email or username)
    const dirRes = await masterQuery(
        'SELECT tenant_id, user_id FROM user_directory WHERE email = $1 OR username = $1',
        [identifier.toLowerCase()]
    );
    if (dirRes.rows[0]) {
        const { tenant_id, user_id } = dirRes.rows[0];
        const tdb = await getTenantDb(tenant_id);
        if (!tdb) return { error: 'Organization is not available.' };
        const userRes = await tdb.query('SELECT * FROM users WHERE id = $1', [user_id]);
        if (userRes.rows[0]) {
            // Check if this user is also a platform admin
            const platCheck = await masterQuery(
                'SELECT 1 FROM platform_users WHERE LOWER(username) = $1 OR LOWER(email) = $1',
                [identifier.toLowerCase()]
            );
            return { user: userRes.rows[0], db: tdb, tenantId: tenant_id, isPlatformUser: !!platCheck.rows[0] };
        }
    }

    // 2. Try platform_users
    const platRes = await masterQuery(
        'SELECT * FROM platform_users WHERE username = $1 OR email = $1',
        [identifier]
    );
    if (platRes.rows[0]) {
        return { user: platRes.rows[0], db: { query: masterQuery }, tenantId: null, isPlatformUser: true };
    }

    // 3. Legacy fallback: check users table in master DB (pre-migration shared database)
    //    This allows login to work before tenants have been migrated.
    try {
        const legacyRes = await masterQuery(
            'SELECT * FROM users WHERE username = $1 OR email = $1',
            [identifier]
        );
        if (legacyRes.rows[0]) {
            return { user: legacyRes.rows[0], db: { query: masterQuery }, tenantId: null };
        }
    } catch { /* users table may not exist in a fresh master-only DB — ignore */ }

    return { user: null };
}

/**
 * Create a session for the user, evicting the oldest if exceeding MAX_SESSIONS.
 * Returns the new session ID.
 */
async function createSession(userId, deviceInfo, db) {
    const sid = crypto.randomUUID();
    await db.query('INSERT INTO user_sessions (id, user_id, device) VALUES ($1, $2, $3)', [sid, userId, deviceInfo || null]);

    // Evict oldest sessions beyond the limit
    const sessRes = await db.query(
        'SELECT id FROM user_sessions WHERE user_id = $1 ORDER BY created_at ASC',
        [userId],
    );
    const sessions = sessRes.rows;
    if (sessions.length > MAX_SESSIONS) {
        const toDelete = sessions.slice(0, sessions.length - MAX_SESSIONS).map(s => s.id);
        await db.query('DELETE FROM user_sessions WHERE id = ANY($1)', [toDelete]);
    }
    await redis.invalidateUserSessions(userId);
    return sid;
}

// Registration mode (public — no auth needed)
router.get('/registration-mode', async (req, res) => {
    try {
        if (req.tenant) {
            // Tenant context: use tenant's registration_mode from features
            const mode = req.tenant.features?.registration_mode || 'invite_only';
            return res.json({ mode });
        }
        // Master context: platform-level registration mode
        const row = await masterQuery("SELECT value FROM app_settings WHERE key = 'registration_mode'");
        res.json({ mode: row.rows[0]?.value || 'open' });
    } catch (err) {
        logger.error({ err }, 'GET /registration-mode error');
        res.status(500).json({ error: 'Failed to fetch registration mode' });
    }
});

// Register
router.post('/register', async (req, res) => {
    try {
        const { username, password, full_name, email, invite_code, tenant_slug } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });

        // Check global uniqueness in user_directory
        const dirCheck = await masterQuery(
            'SELECT 1 FROM user_directory WHERE email = $1 OR username = $2',
            [email.toLowerCase(), username.toLowerCase()]
        );
        if (dirCheck.rows[0]) {
            return res.status(400).json({ error: 'Email or username already registered.' });
        }

        // ── Determine the target database ──
        let db = req.db;
        let tenantId = req.tenant?.id || null;
        let tenantRecord = req.tenant;

        // Default domain: resolve tenant from invite or tenant_slug
        if (!req.tenant) {
            if (tenant_slug) {
                const tRes = await masterQuery('SELECT * FROM tenants WHERE slug = $1 AND status = $2', [tenant_slug, 'active']);
                tenantRecord = tRes.rows[0];
                if (!tenantRecord) return res.status(400).json({ error: 'Organization not found.' });
                tenantId = tenantRecord.id;
                const poolEntry = await getTenantPool(tenantRecord.db_name, tenantRecord.db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            } else {
                // No tenant context — check if first-ever user (platform_admin bootstrap)
                const platCount = (await masterQuery('SELECT COUNT(*) FROM platform_users')).rows[0].count;
                const tenantCount = (await masterQuery('SELECT COUNT(*) FROM tenants')).rows[0].count;
                if (parseInt(platCount) === 0 && parseInt(tenantCount) === 0) {
                    // Bootstrap: create platform_admin in master DB
                    const hash = await bcrypt.hash(password, 10);
                    const result = await masterQuery(
                        'INSERT INTO platform_users (username, password, full_name, email) VALUES ($1,$2,$3,$4) RETURNING id',
                        [username, hash, full_name, email]
                    );
                    const sid = await createSession(result.rows[0].id, req.headers['user-agent'], { query: masterQuery });
                    const token = jwt.sign(
                        { id: result.rows[0].id, username, tv: 0, sid, tenant_id: null, platform: true },
                        process.env.JWT_SECRET,
                        { expiresIn: '8h' }
                    );
                    res.cookie('token', token, cookieOptions());
                    return res.json({
                        user: { id: result.rows[0].id, username, full_name, email, avatar: null, role: 'platform_admin', org_id: null }
                    });
                }
                return res.status(400).json({ error: 'Please register from your organization domain or use an invite link.' });
            }
        }

        // ── Registration mode check ──
        const mode = tenantRecord?.features?.registration_mode || 'invite_only';
        if (mode === 'closed') {
            return res.status(403).json({ error: 'Registration is currently closed. Contact an administrator.' });
        }

        let inviteRow = null;
        if (mode === 'invite_only') {
            if (!invite_code) {
                return res.status(400).json({ error: 'An invite code is required to register.' });
            }
            const invRes = await db.query(
                'SELECT * FROM invite_codes WHERE code = $1 AND is_active = TRUE',
                [invite_code],
            );
            inviteRow = invRes.rows[0] || null;
            if (!inviteRow) {
                return res.status(400).json({ error: 'Invalid or expired invite code.' });
            }
            if (inviteRow.max_uses > 0 && inviteRow.used_count >= inviteRow.max_uses) {
                return res.status(400).json({ error: 'This invite code has reached its usage limit.' });
            }
            if (inviteRow.expires_at && new Date(inviteRow.expires_at) < new Date()) {
                return res.status(400).json({ error: 'This invite code has expired.' });
            }
        }

        // ── Tenant-DB uniqueness ──
        const existingUser = await db.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingUser.rows[0]) return res.status(400).json({ error: 'Username already taken' });
        const existingEmail = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingEmail.rows[0]) return res.status(400).json({ error: 'Email already registered' });

        const hash = await bcrypt.hash(password, 10);
        const assignedOrgId = inviteRow?.org_id || 1; // each tenant has org id=1
        const assignedRole = inviteRow?.role || (mode === 'open' ? 'employee' : 'employee');

        const result = await db.transaction(async (client) => {
            if (inviteRow) {
                const fresh = await client.query(
                    'SELECT used_count, max_uses FROM invite_codes WHERE id = $1 AND is_active = TRUE FOR UPDATE',
                    [inviteRow.id],
                );
                const f = fresh.rows[0];
                if (!f || (f.max_uses > 0 && f.used_count >= f.max_uses)) {
                    throw new Error('INVITE_EXHAUSTED');
                }
                await client.query(
                    'UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1',
                    [inviteRow.id],
                );
            }

            // First user in this tenant DB becomes super_admin
            const userCount = (await client.query('SELECT COUNT(*) FROM users')).rows[0].count;
            let finalRole = assignedRole;
            if (parseInt(userCount) === 0) {
                finalRole = 'super_admin';
            }

            const ins = await client.query(
                'INSERT INTO users (username, password, full_name, email, org_id, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, role',
                [username, hash, full_name, email, assignedOrgId, finalRole],
            );
            return ins.rows[0];
        });

        // Add to user_directory in master DB
        await masterQuery(
            'INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [email.toLowerCase(), username.toLowerCase(), tenantId, result.id]
        );

        const sid = await createSession(result.id, req.headers['user-agent'], db);
        const token = jwt.sign(
            { id: result.id, username, tv: 0, sid, tenant_id: tenantId },
            process.env.JWT_SECRET,
            { expiresIn: '8h' },
        );
        res.cookie('token', token, cookieOptions());
        res.json({ user: { id: result.id, username, full_name, email, avatar: null, role: result.role, org_id: assignedOrgId, tenant_id: tenantId } });
    } catch (err) {
        if (err.message === 'INVITE_EXHAUSTED') {
            return res.status(400).json({ error: 'This invite code has reached its usage limit.' });
        }
        req.log.error({ err }, 'Register error');
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        let user, db, tenantId, isPlatformUser = false;

        if (req.tenant) {
            // ─── Custom domain → query tenant DB directly ───
            db = req.db;
            tenantId = req.tenant.id;
            const userRes = await db.query(
                'SELECT * FROM users WHERE username = $1 OR email = $1', [username]
            );
            user = userRes.rows[0];
        } else {
            // ─── Default domain → cross-tenant resolution ───
            const resolved = await resolveDefaultDomainUser(username);
            if (resolved.error) return res.status(403).json({ error: resolved.error });
            user = resolved.user;
            db = resolved.db;
            tenantId = resolved.tenantId || null;
            isPlatformUser = !!resolved.isPlatformUser;
        }

        // Check account lockout
        if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
            const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
            return res.status(423).json({ error: `Account locked. Try again in ${mins} minute(s).` });
        }

        const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        if (!user || !(await bcrypt.compare(password, user ? user.password : DUMMY_HASH))) {
            if (user && db) {
                // isPlatformUser with tenantId means user record is in tenant users table, not platform_users
                const table = (isPlatformUser && !tenantId) ? 'platform_users' : 'users';
                const attempts = (user.failed_login_attempts || 0) + 1;
                if (attempts >= 5) {
                    await db.query(
                        `UPDATE ${table} SET failed_login_attempts = $1, locked_until = NOW() + INTERVAL '15 minutes' WHERE id = $2`,
                        [attempts, user.id],
                    );
                    return res.status(423).json({ error: 'Account locked for 15 minutes due to too many failed attempts.' });
                }
                await db.query(`UPDATE ${table} SET failed_login_attempts = $1 WHERE id = $2`, [attempts, user.id]);
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (!user.is_active) {
            return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.' });
        }

        // Reset failed attempts on successful login
        if (user.failed_login_attempts > 0) {
            const table = (isPlatformUser && !tenantId) ? 'platform_users' : 'users';
            await db.query(`UPDATE ${table} SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [user.id]);
        }

        const sid = await createSession(user.id, req.headers['user-agent'], db);
        const token = jwt.sign(
            { id: user.id, username: user.username, tv: user.token_version || 0, sid, tenant_id: tenantId, platform: isPlatformUser || undefined },
            process.env.JWT_SECRET,
            { expiresIn: '8h' },
        );
        res.cookie('token', token, cookieOptions());

        if (isPlatformUser) {
            // If user was already resolved with a tenant context (via user_directory),
            // we already have the correct JWT with platform: true and tenant_id.
            // Ensure DB role is platform_admin and return.
            if (tenantId) {
                if (user.role !== 'platform_admin') {
                    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['platform_admin', user.id]);
                    user.role = 'platform_admin';
                }
                const reportsRes = await db.query(
                    'SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1',
                    [user.id],
                );
                return res.json({
                    user: {
                        id: user.id,
                        username: user.username,
                        full_name: user.full_name,
                        email: user.email || null,
                        avatar: user.avatar || null,
                        role: 'platform_admin',
                        org_id: user.org_id || 1,
                        tenant_id: tenantId,
                        has_reports: reportsRes.rowCount > 0,
                    },
                });
            }

            // Platform admin without tenant context — find or create tenant
            // Find their primary tenant and ensure they have a corresponding user account.
            const tenantsRes = await masterQuery(
                'SELECT * FROM tenants WHERE status = $1 ORDER BY id LIMIT 1', ['active']
            );
            const primaryTenant = tenantsRes.rows[0];

            if (primaryTenant) {
                const poolEntry = await getTenantPool(primaryTenant.db_name, primaryTenant.db_host);
                const tenantDb = { query: poolEntry.query, transaction: poolEntry.transaction };

                // Check if platform admin already has a user record in this tenant
                let tenantUser = (await tenantDb.query(
                    'SELECT * FROM users WHERE username = $1 OR email = $2',
                    [user.username, user.email || '']
                )).rows[0];

                if (!tenantUser) {
                    // Create a platform_admin user in the tenant DB
                    tenantUser = (await tenantDb.query(
                        `INSERT INTO users (username, password, full_name, email, org_id, role)
                         VALUES ($1, $2, $3, $4, 1, 'platform_admin') RETURNING *`,
                        [user.username, user.password, user.full_name, user.email || `${user.username}@platform.local`]
                    )).rows[0];

                    // Register in user_directory for future logins
                    if (user.email) {
                        await masterQuery(
                            'INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                            [user.email.toLowerCase(), user.username.toLowerCase(), primaryTenant.id, tenantUser.id]
                        );
                    }
                } else if (tenantUser.role !== 'platform_admin') {
                    // Upgrade existing linked user to platform_admin
                    await tenantDb.query('UPDATE users SET role = $1 WHERE id = $2', ['platform_admin', tenantUser.id]);
                    tenantUser.role = 'platform_admin';
                }

                // Re-issue JWT with tenant context + platform flag so routes use tenant DB
                // while retaining platform_admin powers for tenant management
                const tenantSid = await createSession(tenantUser.id, req.headers['user-agent'], tenantDb);
                const tenantToken = jwt.sign(
                    { id: tenantUser.id, username: tenantUser.username, tv: tenantUser.token_version || 0, sid: tenantSid, tenant_id: primaryTenant.id, platform: true },
                    process.env.JWT_SECRET,
                    { expiresIn: '8h' },
                );
                res.cookie('token', tenantToken, cookieOptions());

                const reportsRes = await tenantDb.query(
                    'SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1',
                    [tenantUser.id],
                );
                return res.json({
                    user: {
                        id: tenantUser.id,
                        username: tenantUser.username,
                        full_name: tenantUser.full_name,
                        email: tenantUser.email || null,
                        avatar: tenantUser.avatar || null,
                        role: 'platform_admin',
                        org_id: tenantUser.org_id || 1,
                        tenant_id: primaryTenant.id,
                        has_reports: reportsRes.rowCount > 0,
                    },
                });
            }

            // No tenant exists yet — auto-provision a default tenant so the app is usable
            const orgName = user.full_name ? `${user.full_name}'s Organization` : 'Default Organization';
            const slug = 'default';
            let newTenant, newDb;
            try {
                ({ tenant: newTenant, db: newDb } = await createTenant({ orgName, slug }));
            } catch (err) {
                logger.error({ err }, 'Auto-provision default tenant failed');
                return res.json({
                    user: {
                        id: user.id,
                        username: user.username,
                        full_name: user.full_name,
                        email: user.email || null,
                        avatar: user.avatar || null,
                        role: 'platform_admin',
                        org_id: null,
                        tenant_id: null,
                    },
                });
            }

            const tenantDb = { query: newDb.query, transaction: newDb.transaction };
            const tenantUser = (await tenantDb.query(
                `INSERT INTO users (username, password, full_name, email, org_id, role)
                 VALUES ($1, $2, $3, $4, 1, 'platform_admin') RETURNING *`,
                [user.username, user.password, user.full_name, user.email || `${user.username}@platform.local`]
            )).rows[0];

            if (user.email) {
                await masterQuery(
                    'INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                    [user.email.toLowerCase(), user.username.toLowerCase(), newTenant.id, tenantUser.id]
                );
            }

            const newSid = await createSession(tenantUser.id, req.headers['user-agent'], tenantDb);
            const newToken = jwt.sign(
                { id: tenantUser.id, username: tenantUser.username, tv: 0, sid: newSid, tenant_id: newTenant.id, platform: true },
                process.env.JWT_SECRET,
                { expiresIn: '8h' },
            );
            res.cookie('token', newToken, cookieOptions());
            return res.json({
                user: {
                    id: tenantUser.id,
                    username: tenantUser.username,
                    full_name: tenantUser.full_name,
                    email: tenantUser.email || null,
                    avatar: tenantUser.avatar || null,
                    role: 'platform_admin',
                    org_id: 1,
                    tenant_id: newTenant.id,
                },
            });
        }

        const reportsRes = await db.query(
            'SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1',
            [user.id],
        );
        res.json({
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                email: user.email || null,
                avatar: user.avatar || null,
                role: user.role || 'employee',
                org_id: user.org_id || null,
                tenant_id: tenantId,
                has_reports: reportsRes.rowCount > 0,
                must_change_password: !!user.must_change_password,
            },
        });
    } catch (err) {
        req.log.error({ err }, 'Login error');
        res.status(500).json({ error: 'Login failed' });
    }
});

// Forgot Password (rate-limited by forgotPasswordLimiter applied in index.js)
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Resolve the correct tenant DB for this email
        let db = req.db;
        let tenantSlug = null;
        if (!req.tenant) {
            // Default domain: look up in user_directory
            const dirRes = await masterQuery(
                'SELECT ud.tenant_id, ud.user_id, t.slug, t.db_name, t.db_host FROM user_directory ud JOIN tenants t ON t.id = ud.tenant_id WHERE ud.email = $1',
                [email.toLowerCase()]
            );
            if (dirRes.rows[0]) {
                tenantSlug = dirRes.rows[0].slug;
                const poolEntry = await getTenantPool(dirRes.rows[0].db_name, dirRes.rows[0].db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            } else {
                // Not found — return generic message (don't leak info)
                return res.json({ message: 'If that email is registered, a reset link has been sent.' });
            }
        }

        const userRes = await db.query('SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        const user = userRes.rows[0];
        if (!user) return res.json({ message: 'If that email is registered, a reset link has been sent.' });

        await db.query('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE', [user.id]);

        const resetToken = crypto.randomBytes(48).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        await db.query(
            'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
            [user.id, tokenHash, expiresAt],
        );

        const clientOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
        // Include tenant_slug in reset link so reset-password can resolve the correct DB
        const slugParam = tenantSlug ? `?t=${encodeURIComponent(tenantSlug)}` : '';
        const resetLink = `${clientOrigin}/reset-password/${resetToken}${slugParam}`;

        const mailer = getTransporter();
        if (mailer) {
            sendMail({
                to: user.email,
                subject: 'WorkPulse — Password Reset',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
                        <h2 style="color:#6366f1;">Reset Your Password</h2>
                        <p>Hi <strong>${user.username.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</strong>,</p>
                        <p>Click the button below to reset your password. This link expires in 1 hour.</p>
                        <a href="${resetLink}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Reset Password</a>
                        <p style="font-size:0.85rem;color:#888;">If you didn't request this, just ignore this email.</p>
                    </div>
                `,
            });
        } else {
            logger.info({ username: user.username }, 'Password reset link generated (no SMTP — token not logged)');
        }

        res.json({ message: 'If that email is registered, a reset link has been sent.' });
    } catch (err) {
        req.log.error({ err }, 'Forgot password error');
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password, tenant_slug } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if (password.length > 72) return res.status(400).json({ error: 'Password must be 72 characters or less' });
        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });

        // Resolve the correct tenant DB
        let db = req.db;
        if (!req.tenant && tenant_slug) {
            const tRes = await masterQuery('SELECT db_name, db_host FROM tenants WHERE slug = $1 AND status = $2', [tenant_slug, 'active']);
            if (tRes.rows[0]) {
                const poolEntry = await getTenantPool(tRes.rows[0].db_name, tRes.rows[0].db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            }
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const rowRes = await db.query(
            `SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.username
             FROM password_reset_tokens prt
             JOIN users u ON u.id = prt.user_id
             WHERE prt.token = $1`,
            [tokenHash],
        );
        const row = rowRes.rows[0];
        if (!row) return res.status(400).json({ error: 'Invalid or expired reset link' });
        if (row.used) return res.status(400).json({ error: 'This reset link has already been used' });
        if (new Date(row.expires_at) < new Date()) {
            return res.status(400).json({ error: 'This reset link has expired' });
        }

        const hash = await bcrypt.hash(password, 10);
        await db.query(
            'UPDATE users SET password = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
            [hash, row.user_id],
        );
        await redis.invalidateTokenVersion(row.user_id);
        // Clear all active sessions on password reset
        await db.query('DELETE FROM user_sessions WHERE user_id = $1', [row.user_id]);
        await redis.invalidateUserSessions(row.user_id);
        await db.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [row.id]);

        res.json({ message: 'Password has been reset successfully. You can now sign in.' });
    } catch (err) {
        req.log.error({ err }, 'Reset password error');
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Refresh token
router.post('/refresh', auth, async (req, res) => {
    try {
        const row = (await req.db.query('SELECT token_version FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!row) return res.status(401).json({ error: 'User not found' });

        const token = jwt.sign(
            { id: req.userId, username: req.username, tv: row.token_version || 0, sid: req.sessionId, tenant_id: req.tenantId || null },
            process.env.JWT_SECRET,
            { expiresIn: '8h' },
        );
        res.cookie('token', token, cookieOptions());
        res.json({ message: 'Token refreshed' });
    } catch (err) {
        req.log.error({ err }, 'Token refresh error');
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

// Logout — always succeeds even without a valid token
router.post('/logout', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded.sid) {
                await req.db.query('DELETE FROM user_sessions WHERE id = $1', [decoded.sid]);
                await redis.invalidateUserSessions(decoded.id);
            }
            // Set user status to offline
            if (decoded.id) {
                await req.db.query('UPDATE users SET user_status = $1, user_status_text = NULL WHERE id = $2', ['offline', decoded.id]);
                await redis.setUserStatus(decoded.id, 'offline');
            }
        }
    } catch { /* token may be expired/invalid — still clear cookie */ }
    res.clearCookie('token', { httpOnly: true, secure: useSecureCookie, sameSite: 'strict', path: '/' });
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;