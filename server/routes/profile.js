const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const redis = require('../redis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { masterQuery } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { validatePassword, validateUsername, BCRYPT_ROUNDS } = require('../utils/password');
const { logger } = require('../utils/logger');
const { requireTenant } = require('../middleware/tenant');
const { getUploadDir, getUploadUrl, UPLOADS_ROOT } = require('../utils/uploadPath');
const { isValidDescriptor, FACE_DESCRIPTOR_LENGTH } = require('../utils/face');

const router = express.Router();
router.use(requireTenant);

const { cookieOptions } = require('../utils/cookie');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            // Per-tenant layout: uploads/tenant_<tid>/org_<oid>/avatars/
            // The route's middleware chain (auth → loadUserContext → upload)
            // guarantees req.tenantId and req.userOrgId are set here.
            const dir = getUploadDir(req.tenantId, req.userOrgId, 'avatars');
            cb(null, dir);
        } catch (err) {
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        // Use MIME type to determine extension, not the user-provided filename
        const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
        const ext = MIME_EXT[file.mimetype] || '.jpg';
        cb(null, `user_${req.userId}_${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowedMimes.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files (jpg, png, webp, gif) are allowed'));
    }
});

const uploadsRoot = UPLOADS_ROOT;

function safeAvatarPath(avatarRelative) {
    if (!avatarRelative || avatarRelative.includes('..') || avatarRelative.includes('\0')) {
        throw new Error('Invalid avatar path');
    }
    // Strip leading slash so we resolve relative to server/, where avatar
    // URLs are stored as "/uploads/tenant_X/org_Y/avatars/foo.png".
    const stripped = avatarRelative.replace(/^\/+/, '');
    const resolved = path.resolve(__dirname, '..', stripped);
    const normalizedRoot = fs.realpathSync(uploadsRoot);
    if (!resolved.startsWith(normalizedRoot)) {
        throw new Error('Invalid avatar path');
    }
    return resolved;
}

router.post('/avatar', auth, loadUserContext, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const avatarPath = getUploadUrl(req.tenantId, req.userOrgId, 'avatars', req.file.filename);

    let oldAvatarPath = null;
    await req.db.transaction(async (client) => {
        const user = (await client.query('SELECT avatar FROM users WHERE id = $1', [req.userId])).rows[0];
        await client.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarPath, req.userId]);
        oldAvatarPath = user?.avatar || null;
    });

    if (oldAvatarPath) {
        try { await fsPromises.unlink(safeAvatarPath(oldAvatarPath)); } catch { }
    }

    res.json({ avatar: avatarPath });
});

router.delete('/avatar', auth, async (req, res) => {
    const user = (await req.db.query('SELECT avatar FROM users WHERE id = $1', [req.userId])).rows[0];
    if (user?.avatar) {
        try { await fsPromises.unlink(safeAvatarPath(user.avatar)); } catch { }
    }
    await req.db.query('UPDATE users SET avatar = NULL WHERE id = $1', [req.userId]);
    res.json({ avatar: null });
});

router.get('/', auth, async (req, res) => {
    try {
        // Fetch platform admin's name for impersonation banner
        let impersonatedByName = null;
        if (req.isImpersonated && req.impersonatedBy) {
            const adminRow = (await masterQuery('SELECT full_name, username FROM platform_users WHERE id = $1', [req.impersonatedBy])).rows[0];
            impersonatedByName = adminRow?.full_name || adminRow?.username || null;
        }

        // Virtual impersonation: platform admin in a tenant with no users
        if (req.isImpersonated && req.userId === 0) {
            return res.json({
                id: 0,
                username: req.username,
                full_name: 'Platform Admin',
                email: null,
                avatar: null,
                role: 'platform_admin',
                org_id: null,
                team_id: null,
                department_id: null,
                must_change_password: false,
                has_reports: false,
                impersonated: true,
                impersonated_by_name: impersonatedByName,
                impersonated_tenant_name: req.impersonatedTenantName || null,
                tenant_id: req.tenantId,
            });
        }

        // Try to fetch notification_prefs alongside the rest of the profile.
        // If the column hasn't been added on this tenant DB yet (older
        // deployments before the migration runs), fall back to the same
        // query without it so the app keeps working.
        let user;
        try {
            user = (await req.db.query(`
                SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role, u.org_id, u.team_id, u.department_id, u.must_change_password,
                       u.notification_prefs,
                       t.name as team_name
                FROM users u LEFT JOIN teams t ON u.team_id = t.id WHERE u.id = $1
            `, [req.userId])).rows[0];
        } catch (colErr) {
            req.log.warn({ err: colErr }, 'GET /profile: notification_prefs column missing, falling back');
            user = (await req.db.query(`
                SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.role, u.org_id, u.team_id, u.department_id, u.must_change_password,
                       t.name as team_name
                FROM users u LEFT JOIN teams t ON u.team_id = t.id WHERE u.id = $1
            `, [req.userId])).rows[0];
        }
        if (!user) return res.status(404).json({ error: 'User not found' });
        user.must_change_password = !!user.must_change_password;
        // Platform admins with tenant context should retain platform_admin role for the UI
        if (req.isPlatformUser) user.role = 'platform_admin';
        const hasReports = (await req.db.query('SELECT 1 FROM users WHERE manager_id = $1 AND is_active = TRUE LIMIT 1', [req.userId])).rows[0];
        user.has_reports = !!hasReports;
        // Include impersonation info so the UI can show a banner
        if (req.isImpersonated) {
            user.impersonated = true;
            user.impersonated_by_name = impersonatedByName;
            user.impersonated_tenant_name = req.impersonatedTenantName || null;
            user.tenant_id = req.tenantId || null;
        }
        if (req.tenant) {
            const { getEffectiveFeatures } = require('../utils/planCatalog');
            user.tenant_features = getEffectiveFeatures(req.tenant.plan, req.tenant.features);
            user.tenant_plan = req.tenant.plan || 'standard';
        }
        res.json(user);
    } catch (err) {
        req.log.error({ err }, 'GET /profile error');
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

router.put('/', auth, async (req, res) => {
    try {
        const { full_name, username } = req.body;
        if (!full_name || !username) return res.status(400).json({ error: 'Name and username are required' });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });
        if (full_name.length > 100) return res.status(400).json({ error: 'Full name must be 100 characters or less' });

        const existing = (await req.db.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.userId])).rows[0];
        if (existing) return res.status(400).json({ error: 'Username already taken' });

        // Check global uniqueness in user_directory (another tenant may own this username)
        if (req.tenantId) {
            const dirCheck = await masterQuery(
                'SELECT 1 FROM user_directory WHERE username = $1 AND user_id != $2',
                [username.toLowerCase(), req.userId]
            );
            if (dirCheck.rows[0]) return res.status(400).json({ error: 'Username already taken' });
        }

        await req.db.query('UPDATE users SET full_name = $1, username = $2 WHERE id = $3', [full_name.trim(), username.trim(), req.userId]);
        // Sync username in master user_directory so login resolution works with new username
        if (req.tenantId) {
            await masterQuery(
                'UPDATE user_directory SET username = $1 WHERE tenant_id = $2 AND user_id = $3',
                [username.toLowerCase(), req.tenantId, req.userId]
            );
        }
        const updated = (await req.db.query('SELECT id, username, full_name, email, avatar FROM users WHERE id = $1', [req.userId])).rows[0];
        res.json(updated);
    } catch (err) {
        req.log.error({ err }, 'PUT /profile error');
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

router.put('/email', auth, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

        const existing = (await req.db.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.userId])).rows[0];
        if (existing) return res.status(400).json({ error: 'Email already in use' });

        // Check global uniqueness in user_directory (another tenant may own this email)
        if (req.tenantId) {
            const dirCheck = await masterQuery(
                'SELECT 1 FROM user_directory WHERE email = $1 AND user_id != $2',
                [email.toLowerCase(), req.userId]
            );
            if (dirCheck.rows[0]) return res.status(400).json({ error: 'Email already in use' });
        }

        const oldUser = (await req.db.query('SELECT email FROM users WHERE id = $1', [req.userId])).rows[0];
        await req.db.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.userId]);
        // Sync email in master user_directory so login resolution works with new email
        if (req.tenantId && oldUser?.email) {
            await masterQuery(
                'UPDATE user_directory SET email = $1 WHERE tenant_id = $2 AND user_id = $3',
                [email.toLowerCase(), req.tenantId, req.userId]
            );
        }
        res.json({ email });
    } catch (err) {
        req.log.error({ err }, 'PUT /profile/email error');
        res.status(500).json({ error: 'Failed to update email' });
    }
});

router.put('/password', auth, loadUserContext, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) return res.status(400).json({ error: 'Both current and new password are required' });
        if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
        if (new_password.length > 72) return res.status(400).json({ error: 'New password must be 72 characters or less' });
        const pwError = await validatePassword(new_password);
        if (pwError) return res.status(400).json({ error: pwError });

        const user = (await req.db.query('SELECT password FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!(await bcrypt.compare(current_password, user.password))) return res.status(400).json({ error: 'Current password is incorrect' });

        const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
        await req.db.query('UPDATE users SET password = $1, token_version = COALESCE(token_version, 0) + 1, must_change_password = FALSE WHERE id = $2', [hash, req.userId]);
        await redis.invalidateTokenVersion(req.tenantId, req.userId);
        // Clear other sessions, keep the current one
        if (req.sessionId) {
            await req.db.query('DELETE FROM user_sessions WHERE user_id = $1 AND id != $2', [req.userId, req.sessionId]);
        } else {
            await req.db.query('DELETE FROM user_sessions WHERE user_id = $1', [req.userId]);
        }
        await redis.invalidateUserSessions(req.tenantId, req.userId);
        const updated = (await req.db.query('SELECT token_version FROM users WHERE id = $1', [req.userId])).rows[0];
        const tokenPayload = { id: req.userId, username: req.username, tv: updated.token_version || 0, sid: req.sessionId };
        if (req.tenantId) tokenPayload.tenant_id = req.tenantId;
        if (req.isPlatformUser) tokenPayload.platform = true;
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.cookie('token', token, cookieOptions(req));
        logAction(req, 'change_password', 'user', req.userId, {});
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        req.log.error({ err }, 'PUT /profile/password error');
        res.status(500).json({ error: 'Failed to change password' });
    }
});

/* ─── Notification & sound preferences ───────────────────────────────── */

// Allowed preset IDs per category. Anything else is rejected so the JSONB
// blob can never grow unbounded from client-supplied junk.
const ALLOWED_PRESETS = {
    ringtone: ['classic', 'calm', 'dynamic', 'urgent', 'boop', 'marimba', 'none'],
    outgoingTone: ['ringback', 'pulse', 'soft', 'none'],
    messageTone: ['ding', 'pop', 'chime', 'knock', 'subtle', 'none'],
    mentionTone: ['mention', 'chime', 'urgent', 'none'],
    reactionTone: ['subtle', 'pop', 'none'],
};

function validateNotificationPrefs(input) {
    if (!input || typeof input !== 'object') return { error: 'Invalid payload' };
    const out = { v: 1 };

    const clampVol = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.min(1, n));
    };

    const idFields = ['ringtone', 'outgoingTone', 'messageTone', 'mentionTone', 'reactionTone'];
    for (const f of idFields) {
        if (input[f] !== undefined) {
            if (typeof input[f] !== 'string' || !ALLOWED_PRESETS[f].includes(input[f])) {
                return { error: `Invalid value for ${f}` };
            }
            out[f] = input[f];
        }
    }

    const volFields = ['ringtoneVolume', 'outgoingVolume', 'messageVolume', 'mentionVolume', 'reactionVolume'];
    for (const f of volFields) {
        if (input[f] !== undefined) {
            const v = clampVol(input[f]);
            if (v === null) return { error: `Invalid value for ${f}` };
            out[f] = v;
        }
    }

    const boolFields = ['muteAll', 'playWhenFocused', 'playOnSend'];
    for (const f of boolFields) {
        if (input[f] !== undefined) {
            if (typeof input[f] !== 'boolean') return { error: `Invalid value for ${f}` };
            out[f] = input[f];
        }
    }

    return { prefs: out };
}

// One-time per-process flag: have we already verified the column exists
// on this tenant DB? Prevents running the ALTER on every request.
const _notificationPrefsColumnReady = new WeakSet();

async function ensureNotificationPrefsColumn(req) {
    if (_notificationPrefsColumnReady.has(req.db)) return;
    try {
        await req.db.query(
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`
        );
        _notificationPrefsColumnReady.add(req.db);
    } catch (err) {
        // Don't block the request — log and let the SELECT/UPDATE fall back.
        req.log?.warn({ err }, 'ensureNotificationPrefsColumn failed');
    }
}

