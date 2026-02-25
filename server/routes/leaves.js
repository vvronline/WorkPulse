const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

function getLocalToday(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000);
        return now.toISOString().slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
}

// Get leaves for a date range
router.get('/', auth, (req, res) => {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const toDate = to || getLocalToday(req);

    const leaves = db.prepare(`
        SELECT * FROM leaves
        WHERE user_id = ? AND date BETWEEN ? AND ?
        ORDER BY date DESC
    `).all(req.userId, fromDate, toDate);

    res.json(leaves);
});

// Add a leave
router.post('/', auth, (req, res) => {
    const { date, leave_type, reason } = req.body;

    if (!date || !leave_type) {
        return res.status(400).json({ error: 'Date and leave type are required' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const validTypes = ['sick', 'holiday', 'planned', 'personal', 'other'];
    if (!validTypes.includes(leave_type)) {
        return res.status(400).json({ error: 'Invalid leave type' });
    }

    // Check for duplicate
    const existing = db.prepare('SELECT id FROM leaves WHERE user_id = ? AND date = ?').get(req.userId, date);
    if (existing) {
        return res.status(400).json({ error: 'Leave already exists for this date' });
    }

    const result = db.prepare('INSERT INTO leaves (user_id, date, leave_type, reason) VALUES (?, ?, ?, ?)')
        .run(req.userId, date, leave_type, reason || null);

    res.json({ id: result.lastInsertRowid, message: 'Leave added successfully' });
});

// Add multiple leaves (batch)
router.post('/batch', auth, (req, res) => {
    const { dates, leave_type, reason } = req.body;

    if (!dates || !Array.isArray(dates) || dates.length === 0 || !leave_type) {
        return res.status(400).json({ error: 'Dates array and leave type are required' });
    }

    const insert = db.prepare('INSERT OR IGNORE INTO leaves (user_id, date, leave_type, reason) VALUES (?, ?, ?, ?)');
    const transaction = db.transaction(() => {
        let added = 0;
        for (const date of dates) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                const r = insert.run(req.userId, date, leave_type, reason || null);
                if (r.changes > 0) added++;
            }
        }
        return added;
    });

    try {
        const added = transaction();
        res.json({ message: `${added} leave(s) added successfully` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add leaves' });
    }
});

// Delete a leave
router.delete('/:id', auth, (req, res) => {
    const { id } = req.params;
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ? AND user_id = ?').get(id, req.userId);

    if (!leave) {
        return res.status(404).json({ error: 'Leave not found' });
    }

    db.prepare('DELETE FROM leaves WHERE id = ?').run(id);
    res.json({ message: 'Leave deleted successfully' });
});

// Get monthly leave summary
router.get('/summary', auth, (req, res) => {
    const { month, year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || new Date().getMonth() + 1;
    const mStr = String(m).padStart(2, '0');

    const leaves = db.prepare(`
        SELECT leave_type, COUNT(*) as count FROM leaves
        WHERE user_id = ? AND strftime('%Y-%m', date) = ?
        GROUP BY leave_type
    `).all(req.userId, `${y}-${mStr}`);

    // Count weekend days (Sat + Sun) in this month up to today (using client timezone)
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const localNow = new Date(Date.now() - offsetMin * 60000);
    const todayYear = localNow.getUTCFullYear();
    const todayMonth = localNow.getUTCMonth() + 1;
    const todayDate = localNow.getUTCDate();
    const lastDay = (y === todayYear && m === todayMonth)
        ? todayDate
        : new Date(Date.UTC(y, m, 0)).getUTCDate();
    let weekendDays = 0;
    for (let d = 1; d <= lastDay; d++) {
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (dow === 0 || dow === 6) weekendDays++;
    }

    const total = leaves.reduce((s, l) => s + l.count, 0);
    res.json({ month: m, year: y, total, weekendDays, breakdown: leaves });
});

module.exports = router;
