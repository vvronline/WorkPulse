/**
 * MFA (TOTP) management endpoints — mounted at /api/mfa (behind `auth`).
 *
 * Dual-table aware: platform_users (master DB) for pure platform admins,
 * tenant `users` otherwise. Policy:
 *   • platform_admin            → MFA mandatory (cannot disable).
 *   • super_admin / hr_admin     → MFA opt-in (enable/disable allowed).
 *   • everyone else              → not eligible (403).
 *
 * Endpoints:
 *   GET    /status                       – current MFA state for the caller
 *   POST   /setup                        – generate a provisional secret + QR
 *   POST   /enable      { code }         – verify provisional secret, turn on,
 *                                          return one-time recovery codes
 *   POST   /disable     { password, code } – opt-in roles only
 *   POST   /recovery-codes/regenerate { code } – issue fresh recovery codes
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { masterQuery } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { logger } = require('../utils/logger');
const { logPlatformAction } = require('../utils/platformAudit');
const {
    generateSecret,
    buildOtpAuthUrl,
    buildQrDataUrl,
    verifyToken,
    encryptSecret,
    decryptSecret,
    generateRecoveryCodes,
    verifyRecoveryCode,
} = require('../utils/mfa');
const { isMfaMandatory, canOptIntoMfa } = require('../utils/mfaPolicy');

const router = express.Router();

router.use(auth);
router.use(loadUserContext);

/**
 * Resolve the principal's storage context:
 *   { table, db, isPlatform, role, label } where
 *     - table is 'platform_users' or 'users'
 *     - db is a { query } handle for that table
 *     - label is an account identifier for the otpauth URI
 */
async function resolveMfaContext(req) {
    // Pure platform user (no tenant context) → master platform_users.
    if (req.isPlatformUser && !req.tenantId) {
        const row = (await masterQuery(
            'SELECT id, username, full_name, email, mfa_secret, mfa_enabled, mfa_pending_secret, mfa_recovery_codes FROM platform_users WHERE id = $1',
            [req.userId]
        )).rows[0];
        return {
            table: 'platform_users',
            db: { query: masterQuery },
            isPlatform: true,
            role: 'platform_admin',
            user: row,
            label: row ? (row.email || row.username) : `user-${req.userId}`,
        };
    }
    // Tenant user (including platform admins operating inside a tenant).
    const row = (await req.db.query(
        'SELECT id, username, full_name, email, role, mfa_secret, mfa_enabled, mfa_pending_secret, mfa_recovery_codes FROM users WHERE id = $1',
        [req.userId]
    )).rows[0];
    // For a platform admin operating with a tenant context, treat as platform.
    const isPlatform = req.userRole === 'platform_admin' || !!req.isPlatformUser;
    return {
        table: 'users',
        db: req.db,
        isPlatform,
        role: row ? row.role : req.userRole,
        user: row,
        label: row ? (row.email || row.username) : `user-${req.userId}`,
    };
}

function recoveryCount(user) {
    return Array.isArray(user?.mfa_recovery_codes) ? user.mfa_recovery_codes.length : 0;
}

// GET /status
router.get('/status', async (req, res) => {
    try {
        const ctx = await resolveMfaContext(req);
        if (!ctx.user) return res.status(404).json({ error: 'Account not found' });
        const mandatory = isMfaMandatory({ isPlatformUser: ctx.isPlatform, role: ctx.role });
        const eligible = canOptIntoMfa({ isPlatformUser: ctx.isPlatform, role: ctx.role });
        res.json({
            enabled: !!ctx.user.mfa_enabled,
            enrolled: !!ctx.user.mfa_enabled,
            required: mandatory,
            eligible,
            recovery_codes_remaining: recoveryCount(ctx.user),
        });
    } catch (err) {
        logger.error({ err }, 'GET /mfa/status error');
        res.status(500).json({ error: 'Failed to load MFA status' });
    }
});

// POST /setup — generate a provisional secret (not active until /enable)
router.post('/setup', async (req, res) => {
    try {
        const ctx = await resolveMfaContext(req);
        if (!ctx.user) return res.status(404).json({ error: 'Account not found' });
        if (!canOptIntoMfa({ isPlatformUser: ctx.isPlatform, role: ctx.role })) {
            return res.status(403).json({ error: 'MFA is not available for your role.' });
        }

        const secret = generateSecret();
        const otpauthUrl = buildOtpAuthUrl(secret, ctx.label);
        const qr = await buildQrDataUrl(otpauthUrl);

        await ctx.db.query(
            `UPDATE ${ctx.table} SET mfa_pending_secret = $1 WHERE id = $2`,
            [encryptSecret(secret), ctx.user.id]
        );

        res.json({ otpauth_url: otpauthUrl, qr_data_url: qr, secret });
    } catch (err) {
        logger.error({ err }, 'POST /mfa/setup error');
        res.status(500).json({ error: 'Failed to start MFA setup' });
    }
});

