const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db = require('../db');

const router = express.Router();

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

// Register
router.post('/register', async (req, res) => {
    const { username, password, full_name, email } = req.body;
    if (!username || !password || !full_name || !email) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
    const result = db.prepare('INSERT INTO users (username, password, full_name, email) VALUES (?, ?, ?, ?)').run(username, hash, full_name, email);

    const token = jwt.sign({ id: result.lastInsertRowid, username, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
        httpOnly: true,
        // When frontend and backend map to different IPs/ports, SameSite 'None' is required for cross-origin cookies.
        // SameSite 'None' explicitly requires 'secure: true' in modern browsers
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    res.json({ user: { id: result.lastInsertRowid, username, full_name, email, avatar: null } });
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

    const token = jwt.sign({ id: user.id, username: user.username, tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    res.json({ user: { id: user.id, username: user.username, full_name: user.full_name, email: user.email || null, avatar: user.avatar || null } });
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

    // Generate a secure token (48 bytes → 64 chars hex)
    const resetToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, resetToken, expiresAt);

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

    const row = db.prepare(`
        SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.username
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = ?
    `).get(token);

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
        secure: true,
        sameSite: 'none'
    });
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;
