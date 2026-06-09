import express from "express";
import type { Request, Response } from "express";
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const redis = require("../redis");
const { masterQuery, masterTransaction } = require("../db");
const { getTenantPool, getTenantById, createTenant } = require("../utils/tenantManager");
const { validatePassword, validateUsername, BCRYPT_ROUNDS } = require("../utils/password");
const { logger } = require("../utils/logger");
const { getTransporter, sendMail } = require("../utils/mailer");
const auth = require("../middleware/auth");
const { getEffectiveFeatures } = require("../utils/planCatalog");
const { logPlatformAction } = require("../utils/platformAudit");

const router = express.Router();

const { cookieOptions } = require("../utils/cookie");

// Allow up to two concurrent active sessions per user (e.g. desktop app +
// browser, or laptop + phone). When a user signs in on a third device, the
// oldest active session is evicted so the device count never exceeds the cap.
// Note: a stolen/forgotten session on one device is therefore NOT auto-kicked
// by a fresh login on another device — users must explicitly log out or reset
// their password (which clears all sessions and bumps token_version) to revoke.
const MAX_SESSIONS = 2;

/**
 * Resolve a tenant's DB handle from its id.
 * Returns { query, transaction } or null.
 */
async function getTenantDb(tenantId: number): Promise<any> {
    const tenant = await getTenantById(tenantId);
    if (!tenant || tenant.status !== "active") return null;
    const poolEntry = await getTenantPool(tenant.db_name, tenant.db_host);
    return { query: poolEntry.query, transaction: poolEntry.transaction, tenant };
}

/**
 * Resolve user for login on the default domain (no tenant in req).
 * Checks user_directory (email) then platform_users (username/email).
 */
async function resolveDefaultDomainUser(identifier: string): Promise<any> {
    // 1. Try user_directory (email or username)
    const dirRes = await masterQuery(
        "SELECT tenant_id, user_id FROM user_directory WHERE email = $1 OR username = $1",
        [identifier.toLowerCase()]
    );
    if (dirRes.rows[0]) {
        const { tenant_id, user_id } = dirRes.rows[0];
        const tdb = await getTenantDb(tenant_id);
        if (!tdb) return { error: "Organization is not available." };
        const userRes = await tdb.query("SELECT * FROM users WHERE id = $1", [user_id]);
        if (userRes.rows[0]) {
            // Check if this user is also a platform admin
            const platCheck = await masterQuery(
                "SELECT 1 FROM platform_users WHERE LOWER(username) = $1 OR LOWER(email) = $1",
                [identifier.toLowerCase()]
            );
            // Return the tenant record (carries .slug) so flows that need the
            // tenant slug can access it.
            return { user: userRes.rows[0], db: tdb, tenantId: tenant_id, isPlatformUser: !!platCheck.rows[0], tenant: tdb.tenant };
        }
    }

    // 2. Try platform_users
    const platRes = await masterQuery(
        "SELECT * FROM platform_users WHERE username = $1 OR email = $1",
        [identifier]
    );
    if (platRes.rows[0]) {
        return { user: platRes.rows[0], db: { query: masterQuery }, tenantId: null, isPlatformUser: true };
    }

    // Legacy single-DB fallback removed (was: SELECT * FROM users in master DB).
    // After migration to per-tenant databases, every real user lives in either
    // user_directory (mapped to a tenant DB) or platform_users. Falling back
    // to a master-DB users lookup masked routing bugs and added attack surface
    // (an unbounded auth lookup against the master pool).
    //
    // If you are still on a pre-migration deployment, run the migration script
    // to backfill user_directory rows before upgrading.
    return { user: null };
}

/**
 * Create a session for the user, evicting the oldest if exceeding MAX_SESSIONS.
 * Returns the new session ID.
 */