// POST /enable — verify the provisional secret then activate, returning codes
router.post('/enable', async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ error: 'Verification code is required' });

        const ctx = await resolveMfaContext(req);
        if (!ctx.user) return res.status(404).json({ error: 'Account not found' });
        if (!canOptIntoMfa({ isPlatformUser: ctx.isPlatform, role: ctx.role })) {
            return res.status(403).json({ error: 'MFA is not available for your role.' });
        }

        const pending = decryptSecret(ctx.user.mfa_pending_secret);
        if (!pending) {
            return res.status(400).json({ error: 'No pending MFA setup. Start setup again.' });
        }
        if (!verifyToken(pending, code)) {
            return res.status(401).json({ error: 'Invalid verification code.' });
        }

        const { plaintext, hashes } = await generateRecoveryCodes();
        await ctx.db.query(
            `UPDATE ${ctx.table}
                SET mfa_secret = $1,
                    mfa_enabled = TRUE,
                    mfa_enrolled_at = NOW(),
                    mfa_pending_secret = NULL,
                    mfa_recovery_codes = $2
              WHERE id = $3`,
            [ctx.user.mfa_pending_secret, JSON.stringify(hashes), ctx.user.id]
        );

        if (ctx.isPlatform) logPlatformAction(req, 'mfa_enabled', 'platform_user', ctx.user.id, {}, req.tenantId || null);

        res.json({ enabled: true, recovery_codes: plaintext });
    } catch (err) {
        logger.error({ err }, 'POST /mfa/enable error');
        res.status(500).json({ error: 'Failed to enable MFA' });
    }
});

// POST /disable — opt-in roles only; platform_admin (mandatory) cannot disable
router.post('/disable', async (req, res) => {
    try {
        const { password, code } = req.body || {};
        const ctx = await resolveMfaContext(req);
        if (!ctx.user) return res.status(404).json({ error: 'Account not found' });

        if (isMfaMandatory({ isPlatformUser: ctx.isPlatform, role: ctx.role })) {
            return res.status(403).json({ error: 'MFA is mandatory for your role and cannot be disabled.' });
        }
        if (!ctx.user.mfa_enabled) {
            return res.json({ enabled: false });
        }
        if (!password) return res.status(400).json({ error: 'Password is required to disable MFA.' });

        // Re-verify the password (defence against session-cookie theft).
        const pwRow = (await ctx.db.query(`SELECT password FROM ${ctx.table} WHERE id = $1`, [ctx.user.id])).rows[0];
        if (!pwRow || !(await bcrypt.compare(password, pwRow.password))) {
            return res.status(401).json({ error: 'Password did not match.' });
        }

        // Require a current TOTP / recovery code too.
        let ok = false;
        if (code && /^\d{6}$/.test(String(code).replace(/\s+/g, ''))) {
            ok = verifyToken(decryptSecret(ctx.user.mfa_secret), code);
        }
        if (!ok && code) {
            const idx = await verifyRecoveryCode(code, ctx.user.mfa_recovery_codes || []);
            ok = idx >= 0;
        }
        if (!ok) return res.status(401).json({ error: 'A valid MFA code is required to disable MFA.' });

        await ctx.db.query(
            `UPDATE ${ctx.table}
                SET mfa_secret = NULL,
                    mfa_enabled = FALSE,
                    mfa_enrolled_at = NULL,
                    mfa_pending_secret = NULL,
                    mfa_recovery_codes = NULL
              WHERE id = $1`,
            [ctx.user.id]
        );

        res.json({ enabled: false });
    } catch (err) {
        logger.error({ err }, 'POST /mfa/disable error');
        res.status(500).json({ error: 'Failed to disable MFA' });
    }
});

// POST /recovery-codes/regenerate — issue a fresh set (invalidates old ones)
router.post('/recovery-codes/regenerate', async (req, res) => {
    try {
        const { code } = req.body || {};
        const ctx = await resolveMfaContext(req);
        if (!ctx.user) return res.status(404).json({ error: 'Account not found' });
        if (!ctx.user.mfa_enabled) {
            return res.status(400).json({ error: 'MFA is not enabled.' });
        }
        if (!code || !verifyToken(decryptSecret(ctx.user.mfa_secret), code)) {
            return res.status(401).json({ error: 'A valid authenticator code is required.' });
        }

        const { plaintext, hashes } = await generateRecoveryCodes();
        await ctx.db.query(
            `UPDATE ${ctx.table} SET mfa_recovery_codes = $1 WHERE id = $2`,
            [JSON.stringify(hashes), ctx.user.id]
        );

        if (ctx.isPlatform) logPlatformAction(req, 'mfa_recovery_codes_regenerated', 'platform_user', ctx.user.id, {}, req.tenantId || null);

        res.json({ recovery_codes: plaintext });
    } catch (err) {
        logger.error({ err }, 'POST /mfa/recovery-codes/regenerate error');
        res.status(500).json({ error: 'Failed to regenerate recovery codes' });
    }
});

module.exports = router;