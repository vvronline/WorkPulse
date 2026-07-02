import express from "express";
import type { Request, Response, NextFunction } from "express";
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
const { logAction } = require("../utils/audit");
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const router = express.Router();

// ── WebAuthn / passkey configuration ──────────────────────────────────────
// rpID is the registrable domain (no scheme/port), e.g. "app.workpulse.com".
// origin is the full scheme+host the browser sends, e.g. "https://app.workpulse.com".
// Both can be overridden via env for multi-domain / custom-domain deployments.
function webauthnConfig(req: Request): { rpID: string; rpName: string; origin: string } {
    const envRpId = process.env.WEBAUTHN_RP_ID;
    const envOrigin = process.env.WEBAUTHN_ORIGIN || process.env.CORS_ORIGIN;
    // Derive from the request host as a sensible default in dev / single-domain.
    const host = (req.headers.host || "localhost:5000").split(",")[0].trim();
    const hostname = host.split(":")[0];
    const proto = (req.headers["x-forwarded-proto"] as string) || (req.secure ? "https" : "http");
    const rpID = envRpId || hostname;
    const origin = envOrigin
        ? envOrigin.split(",")[0].trim()
        : `${proto}://${host}`;
    return { rpID, rpName: "Loops", origin };
}

const { cookieOptions } = require("../utils/cookie");