async function createSession(userId: number, deviceInfo: unknown, db: any, tenantId: number | null): Promise<string> {
    const sid = crypto.randomUUID();
    await db.query("INSERT INTO user_sessions (id, user_id, device) VALUES ($1, $2, $3)", [sid, userId, deviceInfo || null]);

    // Evict oldest sessions beyond the limit
    const sessRes = await db.query(
        "SELECT id FROM user_sessions WHERE user_id = $1 ORDER BY created_at ASC",
        [userId],
    );
    const sessions = sessRes.rows;
    if (sessions.length > MAX_SESSIONS) {
        const toDelete = sessions.slice(0, sessions.length - MAX_SESSIONS).map((s: any) => s.id);
        await db.query("DELETE FROM user_sessions WHERE id = ANY($1)", [toDelete]);
    }
    await redis.invalidateUserSessions(tenantId, userId);
    return sid;
}

// Registration mode (public — no auth needed)
router.get("/registration-mode", async (req: Request, res: Response) => {
    try {
        if (req.tenant) {
            // Tenant context: use tenant's registration_mode from features
            const mode = (req.tenant.features as any)?.registration_mode || "invite_only";
            return res.json({ mode });
        }
        // Master context: platform-level registration mode
        const row = await masterQuery("SELECT value FROM app_settings WHERE key = 'registration_mode'");
        res.json({ mode: row.rows[0]?.value || "open" });
    } catch (err) {
        logger.error({ err }, "GET /registration-mode error");
        res.status(500).json({ error: "Failed to fetch registration mode" });
    }
});

