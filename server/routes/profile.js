const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `user_${req.userId}_${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext) && allowedMimes.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files (jpg, png, webp, gif) are allowed'));
    }
});

// Upload avatar
router.post('/avatar', auth, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Delete old avatar file if exists
    const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.userId);
    if (user?.avatar) {
        const oldPath = path.join(__dirname, '..', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const avatarPath = `/uploads/avatars/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarPath, req.userId);

    res.json({ avatar: avatarPath });
});

// Remove avatar
router.delete('/avatar', auth, (req, res) => {
    const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.userId);
    if (user?.avatar) {
        const oldPath = path.join(__dirname, '..', user.avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.userId);
    res.json({ avatar: null });
});

// Get profile
router.get('/', auth, (req, res) => {
    const user = db.prepare('SELECT id, username, full_name, email, avatar FROM users WHERE id = ?').get(req.userId);
    res.json(user);
});

// Update name & username
router.put('/', auth, (req, res) => {
    const { full_name, username } = req.body;
    if (!full_name || !username) {
        return res.status(400).json({ error: 'Name and username are required' });
    }
    if (username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.userId);
    if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
    }
    db.prepare('UPDATE users SET full_name = ?, username = ? WHERE id = ?').run(full_name.trim(), username.trim(), req.userId);
    const updated = db.prepare('SELECT id, username, full_name, email, avatar FROM users WHERE id = ?').get(req.userId);
    res.json(updated);
});

// Update email
router.put('/email', auth, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.userId);
    if (existing) return res.status(400).json({ error: 'Email already in use' });

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.userId);
    res.json({ email });
});

// Change password
router.put('/password', auth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Both current and new password are required' });
    }
    if (new_password.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.userId);
    if (!(await bcrypt.compare(current_password, user.password))) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    db.prepare('UPDATE users SET password = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(hash, req.userId);
    // Return a fresh token so the current session stays valid after invalidation
    const updated = db.prepare('SELECT token_version FROM users WHERE id = ?').get(req.userId);
    const token = jwt.sign({ id: req.userId, username: req.username, tv: updated.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    res.json({ message: 'Password updated successfully' });
});

// Delete account
router.delete('/', auth, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });

    const user = db.prepare('SELECT password, avatar FROM users WHERE id = ?').get(req.userId);
    if (!(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'Incorrect password' });
    }

    // Delete avatar file if exists
    if (user.avatar) {
        const avatarPath = path.join(__dirname, '..', user.avatar);
        if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
    }

    // Delete all user data in a transaction
    const deleteAll = db.transaction(() => {
        db.prepare('DELETE FROM time_entries WHERE user_id = ?').run(req.userId);
        db.prepare('DELETE FROM leaves WHERE user_id = ?').run(req.userId);
        db.prepare('DELETE FROM tasks WHERE user_id = ?').run(req.userId);
        db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);
    });
    deleteAll();

    res.json({ message: 'Account deleted successfully' });
});

module.exports = router;
