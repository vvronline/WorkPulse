const express = require('express');
const auth = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { handleMention } = require('../utils/collaboration');

const router = express.Router();
const { requireTenant } = require('../middleware/tenant');
router.use(auth, requireTenant);

const MAX_HISTORY = 50;

async function getNotebook(userId, db) {
    const row = (await db.query('SELECT data FROM notebooks WHERE user_id = $1', [userId])).rows[0];
    return row ? JSON.parse(row.data) : null;
}

async function writeHistory(userId, page, client) {
    const q = client ? client.query.bind(client) : query;
    await q(
        'INSERT INTO notebook_history (user_id, page_id, page_title, content) VALUES ($1, $2, $3, $4)',
        [userId, page.id, page.title || 'Untitled', page.content || '']
    );
    const oldest = (await q(
        'SELECT id FROM notebook_history WHERE user_id = $1 AND page_id = $2 ORDER BY saved_at DESC LIMIT ALL OFFSET $3',
        [userId, page.id, MAX_HISTORY]
    )).rows;
    if (oldest.length > 0) {
        const ids = oldest.map(r => r.id);
        await q('DELETE FROM notebook_history WHERE id = ANY($1)', [ids]);
    }
}

router.get('/', async (req, res) => {
    try {
        const row = (await req.db.query('SELECT data, updated_at FROM notebooks WHERE user_id = $1', [req.userId])).rows[0];
        if (!row) return res.json({ data: null });
        res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes error');
        res.status(500).json({ error: 'Failed to fetch notes' });
    }
});

router.put('/', async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) return res.status(400).json({ error: 'No data provided' });

        // Prevent oversized notebook payloads
        const serialized = JSON.stringify(data);
        if (serialized.length > 2 * 1024 * 1024) {
            return res.status(400).json({ error: 'Notebook data too large (max 2 MB)' });
        }

        const old = await getNotebook(req.userId, req.db);
        const oldMap = {};
        if (old?.pages) old.pages.forEach(p => { oldMap[p.id] = p; });

        const newPages = data.pages || [];
        await req.db.transaction(async (client) => {
            for (const page of newPages) {
                const prev = oldMap[page.id];
                if (!prev) continue;
                if (prev.content !== page.content || prev.title !== page.title) {
                    await writeHistory(req.userId, prev, client);
                }
            }
            await client.query(
                `INSERT INTO notebooks (user_id, data, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT(user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
                [req.userId, JSON.stringify(data)]
            );
        });

        res.json({ ok: true });
    } catch (e) {
        req.log.error({ err: e }, 'PUT /notes error');
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

router.get('/history/:pageId', async (req, res) => {
    try {
        const rows = (await req.db.query(
            'SELECT id, page_title, saved_at FROM notebook_history WHERE user_id = $1 AND page_id = $2 ORDER BY saved_at DESC LIMIT 50',
            [req.userId, req.params.pageId]
        )).rows;
        res.json({ history: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/history error');
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

router.get('/history/snapshot/:id', async (req, res) => {
    try {
        const row = (await req.db.query(
            'SELECT id, page_id, page_title, content, saved_at FROM notebook_history WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        )).rows[0];
        if (!row) return res.status(404).json({ error: 'Snapshot not found' });
        res.json({ snapshot: row });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/history/snapshot error');
        res.status(500).json({ error: 'Failed to fetch snapshot' });
    }
});

// @mention notification endpoint
router.post('/mention', async (req, res) => {
    try {
        const { mentionedUserId, pageId, pageTitle } = req.body;
        if (!mentionedUserId || !pageId) {
            return res.status(400).json({ error: 'mentionedUserId and pageId are required' });
        }
        const uid = parseInt(mentionedUserId, 10);
        if (!uid || uid <= 0) return res.status(400).json({ error: 'Invalid user ID' });

        await handleMention(req.db, req.tenantId, req.userId, uid, pageId, pageTitle || 'Untitled');
        res.json({ ok: true });
    } catch (e) {
        req.log.error({ err: e }, 'POST /notes/mention error');
        res.status(500).json({ error: 'Failed to send mention notification' });
    }
});

// Get mentionable users (same org)
router.get('/mentionable-users', async (req, res) => {
    try {
        const user = (await req.db.query('SELECT org_id FROM users WHERE id = $1', [req.userId])).rows[0];
        if (!user?.org_id) return res.json({ users: [] });

        const rows = (await req.db.query(
            `SELECT id, full_name, avatar, username FROM users
             WHERE org_id = $1 AND is_active = TRUE AND id != $2
             ORDER BY full_name`,
            [user.org_id, req.userId]
        )).rows;
        res.json({ users: rows });
    } catch (e) {
        req.log.error({ err: e }, 'GET /notes/mentionable-users error');
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

module.exports = router;