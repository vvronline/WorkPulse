const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const MAX_HISTORY = 50; // max versions kept per page

// ── helpers ──────────────────────────────────────────────────────────────────

function getNotebook(userId) {
    const row = db.prepare('SELECT data FROM notebooks WHERE user_id = ?').get(userId);
    return row ? JSON.parse(row.data) : null;
}

function writeHistory(userId, page) {
    db.prepare(`
    INSERT INTO notebook_history (user_id, page_id, page_title, content)
    VALUES (?, ?, ?, ?)
  `).run(userId, page.id, page.title || 'Untitled', page.content || '');

    // Prune to MAX_HISTORY versions
    const oldest = db.prepare(`
    SELECT id FROM notebook_history
    WHERE user_id = ? AND page_id = ?
    ORDER BY saved_at DESC
    LIMIT -1 OFFSET ?
  `).all(userId, page.id, MAX_HISTORY);

    if (oldest.length > 0) {
        const ids = oldest.map(r => r.id).join(',');
        db.exec(`DELETE FROM notebook_history WHERE id IN (${ids})`);
    }
}

// ── GET /api/notes ────────────────────────────────────────────────────────────
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

// ── PUT /api/notes ────────────────────────────────────────────────────────────
router.put('/', (req, res) => {
    try {
        const { data } = req.body;
        if (!data) return res.status(400).json({ error: 'No data provided' });

        // Detect changed pages and snapshot them before overwriting
        const old = getNotebook(req.userId);
        const oldMap = {};
        if (old?.pages) old.pages.forEach(p => { oldMap[p.id] = p; });

        const newPages = data.pages || [];
        db.transaction(() => {
            for (const page of newPages) {
                const prev = oldMap[page.id];
                if (!prev) continue; // brand-new page — no history yet
                const contentChanged = prev.content !== page.content;
                const titleChanged = prev.title !== page.title;
                if (contentChanged || titleChanged) {
                    // Snapshot the OLD version before it's overwritten
                    writeHistory(req.userId, prev);
                }
            }
            db.prepare(`
        INSERT INTO notebooks (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
      `).run(req.userId, JSON.stringify(data));
        })();

        res.json({ ok: true });
    } catch (e) {
        console.error('PUT /notes error:', e.message);
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

// ── GET /api/notes/history/:pageId  — list versions for a page ────────────────
router.get('/history/:pageId', (req, res) => {
    try {
        const rows = db.prepare(`
      SELECT id, page_title, saved_at
      FROM notebook_history
      WHERE user_id = ? AND page_id = ?
      ORDER BY saved_at DESC
      LIMIT 50
    `).all(req.userId, req.params.pageId);
        res.json({ history: rows });
    } catch (e) {
        console.error('GET /notes/history error:', e.message);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// ── GET /api/notes/history/snapshot/:id  — get full snapshot content ──────────
router.get('/history/snapshot/:id', (req, res) => {
    try {
        const row = db.prepare(`
      SELECT id, page_id, page_title, content, saved_at
      FROM notebook_history
      WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.userId);
        if (!row) return res.status(404).json({ error: 'Snapshot not found' });
        res.json({ snapshot: row });
    } catch (e) {
        console.error('GET /notes/history/snapshot error:', e.message);
        res.status(500).json({ error: 'Failed to fetch snapshot' });
    }
});

module.exports = router;