// Native mobile clients (React Native) can't use HttpOnly cookies, so they need
// the JWT in the response body. This wraps res.cookie/res.json once for the
// whole auth router: whenever an auth flow sets the `token` cookie, the same
// token is mirrored into the JSON body as `token`. Web/desktop clients keep
// using the cookie and simply ignore the extra field.
router.use((req: Request, res: Response, next: NextFunction) => {
    const originalCookie = res.cookie.bind(res);
    res.cookie = ((name: string, value: string, options?: any) => {
        if (name === "token") res.locals.authToken = value;
        return originalCookie(name, value, options);
    }) as any;

    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
        if (
            res.locals.authToken &&
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            body.token === undefined
        ) {
            body.token = res.locals.authToken;
        }
        return originalJson(body);
    }) as any;

    next();
});

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
            const isPlatformUser = !!platCheck.rows[0];

            // ── Self-heal: platform admin polluted into a CUSTOMER tenant ──
            // A historical bug seeded platform admins into the first active
            // tenant (not the default platform tenant) and left a sticky
            // user_directory row pointing there. Platform admins must only
            // live in the default tenant; customer tenants are reached
            // exclusively via consent-gated impersonation. When we detect a
            // platform admin whose directory row points at a NON-default
            // tenant, scrub the stale data and fall through to the pure
            // platform_users login path below (finishLogin then homes them
            // in the default tenant correctly).
            if (isPlatformUser && tdb.tenant && !tdb.tenant.is_default) {
                logger.warn(
                    { identifier: identifier.toLowerCase(), tenantId: tenant_id },
                    "Platform admin found in non-default tenant — scrubbing stale membership"
                );
                try {
                    await masterQuery(
                        "DELETE FROM user_directory WHERE tenant_id = $1 AND user_id = $2",
                        [tenant_id, user_id]
                    );
                } catch (e: any) {
                    logger.warn({ err: e?.message }, "self-heal: user_directory cleanup failed");
                }
                try {
                    await tdb.query(
                        "UPDATE users SET is_active = FALSE, hidden_from_directory = TRUE WHERE id = $1",
                        [user_id]
                    );
                } catch (e: any) {
                    logger.warn({ err: e?.message }, "self-heal: tenant users row cleanup failed");
                }
                // Fall through to the platform_users lookup below.
            } else {
                // Return the tenant record (carries .slug) so flows that need the
                // tenant slug can access it.
                return { user: userRes.rows[0], db: tdb, tenantId: tenant_id, isPlatformUser, tenant: tdb.tenant };
            }
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

        // ── Self-registration is disabled ──
        //
        // Members are added exclusively by an admin (Admin → People → Add
        // people). The ONLY exception is the first-ever platform-admin
        // bootstrap on a brand-new install (no platform users AND no tenants
        // exist yet) — without it there would be no way to create the first
        // admin, locking everyone out. That single path is preserved below;
        // every other registration attempt (tenant domain, invite code, or
        // tenant_slug self-signup) is rejected with 403.
        const SELF_REG_DISABLED_MSG =
            "Self-registration is disabled. Please contact your administrator to have an account created for you.";

        if (req.tenant) {
            // Custom-domain / tenant-context registration — always blocked.
            return res.status(403).json({ error: SELF_REG_DISABLED_MSG });
        }

        if (tenant_slug) {
            // Default-domain self-signup targeting a specific org — blocked.
            return res.status(403).json({ error: SELF_REG_DISABLED_MSG });
        }

        // No tenant context — the only allowed path: first-ever platform_admin
        // bootstrap. Use an advisory lock to prevent a race where two
        // concurrent requests both see zero counts and both create an admin.
        {
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
            // Platform admin(s) / tenants already exist → self-registration is off.
            return res.status(403).json({ error: SELF_REG_DISABLED_MSG });
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

        // Platform admin without tenant context — home them in the DEFAULT
        // platform tenant ONLY. Platform admins must NEVER be provisioned as
        // users inside customer tenants: they reach those exclusively through
        // the consent-gated impersonation flow (see routes/tenants.ts
        // POST /:id/impersonate and getOrCreateInspectorUser). The previous
        // query here picked the first ACTIVE tenant by id, which silently
        // seeded the platform admin into whichever customer tenant was
        // created first — polluting its user directory and consuming a plan
        // seat. Restricting to is_default = TRUE fixes that: if no default
        // tenant exists yet, the auto-provision path below creates one.
        const tenantsRes = await masterQuery(
            "SELECT * FROM tenants WHERE status = $1 AND is_default = TRUE ORDER BY id LIMIT 1", ["active"]
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
                subject: "Loops — Password Reset",
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
        // Revoke any enrolled biometric device credentials — a password reset
        // means "I no longer trust the old devices", so the biometric-unlocked
        // refresh secrets must stop working too (mirrors the session wipe).
        // Best-effort: the table may not exist on a not-yet-migrated tenant.
        try {
            await db.query("UPDATE device_credentials SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id]);
        } catch (e: any) {
            req.log.warn({ err: e?.message, userId: row.user_id }, "reset-password: device_credentials revoke skipped");
        }
        // Same for WebAuthn passkeys.
        try {
            await db.query("UPDATE webauthn_credentials SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id]);
        } catch (e: any) {
            req.log.warn({ err: e?.message, userId: row.user_id }, "reset-password: webauthn_credentials revoke skipped");
        }
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

                // Remove THIS device's push token (if the client supplied it) so
                // a logged-out device stops receiving call/message pushes (fixes
                // "ring after logout"). We only delete the exact token for this
                // user — other devices of the same user keep their registration.
                const logoutDeviceToken = (req.body || {}).deviceToken;
                if (logoutDeviceToken && String(logoutDeviceToken).trim()) {
                    await req.db!.query(
                        "DELETE FROM device_tokens WHERE user_id = $1 AND device_token = $2",
                        [decoded.id, logoutDeviceToken],
                    ).catch((err: any) => logger.warn({ err: err.message, userId: decoded.id }, "logout: device_tokens delete failed"));
                }
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

/**
 * Register or update a device token for push notifications.
 * Called by mobile apps (Expo/FCM) to register their device for push notifications.
 * POST /api/auth/device-token — requires authentication (user session).
 */
router.post("/device-token", auth, async (req: Request, res: Response) => {
    try {
        const { deviceToken, platform } = req.body;
        // Diagnostic: log every hit (token redacted) so we can confirm the
        // mobile app is actually reaching this endpoint and see why a
        // registration is rejected. Without this, a failing/absent registration
        // is invisible — the #1 reason "no device tokens" persists.
        logger.info(
            {
                userId: (req as any).userId ?? null,
                tenantId: (req as any).tenantId ?? null,
                platform: platform ?? null,
                hasToken: Boolean(deviceToken && String(deviceToken).trim()),
                tokenLen: deviceToken ? String(deviceToken).length : 0,
            },
            "POST /device-token received",
        );
        if (!deviceToken || !deviceToken.trim()) {
            logger.warn({ userId: (req as any).userId ?? null }, "POST /device-token rejected: missing deviceToken");
            return res.status(400).json({ error: "Device token is required" });
        }
        if (!platform || !["ios", "android", "web"].includes(platform)) {
            logger.warn({ userId: (req as any).userId ?? null, platform }, "POST /device-token rejected: invalid platform");
            return res.status(400).json({ error: "Valid platform is required (ios, android, or web)" });
        }

        const userId = (req as any).userId;
        const tenantId = (req as any).tenantId || null;

        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        // Register the device token in the database
        const db = req.db || { query: masterQuery };
        await db.query(
            `INSERT INTO device_tokens (user_id, tenant_id, device_token, platform, last_seen_at, created_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             ON CONFLICT (user_id, device_token) DO UPDATE
             SET platform = EXCLUDED.platform, last_seen_at = NOW()`,
            [userId, tenantId || null, deviceToken, platform]
        );

        logger.info({ userId, tenantId, platform }, "Device token registered for push notifications");
        res.json({ message: "Device token registered successfully" });
    } catch (err: any) {
        logger.error({ err: err.message }, "POST /device-token error");
        res.status(500).json({ error: "Failed to register device token" });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// Biometric ("login with your face") device credentials — Option B.
//
// The OS authenticator (Face ID / Touch ID / Windows Hello / Android
// BiometricPrompt / WebAuthn) performs the biometric match LOCALLY on the
// device. It unlocks a high-entropy device secret that the client keeps in
// its secure enclave / keystore. The server only ever sees (and stores a
// bcrypt HASH of) that secret — no face/biometric data ever leaves the
// device.
//
// credentialId format: "<tenantId>.<uuid>"  (tenantId 0 = platform/master).
// Embedding the tenant id lets the PUBLIC /biometric/login endpoint resolve
// the correct tenant DB without the client having to send a username first.
//
// Endpoints:
//   POST   /auth/biometric/enroll   (auth)   — mint + store a device secret
//   POST   /auth/biometric/login    (public) — exchange secret for a session
//   GET    /auth/biometric          (auth)   — list this user's devices
//   DELETE /auth/biometric/:id      (auth)   — revoke a device credential
// ─────────────────────────────────────────────────────────────────────────

const BIOMETRIC_PLATFORMS = ["ios", "android", "desktop", "web"];

/**
 * Phase 5 feature flag: is biometric / passkey login enabled for the tenant
 * that owns `userId`? Reads `organizations.biometric_login_enabled`.
 *
 * - Platform users (no tenant) are never gated — they manage tenants.
 * - Fails OPEN (returns true) when the column/row is missing, e.g. a tenant
 *   DB that hasn't picked up the 2026_06_v16 migration yet. This matches the
 *   column's DEFAULT TRUE so the feature keeps working through a deploy.
 */
async function isBiometricLoginEnabled(db: any, userId: number, isPlatformUser?: boolean): Promise<boolean> {
    if (isPlatformUser) return true;
    try {
        const row = (await db.query(
            `SELECT o.biometric_login_enabled AS enabled
             FROM users u JOIN organizations o ON o.id = u.org_id
             WHERE u.id = $1`,
            [userId],
        )).rows[0];
        return row ? row.enabled !== false : true;
    } catch {
        return true; // not-yet-migrated tenant → default enabled
    }
}

router.post("/biometric/enroll", auth, async (req: Request, res: Response) => {
    try {
        const { platform, deviceLabel } = req.body || {};
        if (!platform || !BIOMETRIC_PLATFORMS.includes(platform)) {
            return res.status(400).json({ error: "Valid platform is required (ios, android, desktop, or web)" });
        }
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });

        const tenantId = (req as any).tenantId || 0;
        const db = req.db || { query: masterQuery };

        // Phase 5 feature-flag gate: refuse new enrollments when the tenant
        // admin has switched biometric login off.
        if (!(await isBiometricLoginEnabled(db, userId, (req as any).isPlatformUser))) {
            return res.status(403).json({ error: "Biometric login is disabled for your organization." });
        }

        // High-entropy device secret (256 bits). Returned to the client ONCE;
        // only its bcrypt hash is persisted. Never logged.
        const deviceSecret = crypto.randomBytes(32).toString("hex");
        const secretHash = await bcrypt.hash(deviceSecret, BCRYPT_ROUNDS);
        const credentialId = `${tenantId}.${crypto.randomUUID()}`;
        const label = (typeof deviceLabel === "string" && deviceLabel.trim())
            ? deviceLabel.trim().slice(0, 100)
            : null;

        await db.query(
            `INSERT INTO device_credentials (id, user_id, secret_hash, device_label, platform, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [credentialId, userId, secretHash, label, platform],
        );

        logAction(req, "biometric_enroll", "user", userId, { platform, device_label: label });
        res.json({ credentialId, deviceSecret });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "POST /biometric/enroll error");
        res.status(500).json({ error: "Failed to enroll biometric credential" });
    }
});

router.post("/biometric/login", async (req: Request, res: Response) => {
    try {
        const { credentialId, deviceSecret } = req.body || {};
        if (!credentialId || !deviceSecret || typeof credentialId !== "string") {
            return res.status(400).json({ error: "credentialId and deviceSecret are required" });
        }

        // Parse the embedded tenant id. Anything malformed → generic failure
        // (don't leak which part was wrong).
        const dotIdx = credentialId.indexOf(".");
        const tenantPart = dotIdx > 0 ? credentialId.slice(0, dotIdx) : "";
        const tenantId = /^\d+$/.test(tenantPart) ? parseInt(tenantPart, 10) : NaN;
        if (!Number.isFinite(tenantId)) {
            return res.status(401).json({ error: "Invalid biometric credential" });
        }

        // Resolve the DB + (for finishLogin) the tenant context.
        let db: any;
        let resolvedTenantId: number | null;
        let isPlatformUser = false;
        if (tenantId > 0) {
            const tdb = await getTenantDb(tenantId);
            if (!tdb) return res.status(401).json({ error: "Invalid biometric credential" });
            db = tdb;
            resolvedTenantId = tenantId;
        } else {
            // Platform/master credential.
            db = { query: masterQuery };
            resolvedTenantId = null;
            isPlatformUser = true;
        }

        const credRes = await db.query(
            "SELECT id, user_id, secret_hash FROM device_credentials WHERE id = $1 AND revoked_at IS NULL",
            [credentialId],
        );
        const cred = credRes.rows[0];

        // Constant-ish time: always run a bcrypt compare even when the
        // credential is missing, to avoid a trivial timing oracle.
        const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
        const ok = await bcrypt.compare(deviceSecret, cred ? cred.secret_hash : DUMMY_HASH);
        if (!cred || !ok) {
            return res.status(401).json({ error: "Invalid biometric credential" });
        }

        // Load the user the credential belongs to.
        const userRes = isPlatformUser
            ? await db.query("SELECT * FROM platform_users WHERE id = $1", [cred.user_id])
            : await db.query("SELECT * FROM users WHERE id = $1", [cred.user_id]);
        const user = userRes.rows[0];
        if (!user) {
            return res.status(401).json({ error: "Invalid biometric credential" });
        }
        if (!isPlatformUser && user.is_active === false) {
            return res.status(403).json({ error: "Your account has been deactivated. Contact your administrator." });
        }

        // Phase 5 feature-flag gate: an admin may have disabled biometric login
        // for the org after this device enrolled. Block the login (password
        // still works) — generic message, same shape as other failures.
        if (!(await isBiometricLoginEnabled(db, cred.user_id, isPlatformUser))) {
            return res.status(403).json({ error: "Biometric login is disabled for your organization." });
        }

        // Best-effort: record last use (don't fail login if this errors).
        try {
            await db.query("UPDATE device_credentials SET last_used_at = NOW() WHERE id = $1", [credentialId]);
        } catch { /* non-fatal */ }

        logAction(req, "biometric_login", "user", user.id, { credential_id: credentialId });
        return finishLogin(req, res, { user, db, tenantId: resolvedTenantId, isPlatformUser });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "POST /biometric/login error");
        res.status(500).json({ error: "Biometric login failed" });
    }
});

router.get("/biometric", auth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });
        const db = req.db || { query: masterQuery };
        const rows = (await db.query(
            `SELECT id, device_label, platform, created_at, last_used_at
             FROM device_credentials
             WHERE user_id = $1 AND revoked_at IS NULL
             ORDER BY created_at DESC`,
            [userId],
        )).rows;
        res.json({ devices: rows });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "GET /biometric error");
        res.status(500).json({ error: "Failed to list biometric devices" });
    }
});

router.delete("/biometric/:id", auth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });
        const db = req.db || { query: masterQuery };
        // Scope the revoke to the caller's own credentials so one user can't
        // revoke another user's device by guessing its id.
        const result = await db.query(
            "UPDATE device_credentials SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
            [req.params.id, userId],
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Biometric credential not found" });
        }
        logAction(req, "biometric_revoke", "user", userId, { credential_id: req.params.id });
        res.json({ message: "Biometric credential revoked" });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "DELETE /biometric/:id error");
        res.status(500).json({ error: "Failed to revoke biometric credential" });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// WebAuthn / passkeys — web biometric login (Phase 3).
//
// Public-key login: the browser's platform authenticator (Touch ID / Windows
// Hello / Face ID / a security key) holds the PRIVATE key; we store only the
// PUBLIC key + a signature counter. On login the authenticator signs a random
// server challenge (gated by the OS biometric); we verify the signature.
//
// Multi-tenant resolution trick: we set the WebAuthn `userHandle` to
// "<tenantId>.<userId>" at registration time. A usernameless (discoverable)
// login returns that handle in the assertion, so we resolve the tenant DB +
// user directly — no cross-tenant credential search needed.
//
// Endpoints:
//   POST /auth/webauthn/register/options  (auth)   — registration challenge
//   POST /auth/webauthn/register/verify   (auth)   — store the public key
//   POST /auth/webauthn/login/options     (public) — auth challenge (+ flowId)
//   POST /auth/webauthn/login/verify      (public) — verify + issue session
// ─────────────────────────────────────────────────────────────────────────

// Short-lived challenge store. Prefers Redis (multi-instance safe); falls back
// to an in-memory Map with TTL so the feature still works in single-instance /
// no-Redis dev environments.
const WEBAUTHN_CHALLENGE_TTL_S = 300; // 5 minutes
const _waChallengeMem = new Map<string, { value: string; expiresAt: number }>();
function _waMemSweep(): void {
    const now = Date.now();
    for (const [k, v] of _waChallengeMem) if (v.expiresAt <= now) _waChallengeMem.delete(k);
}
async function waSetChallenge(key: string, value: string): Promise<void> {
    await redis.set(`wa:${key}`, value, WEBAUTHN_CHALLENGE_TTL_S);
    _waMemSweep();
    _waChallengeMem.set(key, { value, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_S * 1000 });
}
async function waGetChallenge(key: string): Promise<string | null> {
    const fromRedis = await redis.get(`wa:${key}`);
    if (fromRedis) return fromRedis;
    const entry = _waChallengeMem.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    return null;
}
async function waDelChallenge(key: string): Promise<void> {
    await redis.del(`wa:${key}`);
    _waChallengeMem.delete(key);
}

router.post("/webauthn/register/options", auth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });
        const tenantId = (req as any).tenantId || 0;
        const db = req.db || { query: masterQuery };

        // Phase 5 feature-flag gate: refuse new passkey registration when the
        // tenant admin has switched biometric login off.
        if (!(await isBiometricLoginEnabled(db, userId, (req as any).isPlatformUser))) {
            return res.status(403).json({ error: "Biometric login is disabled for your organization." });
        }

        const { rpID, rpName, origin } = webauthnConfig(req);

        // Exclude already-registered passkeys so the user can't double-enroll
        // the same authenticator.
        const existing = (await db.query(
            "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1 AND revoked_at IS NULL",
            [userId],
        )).rows;

        const userHandle = `${tenantId}.${userId}`;
        const options = await generateRegistrationOptions({
            rpName,
            rpID,
            userID: Buffer.from(userHandle),
            userName: (req as any).username || `user-${userId}`,
            userDisplayName: (req as any).username || `user-${userId}`,
            attestationType: "none",
            excludeCredentials: existing.map((c: any) => ({
                id: c.credential_id,
                transports: c.transports ? String(c.transports).split(",") : undefined,
            })),
            authenticatorSelection: {
                residentKey: "preferred",
                userVerification: "preferred",
            },
        });

        // Stash the challenge server-side keyed by the user; never trust a
        // client-echoed challenge.
        await waSetChallenge(`reg:${tenantId}:${userId}`, options.challenge);
        res.json({ options, rpID, origin });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "POST /webauthn/register/options error");
        res.status(500).json({ error: "Failed to start passkey registration" });
    }
});

router.post("/webauthn/register/verify", auth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });
        const tenantId = (req as any).tenantId || 0;
        const db = req.db || { query: masterQuery };
        const { rpID, origin } = webauthnConfig(req);

        const { response, deviceLabel } = req.body || {};
        if (!response) return res.status(400).json({ error: "Missing attestation response" });

        const expectedChallenge = await waGetChallenge(`reg:${tenantId}:${userId}`);
        if (!expectedChallenge) {
            return res.status(400).json({ error: "Registration session expired. Please try again." });
        }

        const verification = await verifyRegistrationResponse({
            response,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: false,
        });

        if (!verification.verified || !verification.registrationInfo) {
            return res.status(400).json({ error: "Passkey registration could not be verified" });
        }

        const { credential } = verification.registrationInfo;
        const publicKeyB64 = Buffer.from(credential.publicKey).toString("base64");
        const transports = Array.isArray(response.response?.transports)
            ? response.response.transports.join(",")
            : null;
        const label = (typeof deviceLabel === "string" && deviceLabel.trim())
            ? deviceLabel.trim().slice(0, 100)
            : null;

        await db.query(
            `INSERT INTO webauthn_credentials
               (user_id, credential_id, public_key, counter, transports, device_label, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (credential_id) DO UPDATE
               SET public_key = EXCLUDED.public_key, counter = EXCLUDED.counter, revoked_at = NULL`,
            [userId, credential.id, publicKeyB64, credential.counter || 0, transports, label],
        );

        await waDelChallenge(`reg:${tenantId}:${userId}`);
        logAction(req, "webauthn_register", "user", userId, { credential_id: credential.id, device_label: label });
        res.json({ verified: true });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "POST /webauthn/register/verify error");
        res.status(500).json({ error: "Failed to verify passkey registration" });
    }
});

router.post("/webauthn/login/options", async (req: Request, res: Response) => {
    try {
        const { rpID } = webauthnConfig(req);
        // Usernameless / discoverable login: no allowCredentials, so the
        // browser offers every passkey registered for this RP.
        const options = await generateAuthenticationOptions({
            rpID,
            userVerification: "preferred",
        });
        // Key the challenge by a random flowId returned to the client; the
        // client must echo it on verify. This avoids needing a username up
        // front while still binding the challenge server-side.
        const flowId = crypto.randomUUID();
        await waSetChallenge(`login:${flowId}`, options.challenge);
        res.json({ options, flowId });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "POST /webauthn/login/options error");
        res.status(500).json({ error: "Failed to start passkey login" });
    }
});

router.post("/webauthn/login/verify", async (req: Request, res: Response) => {
    try {
        const { rpID, origin } = webauthnConfig(req);
        const { response, flowId } = req.body || {};
        if (!response || !flowId || typeof flowId !== "string") {
            return res.status(400).json({ error: "Missing assertion response or flowId" });
        }

        const expectedChallenge = await waGetChallenge(`login:${flowId}`);
        if (!expectedChallenge) {
            return res.status(400).json({ error: "Login session expired. Please try again." });
        }
        // Single-use challenge.
        await waDelChallenge(`login:${flowId}`);

        // Decode the userHandle ("<tenantId>.<userId>") the authenticator
        // returns; it tells us which tenant DB + user owns this passkey.
        const userHandleRaw = response.response?.userHandle;
        if (!userHandleRaw) {
            return res.status(401).json({ error: "Invalid passkey" });
        }
        // userHandle arrives base64url-encoded from the browser.
        let userHandle: string;
        try {
            userHandle = Buffer.from(userHandleRaw, "base64").toString("utf8");
        } catch {
            return res.status(401).json({ error: "Invalid passkey" });
        }
        const dot = userHandle.indexOf(".");
        const tenantPart = dot > 0 ? userHandle.slice(0, dot) : "";
        const userPart = dot > 0 ? userHandle.slice(dot + 1) : "";
        const tenantId = /^\d+$/.test(tenantPart) ? parseInt(tenantPart, 10) : NaN;
        const handleUserId = /^\d+$/.test(userPart) ? parseInt(userPart, 10) : NaN;
        if (!Number.isFinite(tenantId) || !Number.isFinite(handleUserId)) {
            return res.status(401).json({ error: "Invalid passkey" });
        }

        // Resolve the DB + tenant context.
        let db: any;
        let resolvedTenantId: number | null;
        let isPlatformUser = false;
        if (tenantId > 0) {
            const tdb = await getTenantDb(tenantId);
            if (!tdb) return res.status(401).json({ error: "Invalid passkey" });
            db = tdb;
            resolvedTenantId = tenantId;
        } else {
            db = { query: masterQuery };
            resolvedTenantId = null;
            isPlatformUser = true;
        }

        // Look up the stored public key for this credential id.
        const credRow = (await db.query(
            "SELECT id, user_id, public_key, counter FROM webauthn_credentials WHERE credential_id = $1 AND revoked_at IS NULL",
            [response.id],
        )).rows[0];
        if (!credRow || credRow.user_id !== handleUserId) {
            return res.status(401).json({ error: "Invalid passkey" });
        }

        const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: false,
            credential: {
                id: response.id,
                publicKey: new Uint8Array(Buffer.from(credRow.public_key, "base64")),
                counter: Number(credRow.counter) || 0,
            },
        });

        if (!verification.verified) {
            return res.status(401).json({ error: "Passkey verification failed" });
        }

        // Bump the signature counter (clone-detection) + last-used.
        const newCounter = verification.authenticationInfo?.newCounter ?? credRow.counter;
        try {
            await db.query(
                "UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2",
                [newCounter, credRow.id],
            );
        } catch { /* non-fatal */ }

        // Load the user and complete login.
        const userRes = isPlatformUser
            ? await db.query("SELECT * FROM platform_users WHERE id = $1", [credRow.user_id])
            : await db.query("SELECT * FROM users WHERE id = $1", [credRow.user_id]);
        const user = userRes.rows[0];
        if (!user) return res.status(401).json({ error: "Invalid passkey" });
        if (!isPlatformUser && user.is_active === false) {
            return res.status(403).json({ error: "Your account has been deactivated. Contact your administrator." });
        }

        // Phase 5 feature-flag gate: an admin may have disabled biometric login
        // for the org after this passkey was registered.
        if (!(await isBiometricLoginEnabled(db, credRow.user_id, isPlatformUser))) {
            return res.status(403).json({ error: "Biometric login is disabled for your organization." });
        }

        logAction(req, "webauthn_login", "user", user.id, { credential_id: response.id });
        return finishLogin(req, res, { user, db, tenantId: resolvedTenantId, isPlatformUser });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "POST /webauthn/login/verify error");
        res.status(500).json({ error: "Passkey login failed" });
    }
});

router.get("/webauthn", auth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });
        const db = req.db || { query: masterQuery };
        const rows = (await db.query(
            `SELECT id, device_label, transports, created_at, last_used_at
             FROM webauthn_credentials
             WHERE user_id = $1 AND revoked_at IS NULL
             ORDER BY created_at DESC`,
            [userId],
        )).rows;
        res.json({ passkeys: rows });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "GET /webauthn error");
        res.status(500).json({ error: "Failed to list passkeys" });
    }
});

router.delete("/webauthn/:id", auth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "User not authenticated" });
        const db = req.db || { query: masterQuery };
        const result = await db.query(
            "UPDATE webauthn_credentials SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
            [req.params.id, userId],
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Passkey not found" });
        }
        logAction(req, "webauthn_revoke", "user", userId, { passkey_id: req.params.id });
        res.json({ message: "Passkey removed" });
    } catch (err: any) {
        req.log.error({ err: err?.message }, "DELETE /webauthn/:id error");
        res.status(500).json({ error: "Failed to remove passkey" });
    }
});

export = router;