// Register
router.post("/register", async (req: Request, res: Response) => {
    try {
        const { username, password, full_name, email, invite_code, tenant_slug } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: "All fields are required" });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: "Invalid email address" });
        }
        const pwError = await validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });

        // Check global uniqueness in user_directory
        const dirCheck = await masterQuery(
            "SELECT 1 FROM user_directory WHERE email = $1 OR username = $2",
            [email.toLowerCase(), username.toLowerCase()]
        );
        if (dirCheck.rows[0]) {
            return res.status(400).json({ error: "Email or username already registered." });
        }

        // ── Determine the target database ──
        let db: any = req.db;
        let tenantId = req.tenant?.id || null;
        let tenantRecord: any = req.tenant;

        // Default domain: resolve tenant from invite or tenant_slug
        if (!req.tenant) {
            if (tenant_slug) {
                const tRes = await masterQuery("SELECT * FROM tenants WHERE slug = $1 AND status = $2", [tenant_slug, "active"]);
                tenantRecord = tRes.rows[0];
                if (!tenantRecord) return res.status(400).json({ error: "Organization not found." });
                tenantId = tenantRecord.id;
                const poolEntry = await getTenantPool(tenantRecord.db_name, tenantRecord.db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            } else {
                // No tenant context — check if first-ever user (platform_admin bootstrap)
                // Use advisory lock to prevent race condition where two concurrent requests
                // both see zero counts and both create a platform_admin
                const bootstrapResult = await masterTransaction(async (client: any) => {
                    await client.query("SELECT pg_advisory_xact_lock(1)"); // lock #1 = bootstrap
                    const platCount = (await client.query("SELECT COUNT(*) FROM platform_users")).rows[0].count;
                    const tenantCount = (await client.query("SELECT COUNT(*) FROM tenants")).rows[0].count;
                    if (parseInt(platCount) === 0 && parseInt(tenantCount) === 0) {
                        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
                        const result = await client.query(
                            "INSERT INTO platform_users (username, password, full_name, email) VALUES ($1,$2,$3,$4) RETURNING id",
                            [username, hash, full_name, email]
                        );
                        return result.rows[0];
                    }
                    return null;
                });
                if (bootstrapResult) {
                    const sid = await createSession(bootstrapResult.id, req.headers["user-agent"], { query: masterQuery }, null);
                    const token = jwt.sign(
                        { id: bootstrapResult.id, username, tv: 0, sid, tenant_id: null, platform: true },
                        process.env.JWT_SECRET,
                        { expiresIn: "8h" }
                    );
                    res.cookie("token", token, cookieOptions(req));
                    return res.json({
                        user: { id: bootstrapResult.id, username, full_name, email, avatar: null, role: "platform_admin", org_id: null }
                    });
                }
                return res.status(400).json({ error: "Please register from your organization domain or use an invite link." });
            }
        }

        // ── Registration mode check ──
        // `registration_mode` lives in `tenants.features` JSON next to the real
        // feature flags. It is NOT a plan-gated feature — every plan supports
        // open/invite_only/closed registration. The key is preserved verbatim
        // (the planCatalog sanitiser drops unknown keys from gating but
        // leaves them in the underlying JSON column).
        const mode = tenantRecord?.features?.registration_mode || "invite_only";
        if (mode === "closed") {
            return res.status(403).json({ error: "Registration is currently closed. Contact an administrator." });
        }

        // ── Plan user-cap check ──
        // Enforce the per-tenant `max_users` from the subscription plan BEFORE
        // we create the row. Without this, a Standard tenant (25 user limit)
        // could be filled to thousands via self-signup. Counts active users
        // only — deactivated accounts don't take up a seat.
        if (tenantRecord?.max_users) {
            const countRes = await db.query("SELECT COUNT(*)::int AS c FROM users WHERE is_active = TRUE");
            const current = parseInt(countRes.rows[0].c, 10);
            if (current >= tenantRecord.max_users) {
                return res.status(403).json({
                    error: `This organization has reached its user limit (${tenantRecord.max_users}). Contact your administrator to upgrade the plan.`,
                    code: "USER_LIMIT_REACHED",
                });
            }
        }

        let inviteRow: any = null;
        if (mode === "invite_only") {
            if (!invite_code) {
                return res.status(400).json({ error: "An invite code is required to register." });
            }
            const invRes = await db.query(
                "SELECT * FROM invite_codes WHERE code = $1 AND is_active = TRUE",
                [invite_code],
            );
            inviteRow = invRes.rows[0] || null;
            if (!inviteRow) {
                return res.status(400).json({ error: "Invalid or expired invite code." });
            }
            if (inviteRow.max_uses > 0 && inviteRow.used_count >= inviteRow.max_uses) {
                return res.status(400).json({ error: "This invite code has reached its usage limit." });
            }
            if (inviteRow.expires_at && new Date(inviteRow.expires_at) < new Date()) {
                return res.status(400).json({ error: "This invite code has expired." });
            }
        }

        // ── Tenant-DB uniqueness ──
        const existingUser = await db.query("SELECT id FROM users WHERE username = $1", [username]);
        if (existingUser.rows[0]) return res.status(400).json({ error: "Username already taken" });
        const existingEmail = await db.query("SELECT id FROM users WHERE email = $1", [email]);
        if (existingEmail.rows[0]) return res.status(400).json({ error: "Email already registered" });

        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const assignedOrgId = inviteRow?.org_id || 1; // each tenant has org id=1
        const assignedRole = inviteRow?.role || (mode === "open" ? "employee" : "employee");

        const result = await db.transaction(async (client: any) => {
            if (inviteRow) {
                const fresh = await client.query(
                    "SELECT used_count, max_uses FROM invite_codes WHERE id = $1 AND is_active = TRUE FOR UPDATE",
                    [inviteRow.id],
                );
                const f = fresh.rows[0];
                if (!f || (f.max_uses > 0 && f.used_count >= f.max_uses)) {
                    throw new Error("INVITE_EXHAUSTED");
                }
                await client.query(
                    "UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1",
                    [inviteRow.id],
                );
            }

            // First user in this tenant DB becomes super_admin
            const userCount = (await client.query("SELECT COUNT(*) FROM users")).rows[0].count;
            let finalRole = assignedRole;
            if (parseInt(userCount) === 0) {
                finalRole = "super_admin";
            }

            const ins = await client.query(
                "INSERT INTO users (username, password, full_name, email, org_id, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, role",
                [username, hash, full_name, email, assignedOrgId, finalRole],
            );
            return ins.rows[0];
        });

        // Add to user_directory in master DB (retry once on failure — cross-DB so can't share transaction)
        try {
            await masterQuery(
                "INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                [email.toLowerCase(), username.toLowerCase(), tenantId, result.id]
            );
        } catch (dirErr) {
            req.log.error({ err: dirErr }, "user_directory insert failed, retrying");
            await masterQuery(
                "INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                [email.toLowerCase(), username.toLowerCase(), tenantId, result.id]
            );
        }

        const sid = await createSession(result.id, req.headers["user-agent"], db, tenantId);
        const token = jwt.sign(
            { id: result.id, username, tv: 0, sid, tenant_id: tenantId },
            process.env.JWT_SECRET,
            { expiresIn: "8h" },
        );
        res.cookie("token", token, cookieOptions(req));
        res.json({ user: { id: result.id, username, full_name, email, avatar: null, role: result.role, org_id: assignedOrgId, tenant_id: tenantId } });
    } catch (err: any) {
        if (err.message === "INVITE_EXHAUSTED") {
            return res.status(400).json({ error: "This invite code has reached its usage limit." });
        }
        req.log.error({ err }, "Register error");
        res.status(500).json({ error: "Registration failed" });
    }
});