router.get('/notification-prefs', auth, async (req, res) => {
    try {
        await ensureNotificationPrefsColumn(req);
        const row = (await req.db.query(
            'SELECT notification_prefs FROM users WHERE id = $1',
            [req.userId]
        )).rows[0];
        res.json(row?.notification_prefs || {});
    } catch (err) {
        // If the column is missing on a tenant DB that hasn't been migrated
        // yet, fall back to empty object so the client uses its defaults
        // rather than surfacing a 500.
        req.log.warn({ err }, 'GET /profile/notification-prefs: returning defaults');
        res.json({});
    }
});

router.put('/notification-prefs', auth, async (req, res) => {
    try {
        const { prefs, error } = validateNotificationPrefs(req.body);
        if (error) return res.status(400).json({ error });

        await ensureNotificationPrefsColumn(req);

        // Merge with existing prefs so partial updates from the client do not
        // wipe out unrelated keys (e.g. saving just the volume slider).
        const existing = (await req.db.query(
            'SELECT notification_prefs FROM users WHERE id = $1',
            [req.userId]
        )).rows[0]?.notification_prefs || {};
        const merged = { ...existing, ...prefs, v: 1 };

        await req.db.query(
            'UPDATE users SET notification_prefs = $1::jsonb WHERE id = $2',
            [JSON.stringify(merged), req.userId]
        );
        res.json(merged);
    } catch (err) {
        req.log.error({ err }, 'PUT /profile/notification-prefs error');
        res.status(500).json({ error: 'Failed to save notification preferences' });
    }
});

