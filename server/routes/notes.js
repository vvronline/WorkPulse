const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /api/notes — fetch user's notebook
router.get('/', (req, res) => {
  try {
    const row = db.prepare('SELECT data, updated_at FROM notebooks WHERE user_id = ?').get(req.userId);
    if (!row) return res.json({ data: null });
    res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
  } catch (e) {
    console.error('GET /notes error:', e.message);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// PUT /api/notes — save user's notebook (entire JSON blob)
router.put('/', (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'No data provided' });
    const json = JSON.stringify(data);
    db.prepare(`
      INSERT INTO notebooks (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
    `).run(req.userId, json);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /notes error:', e.message);
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

module.exports = router;
