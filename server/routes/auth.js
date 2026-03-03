const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db = require('../db');
const { validatePassword, validateUsername } = require('../utils/password');

const router = express.Router();

const isProduction = process.env.NODE_ENV === 'production';
// Only set Secure cookies when actually serving over HTTPS
const useSecureCookie = isProduction && process.env.USE_HTTPS === 'true';

// Cookie options helper
function cookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    };
}

// ---- Email transporter (lazy init) ----
let transporter = null;
function getTransporter() {
    if (!transporter && process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
    }
    return transporter;
}

// Registration mode (public — no auth needed)
router.get('/registration-mode', (req, res) => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'registration_mode'").get();
    res.json({ mode: row?.value || 'open' });
});

// Register
router.post('/register', async (req, res) => {
    const { username, password, full_name, email, invite_code } = req.body;
    if (!username || !password || !full_name || !email) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Check registration mode
    const regMode = db.prepare("SELECT value FROM app_settings WHERE key = 'registration_mode'").get();
    const mode = regMode?.value || 'open';
    if (mode === 'closed') {
        return res.status(403).json({ error: 'Registration is currently closed. Contact an administrator.' });
    }
    let inviteRow = null;
    if (mode === 'invite_only') {
        if (!invite_code) {
            return res.status(400).json({ error: 'An invite code is required to register.' });
        }
        inviteRow = db.prepare(`
            SELECT * FROM invite_codes WHERE code = ? AND is_active = 1
        `).get(invite_code);
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

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    const pwError = validatePassword(password);
    if (pwError) {
        return res.status(400).json({ error: pwError });
    }

    const usernameError = validateUsername(username);
    if (usernameError) {
        return res.status(400).json({ error: usernameError });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
    }

    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingEmail) {
        return res.status(400).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    // Determine org/role from invite code if applicable
    const assignedOrgId = inviteRow?.org_id || null;
    const assignedRole = inviteRow?.role || 'employee';

    // Wrap user creation + invite bump in a transaction to prevent race conditions
    const registerTx = db.transaction(() => {
        // Re-validate invite code inside the transaction to prevent concurrent over-use
        if (inviteRow) {
            const fresh = db.prepare('SELECT used_count, max_uses FROM invite_codes WHERE id = ? AND is_active = 1').get(inviteRow.id);
            if (!fresh || (fresh.max_uses > 0 && fresh.used_count >= fresh.max_uses)) {
                throw new Error('INVITE_EXHAUSTED');
            }
            db.prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?').run(inviteRow.id);
        }
        return db.prepare('INSERT INTO users (username, password, full_name, email, org_id, role) VALUES (?, ?, ?, ?, ?, ?)').run(username, hash, full_name, email, assignedOrgId, assignedRole);
    });

    let result;
    try {
        result = registerTx();
    } catch (err) {
        if (err.message === 'INVITE_EXHAUSTED') {
            return res.status(400).json({ error: 'This invite code has reached its usage limit.' });
        }
        throw err;
    }

    const token = jwt.sign({ id: result.lastInsertRowid, username, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, cookieOptions());
    res.json({ user: { id: result.lastInsertRowid, username, full_name, email, avatar: null, role: assignedRole, org_id: assignedOrgId } });
});

// Login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
        return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, cookieOptions());
    // Check if user has direct reports (to show manager view)
    const hasReports = db.prepare('SELECT 1 FROM users WHERE manager_id = ? AND is_active = 1 LIMIT 1').get(user.id);
    res.json({ user: { id: user.id, username: user.username, full_name: user.full_name, email: user.email || null, avatar: user.avatar || null, role: user.role || 'employee', org_id: user.org_id || null, has_reports: !!hasReports, must_change_password: !!user.must_change_password } });
});

// Forgot Password — send reset link via email
router.post('/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    const user = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(email);
    // Always return success to prevent email enumeration
    if (!user) {
        return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    // Invalidate any existing tokens for this user
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

    // Generate a secure token (48 bytes → 96 chars hex)
    const resetToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Store the hash — if the DB leaks, tokens are useless without the plaintext
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt);

    const clientOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
    const resetLink = `${clientOrigin}/reset-password/${resetToken}`;

    const mailer = getTransporter();
    if (mailer) {
        mailer.sendMail({
            from: process.env.SMTP_FROM || '"WorkPulse" <noreply@workpulse.app>',
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
        }).catch(err => console.error('Failed to send reset email:', err));
    } else {
        // No SMTP configured — log the link for dev/testing
        console.log(`\n🔑 Password reset link for ${user.username}: ${resetLink}\n`);
    }

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
});

// Reset Password — validate token and update password
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
        return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (password.length > 72) {
        return res.status(400).json({ error: 'Password must be 72 characters or less' });
    }
    const pwError = validatePassword(password);
    if (pwError) {
        return res.status(400).json({ error: pwError });
    }

    // Hash the incoming token to compare against the stored hash
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare(`
        SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.username
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = ?
    `).get(tokenHash);

    if (!row) {
        return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    if (row.used) {
        return res.status(400).json({ error: 'This reset link has already been used' });
    }
    if (new Date(row.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This reset link has expired' });
    }

    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(hash, row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);

    res.json({ message: 'Password has been reset successfully. You can now sign in.' });
});

// Logout — clear the HTTPOnly cookie
router.post('/logout', (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: 'lax'
    });
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;
