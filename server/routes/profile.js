const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only image files are allowed'));
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

module.exports = router;