/**
 * Complete a successful authentication: create the session, mint the JWT,
 * set the cookie and return the user payload. The platform-admin
 * tenant-provisioning logic lives in exactly one place.
 *
 * @param {object} params
 * @param {object} params.user            – the authenticated user row
 * @param {object} params.db              – tenant/master db handle ({ query, transaction })
 * @param {number|null} params.tenantId   – tenant id (null for pure platform users)
 * @param {boolean} params.isPlatformUser – true if this is a platform_users account
 */
async function finishLogin(req: Request, res: Response, { user, db, tenantId, isPlatformUser }: { user: any; db: any; tenantId: number | null; isPlatformUser?: boolean }) {
    const sid = await createSession(user.id, req.headers["user-agent"], db, tenantId);
    const token = jwt.sign(
        { id: user.id, username: user.username, tv: user.token_version || 0, sid, tenant_id: tenantId, platform: isPlatformUser || undefined },
        process.env.JWT_SECRET,
        { expiresIn: "8h" },
    );
    res.cookie("token", token, cookieOptions(req));

    if (isPlatformUser) {
        // If user was already resolved with a tenant context (via user_directory),
        // we already have the correct JWT with platform: true and tenant_id.
        // Ensure DB role is platform_admin and return.
        if (tenantId) {
            if (user.role !== "platform_admin") {
                await db.query("UPDATE users SET role = $1 WHERE id = $2", ["platform_admin", user.id]);
                user.role = "platform_admin";
            }
            const reportsRes = await db.query(
                "SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1",
                [user.id],
            );
            return res.json({
                user: {
                    id: user.id,
                    username: user.username,
                    full_name: user.full_name,
                    email: user.email || null,
                    avatar: user.avatar || null,
                    role: "platform_admin",
                    org_id: user.org_id || 1,
                    tenant_id: tenantId,
                    has_reports: reportsRes.rowCount > 0,
                },
            });
        }

        // Platform admin without tenant context — find or create tenant
        // Find their primary tenant and ensure they have a corresponding user account.
        const tenantsRes = await masterQuery(
            "SELECT * FROM tenants WHERE status = $1 ORDER BY id LIMIT 1", ["active"]
        );
        const primaryTenant = tenantsRes.rows[0];

        if (primaryTenant) {
            const poolEntry = await getTenantPool(primaryTenant.db_name, primaryTenant.db_host);
            const tenantDb = { query: poolEntry.query, transaction: poolEntry.transaction };

            // Check if platform admin already has a user record in this tenant
            let tenantUser = (await tenantDb.query(
                "SELECT * FROM users WHERE username = $1 OR email = $2",
                [user.username, user.email || ""]
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
                        "INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                        [user.email.toLowerCase(), user.username.toLowerCase(), primaryTenant.id, tenantUser.id]
                    );
                }
            } else if (tenantUser.role !== "platform_admin") {
                // Upgrade existing linked user to platform_admin
                await tenantDb.query("UPDATE users SET role = $1 WHERE id = $2", ["platform_admin", tenantUser.id]);
                tenantUser.role = "platform_admin";
            }

            // Re-issue JWT with tenant context + platform flag so routes use tenant DB
            // while retaining platform_admin powers for tenant management
            const tenantSid = await createSession(tenantUser.id, req.headers["user-agent"], tenantDb, primaryTenant.id);
            const tenantToken = jwt.sign(
                { id: tenantUser.id, username: tenantUser.username, tv: tenantUser.token_version || 0, sid: tenantSid, tenant_id: primaryTenant.id, platform: true },
                process.env.JWT_SECRET,
                { expiresIn: "8h" },
            );
            res.cookie("token", tenantToken, cookieOptions(req));

            const reportsRes = await tenantDb.query(
                "SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1",
                [tenantUser.id],
            );
            return res.json({
                user: {
                    id: tenantUser.id,
                    username: tenantUser.username,
                    full_name: tenantUser.full_name,
                    email: tenantUser.email || null,
                    avatar: tenantUser.avatar || null,
                    role: "platform_admin",
                    org_id: tenantUser.org_id || 1,
                    tenant_id: primaryTenant.id,
                    has_reports: reportsRes.rowCount > 0,
                },
            });
        }

        // No tenant exists yet — auto-provision a default tenant so the app is usable
        const orgName = user.full_name ? `${user.full_name}'s Organization` : "Default Organization";
        const slug = "default";
        let newTenant: any, newDb: any;
        try {
            ({ tenant: newTenant, db: newDb } = await createTenant({ orgName, slug }));
            // Mark this tenant as the default (platform) tenant so that
            // service-desk tickets from every tenant get mirrored here.
            try {
                await masterQuery(
                    `UPDATE tenants SET is_default = TRUE WHERE id = $1`,
                    [newTenant.id]
                );
                newTenant.is_default = true;
            } catch (flagErr) {
                logger.warn({ err: flagErr, tenantId: newTenant.id }, "Failed to flag tenant as default (non-fatal)");
            }
        } catch (err) {
            logger.error({ err }, "Auto-provision default tenant failed");
            return res.json({
                user: {
                    id: user.id,
                    username: user.username,
                    full_name: user.full_name,
                    email: user.email || null,
                    avatar: user.avatar || null,
                    role: "platform_admin",
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
                "INSERT INTO user_directory (email, username, tenant_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                [user.email.toLowerCase(), user.username.toLowerCase(), newTenant.id, tenantUser.id]
            );
        }

        const newSid = await createSession(tenantUser.id, req.headers["user-agent"], tenantDb, newTenant.id);
        const newToken = jwt.sign(
            { id: tenantUser.id, username: tenantUser.username, tv: 0, sid: newSid, tenant_id: newTenant.id, platform: true },
            process.env.JWT_SECRET,
            { expiresIn: "8h" },
        );
        res.cookie("token", newToken, cookieOptions(req));
        return res.json({
            user: {
                id: tenantUser.id,
                username: tenantUser.username,
                full_name: tenantUser.full_name,
                email: tenantUser.email || null,
                avatar: tenantUser.avatar || null,
                role: "platform_admin",
                org_id: 1,
                tenant_id: newTenant.id,
            },
        });
    }

    const reportsRes = await db.query(
        "SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1",
        [user.id],
    );
    return res.json({
        user: {
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            email: user.email || null,
            avatar: user.avatar || null,
            role: user.role || "employee",
            org_id: user.org_id || null,
            tenant_id: tenantId,
            has_reports: reportsRes.rowCount > 0,
            must_change_password: !!user.must_change_password,
        },
    });
}

// Login
router.post("/login", async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required" });
        }

        let user: any, db: any, tenantId: number | null, isPlatformUser = false;

        if (req.tenant) {
            // ─── Custom domain → query tenant DB directly ───
            db = req.db;
            tenantId = req.tenant.id;
            const userRes = await db.query(
                "SELECT * FROM users WHERE username = $1 OR email = $1", [username]
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

        // Check account lockout — return generic message to prevent account enumeration
        if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
        if (!user || !(await bcrypt.compare(password, user ? user.password : DUMMY_HASH))) {
            if (user && db) {
                const attempts = (user.failed_login_attempts || 0) + 1;
                const lockQuery = attempts >= 5
                    ? "failed_login_attempts = $1, locked_until = NOW() + INTERVAL '15 minutes'"
                    : "failed_login_attempts = $1";
                if (isPlatformUser && !tenantId) {
                    await db.query(`UPDATE platform_users SET ${lockQuery} WHERE id = $2`, [attempts, user.id]);
                } else {
                    await db.query(`UPDATE users SET ${lockQuery} WHERE id = $2`, [attempts, user.id]);
                }
            }
            return res.status(401).json({ error: "Invalid credentials" });
        }
        if (!user.is_active) {
            return res.status(403).json({ error: "Your account has been deactivated. Contact your administrator." });
        }

        // Reset failed attempts on successful login
        if (user.failed_login_attempts > 0) {
            if (isPlatformUser && !tenantId) {
                await db.query("UPDATE platform_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
            } else {
                await db.query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
            }
        }

        return finishLogin(req, res, { user, db, tenantId, isPlatformUser });
    } catch (err) {
        req.log.error({ err }, "Login error");
        res.status(500).json({ error: "Login failed" });
    }
});

// Forgot Password (rate-limited by forgotPasswordLimiter applied in index.js)
router.post("/forgot-password", async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email is required" });

        // Resolve the correct tenant DB for this email
        let db: any = req.db;
        let tenantSlug = null;
        if (!req.tenant) {
            // Default domain: look up in user_directory
            const dirRes = await masterQuery(
                "SELECT ud.tenant_id, ud.user_id, t.slug, t.db_name, t.db_host FROM user_directory ud JOIN tenants t ON t.id = ud.tenant_id WHERE ud.email = $1",
                [email.toLowerCase()]
            );
            if (dirRes.rows[0]) {
                tenantSlug = dirRes.rows[0].slug;
                const poolEntry = await getTenantPool(dirRes.rows[0].db_name, dirRes.rows[0].db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            } else {
                // Not found — return generic message (don't leak info)
                return res.json({ message: "If that email is registered, a reset link has been sent." });
            }
        }

        const userRes = await db.query("SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)", [email]);
        const user = userRes.rows[0];
        if (!user) return res.json({ message: "If that email is registered, a reset link has been sent." });

        await db.query("UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE", [user.id]);

        const resetToken = crypto.randomBytes(48).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        await db.query(
            "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
            [user.id, tokenHash, expiresAt],
        );

        const clientOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
        // Include tenant_slug in reset link so reset-password can resolve the correct DB
        const slugParam = tenantSlug ? `?t=${encodeURIComponent(tenantSlug)}` : "";
        const resetLink = `${clientOrigin}/reset-password/${resetToken}${slugParam}`;

        const mailer = getTransporter();
        if (mailer) {
            const sent = await sendMail({
                to: user.email,
                subject: "WorkPulse — Password Reset",
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
                        <h2 style="color:#6366f1;">Reset Your Password</h2>
                        <p>Hi <strong>${user.username.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong>,</p>
                        <p>Click the button below to reset your password. This link expires in 1 hour.</p>
                        <a href="${resetLink}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Reset Password</a>
                        <p style="font-size:0.85rem;color:#888;">If you didn't request this, just ignore this email.</p>
                    </div>
                `,
            });
            if (!sent) {
                req.log.error({ email: user.email }, "Password reset email failed to send");
            }
        } else {
            logger.info({ username: user.username }, "Password reset link generated (no SMTP — token not logged)");
        }

        res.json({ message: "If that email is registered, a reset link has been sent." });
    } catch (err) {
        req.log.error({ err }, "Forgot password error");
        res.status(500).json({ error: "Failed to process request" });
    }
});

// Reset Password
router.post("/reset-password", async (req: Request, res: Response) => {
    try {
        const { token, password, tenant_slug } = req.body;
        if (!token || !password) return res.status(400).json({ error: "Token and new password are required" });
        if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
        if (password.length > 72) return res.status(400).json({ error: "Password must be 72 characters or less" });
        const pwError = await validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });

        // Resolve the correct tenant DB
        let db: any = req.db;
        if (!req.tenant && tenant_slug) {
            const tRes = await masterQuery("SELECT db_name, db_host FROM tenants WHERE slug = $1 AND status = $2", [tenant_slug, "active"]);
            if (tRes.rows[0]) {
                const poolEntry = await getTenantPool(tRes.rows[0].db_name, tRes.rows[0].db_host);
                db = { query: poolEntry.query, transaction: poolEntry.transaction };
            }
        }

        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const rowRes = await db.query(
            `SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.username
             FROM password_reset_tokens prt
             JOIN users u ON u.id = prt.user_id
             WHERE prt.token = $1`,
            [tokenHash],
        );
        const row = rowRes.rows[0];
        if (!row) return res.status(400).json({ error: "Invalid or expired reset link" });
        if (row.used) return res.status(400).json({ error: "This reset link has already been used" });
        if (new Date(row.expires_at) < new Date()) {
            return res.status(400).json({ error: "This reset link has expired" });
        }

        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await db.query(
            "UPDATE users SET password = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2",
            [hash, row.user_id],
        );
        await redis.invalidateTokenVersion(req.tenant?.id || null, row.user_id);
        // Clear all active sessions on password reset
        await db.query("DELETE FROM user_sessions WHERE user_id = $1", [row.user_id]);
        await redis.invalidateUserSessions(req.tenant?.id || null, row.user_id);
        await db.query("UPDATE password_reset_tokens SET used = TRUE WHERE id = $1", [row.id]);

        res.json({ message: "Password has been reset successfully. You can now sign in." });
    } catch (err) {
        req.log.error({ err }, "Reset password error");
        res.status(500).json({ error: "Failed to reset password" });
    }
});

// Refresh token
router.post("/refresh", auth, async (req: Request, res: Response) => {
    try {
        const row = (await req.db!.query("SELECT token_version FROM users WHERE id = $1", [req.userId])).rows[0];
        if (!row) return res.status(401).json({ error: "User not found" });

        const claims: any = {
            id: req.userId,
            username: req.username,
            tv: row.token_version || 0,
            sid: req.sessionId,
            tenant_id: req.tenantId || null,
        };
        // Preserve platform_admin flag across refreshes
        if (req.isPlatformUser) claims.platform = true;
        // Preserve impersonation state
        if (req.isImpersonated) {
            claims.impersonated = true;
            claims.impersonated_by = req.impersonatedBy;
            if (req.impersonatedTenantName) claims.impersonated_tenant_name = req.impersonatedTenantName;
        }

        const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "8h" });
        res.cookie("token", token, cookieOptions(req));
        res.json({ message: "Token refreshed" });
    } catch (err) {
        req.log.error({ err }, "Token refresh error");
        res.status(500).json({ error: "Failed to refresh token" });
    }
});

// Logout — always succeeds even without a valid token
router.post("/logout", async (req: Request, res: Response) => {
    try {
        const token = req.cookies.token;
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
            if (decoded.sid) {
                // Only delete the session that belongs to this user
                await req.db!.query("DELETE FROM user_sessions WHERE id = $1 AND user_id = $2", [decoded.sid, decoded.id]);
                await redis.invalidateUserSessions(decoded.tenant_id || null, decoded.id);
            }
            // Status service v2: close all open presence sessions for this
            // user (logout means every device is gone). The service handles
            // the legacy `users.user_status = 'offline'` dual-write and
            // broadcasts a `user_status` event with effective='offline'.
            //
            // CRITICAL: we no longer pin the user's manual status to
            // 'offline' here — the old code did, which broke "Appear
            // Offline" semantics on the very next reconnect. The status
            // service correctly treats logout as a session-closure only;
            // the user's `manual_status` / `presence_preference` rows
            // are preserved verbatim.
            if (decoded.id) {
                const statusService = require("../services/status");
                await statusService.closeAllSessions(
                    { db: req.db, tenantId: decoded.tenant_id || null },
                    decoded.id,
                    { source: "logout" }
                ).catch((err: any) => logger.warn({ err: err.message, userId: decoded.id }, "logout: statusService.closeAllSessions failed"));
            }
        }
    } catch { /* token may be expired/invalid — still clear cookie */ }
    // Cookie attributes on clear MUST match those used when the cookie was
    // set, otherwise browsers/Electron silently keep the cookie (the JWT
    // would then survive across "logout" until expiry). cookieOptions()
    // already encapsulates the per-environment / per-origin matrix
    // (Electron uses sameSite=none+secure, production uses secure, dev uses
    // sameSite=strict without secure). Reuse it here so set/clear stay in
    // sync — only override maxAge to 0 to expire immediately.
    res.clearCookie("token", cookieOptions(req, 0));
    res.json({ message: "Logged out successfully" });
});

export = router;