router.delete('/', auth, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });

        const user = (await req.db.query('SELECT password, avatar, role, org_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Incorrect password' });

        // Prevent sole admin from deleting their account
        if (['super_admin', 'hr_admin'].includes(user.role) && user.org_id) {
            const adminCount = (await req.db.query(
                "SELECT COUNT(*) FROM users WHERE org_id = $1 AND role IN ('super_admin', 'hr_admin') AND id != $2 AND is_active = TRUE",
                [user.org_id, req.userId]
            )).rows[0].count;
            if (parseInt(adminCount) === 0) {
                return res.status(400).json({ error: 'Cannot delete account: you are the only admin in your organization. Transfer admin role first.' });
            }
        }

        if (user.avatar) {
            try { await fsPromises.unlink(safeAvatarPath(user.avatar)); } catch { }
        }

        await req.db.transaction(async (client) => {
            await client.query('DELETE FROM time_entries WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM leaves WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM leave_balances WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM task_comments WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM tasks WHERE user_id = $1 OR assigned_to = $1', [req.userId]);
            await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM approval_requests WHERE requester_id = $1', [req.userId]);
            await client.query('DELETE FROM notifications WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM user_sessions WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM starred_messages WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM message_reads WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM message_reactions WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM conversation_participants WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM meeting_participants WHERE user_id = $1', [req.userId]);
            try { await client.query('DELETE FROM audit_logs WHERE actor_id = $1', [req.userId]); } catch { }
            await client.query('UPDATE users SET manager_id = NULL WHERE manager_id = $1', [req.userId]);
            await client.query('DELETE FROM users WHERE id = $1', [req.userId]);
        });

        // Clean up master user_directory entry
        if (req.tenantId) {
            try {
                await masterQuery('DELETE FROM user_directory WHERE tenant_id = $1 AND user_id = $2', [req.tenantId, req.userId]);
            } catch { /* ignore if table doesn't exist */ }
        }

        res.clearCookie('token', { httpOnly: true, sameSite: 'strict', path: '/' });
        res.json({ message: 'Account deleted successfully' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /profile error');
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// Face enrollment for attendance verification.
//
// Face detection/extraction runs entirely in the user's browser via
// face-api.js. The browser captures a webcam frame, computes the 128-float
// descriptor (the FaceRecognitionNet embedding), and POSTs only that array
// — never the image — to /profile/face-enroll. The server stores it in
// users.face_descriptor (JSONB) and uses it later to compare against the
// descriptor sent at clock-in time.
//
// Endpoints:
//   GET    /profile/face-status   — { enrolled, enrolled_at }
//   POST   /profile/face-enroll   — body { descriptor: number[128] }
//   DELETE /profile/face-enroll   — clear enrollment (for re-enroll)
// ─────────────────────────────────────────────────────────────────────────

router.get('/face-status', auth, async (req, res) => {
    try {
        const row = (await req.db.query(
            'SELECT face_enrolled_at, (face_descriptor IS NOT NULL) AS enrolled FROM users WHERE id = $1',
            [req.userId]
        )).rows[0];
        res.json({
            enrolled: !!row?.enrolled,
            enrolled_at: row?.face_enrolled_at || null,
        });
    } catch (err) {
        req.log.error({ err }, 'GET /profile/face-status error');
        res.status(500).json({ error: 'Failed to fetch face enrollment status' });
    }
});

router.post('/face-enroll', auth, async (req, res) => {
    try {
        const { descriptor } = req.body || {};
        if (!isValidDescriptor(descriptor)) {
            return res.status(400).json({
                error: `Invalid face descriptor — expected an array of ${FACE_DESCRIPTOR_LENGTH} numbers`,
            });
        }
        // Store as a plain array (JSONB) so any client can read it back.
        const json = JSON.stringify(descriptor);
        await req.db.query(
            `UPDATE users SET face_descriptor = $1::jsonb, face_enrolled_at = NOW() WHERE id = $2`,
            [json, req.userId]
        );
        logAction(req, 'face_enroll', 'user', req.userId, { descriptor_length: descriptor.length });
        res.json({ message: 'Face enrolled successfully', enrolled: true, enrolled_at: new Date().toISOString() });
    } catch (err) {
        req.log.error({ err }, 'POST /profile/face-enroll error');
        res.status(500).json({ error: 'Failed to enroll face' });
    }
});

router.delete('/face-enroll', auth, async (req, res) => {
    try {
        await req.db.query(
            `UPDATE users SET face_descriptor = NULL, face_enrolled_at = NULL WHERE id = $1`,
            [req.userId]
        );
        logAction(req, 'face_unenroll', 'user', req.userId, {});
        res.json({ message: 'Face enrollment cleared', enrolled: false });
    } catch (err) {
        req.log.error({ err }, 'DELETE /profile/face-enroll error');
        res.status(500).json({ error: 'Failed to clear face enrollment' });
    }
});

module.exports = router;
