const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { query, transaction } = require('../db');
const { validatePassword, validateUsername } = require('../utils/password');
const { logger } = require('../utils/logger');
const { getTransporter, sendMail } = require('../utils/mailer');

const router = express.Router();

const isProduction = process.env.NODE_ENV === 'production';
const useSecureCookie = isProduction && process.env.USE_HTTPS === 'true';

function cookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
    };
}

// Registration mode (public — no auth needed)
router.get('/registration-mode', async (req, res) => {
    try {
        const row = await query("SELECT value FROM app_settings WHERE key = 'registration_mode'");
        res.json({ mode: row.rows[0]?.value || 'open' });
    } catch (err) {
        logger.error({ err }, 'GET /registration-mode error');
        res.status(500).json({ error: 'Failed to fetch registration mode' });
    }
});

// Register
router.post('/register', async (req, res) => {
    try {
        const { username, password, full_name, email, invite_code } = req.body;
        if (!username || !password || !full_name || !email) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const regMode = await query("SELECT value FROM app_settings WHERE key = 'registration_mode'");
        const mode = regMode.rows[0]?.value || 'open';
        if (mode === 'closed') {
            return res.status(403).json({ error: 'Registration is currently closed. Contact an administrator.' });
        }

        let inviteRow = null;
        if (mode === 'invite_only') {
            if (!invite_code) {
                return res.status(400).json({ error: 'An invite code is required to register.' });
            }
            const invRes = await query(
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

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });
        const usernameError = validateUsername(username);
        if (usernameError) return res.status(400).json({ error: usernameError });

        const existingUser = await query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingUser.rows[0]) return res.status(400).json({ error: 'Username already taken' });
        const existingEmail = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingEmail.rows[0]) return res.status(400).json({ error: 'Email already registered' });

        const hash = await bcrypt.hash(password, 10);
        const assignedOrgId = inviteRow?.org_id || null;
        const assignedRole = inviteRow?.role || 'employee';

        const result = await transaction(async (client) => {
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
            const ins = await client.query(
                'INSERT INTO users (username, password, full_name, email, org_id, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
                [username, hash, full_name, email, assignedOrgId, assignedRole],
            );
            return ins.rows[0];
        });

        const token = jwt.sign(
            { id: result.id, username, tv: 0 },
            process.env.JWT_SECRET,
            { expiresIn: '24h' },
        );
        res.cookie('token', token, cookieOptions());
        res.json({ user: { id: result.id, username, full_name, email, avatar: null, role: assignedRole, org_id: assignedOrgId } });
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

        const userRes = await query('SELECT * FROM users WHERE username = $1', [username]);
        const user = userRes.rows[0];

        // Check account lockout
        if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
            const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
            return res.status(423).json({ error: `Account locked. Try again in ${mins} minute(s).` });
        }

        const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        if (!user || !(await bcrypt.compare(password, user ? user.password : DUMMY_HASH))) {
            // Increment failed attempts
            if (user) {
                const attempts = (user.failed_login_attempts || 0) + 1;
                if (attempts >= 5) {
                    await query(
                        "UPDATE users SET failed_login_attempts = $1, locked_until = NOW() + INTERVAL '15 minutes' WHERE id = $2",
                        [attempts, user.id],
                    );
                    return res.status(423).json({ error: 'Account locked for 15 minutes due to too many failed attempts.' });
                }
                await query('UPDATE users SET failed_login_attempts = $1 WHERE id = $2', [attempts, user.id]);
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (!user.is_active) {
            return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.' });
        }

        // Reset failed attempts on successful login
        if (user.failed_login_attempts > 0) {
            await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, tv: user.token_version || 0 },
            process.env.JWT_SECRET,
            { expiresIn: '24h' },
        );
        res.cookie('token', token, cookieOptions());

        const reportsRes = await query(
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

        const userRes = await query('SELECT id, username, email FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user) return res.json({ message: 'If that email is registered, a reset link has been sent.' });

        await query('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE', [user.id]);

        const resetToken = crypto.randomBytes(48).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        await query(
            'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
            [user.id, tokenHash, expiresAt],
        );

        const clientOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
        const resetLink = `${clientOrigin}/reset-password/${resetToken}`;

        const mailer = getTransporter();
        if (mailer) {
            sendMail({
                to: user.email,
                subject: 'WorkPulse — Password Reset',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
                        <h2 style="color:#6366f1;">Reset Your Password</h2>
                        <p>Hi <strong>${user.username}</strong>,</p>
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
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if (password.length > 72) return res.status(400).json({ error: 'Password must be 72 characters or less' });
        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ error: pwError });

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const rowRes = await query(
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
        await query(
            'UPDATE users SET password = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
            [hash, row.user_id],
        );
        await query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [row.id]);

        res.json({ message: 'Password has been reset successfully. You can now sign in.' });
    } catch (err) {
        req.log.error({ err }, 'Reset password error');
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: useSecureCookie, sameSite: 'lax' });
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;