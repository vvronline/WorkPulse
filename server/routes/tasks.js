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

function getLocalYesterday(req) {
    const offsetMin = parseInt(req.headers['x-timezone-offset']);
    if (!isNaN(offsetMin)) {
        const now = new Date(Date.now() - offsetMin * 60000 - 86400000);
        return now.toISOString().slice(0, 10);
    }
    return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

// Get tasks for a specific date
router.get('/', auth, (req, res) => {
    const { date } = req.query;
    const targetDate = date || getLocalToday(req);

    const tasks = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ? AND date = ?
        ORDER BY
            CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
            CASE status WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 WHEN 'pending' THEN 3 WHEN 'done' THEN 4 END,
            created_at ASC
    `).all(req.userId, targetDate);

    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'done').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;

    res.json({ tasks, stats: { total, done, inProgress, percent: total > 0 ? Math.round((done / total) * 100) : 0 } });
});

// Add a task
router.post('/', auth, (req, res) => {
    const { title, description, priority, date } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Task title is required' });
    }

    const targetDate = date || getLocalToday(req);
    const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

    const result = db.prepare(
        'INSERT INTO tasks (user_id, date, title, description, priority) VALUES (?, ?, ?, ?, ?)'
    ).run(req.userId, targetDate, title.trim(), description?.trim() || null, validPriority);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.json(task);
});

// Update task status
router.patch('/:id/status', auth, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'in_progress', 'in_review', 'done'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const completedAt = status === 'done' ? new Date().toISOString() : null;
    db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    res.json(updated);
});

// Update task details
router.put('/:id', auth, (req, res) => {
    const { id } = req.params;
    const { title, description, priority } = req.body;

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const newTitle = title?.trim() || task.title;
    const newDesc = description !== undefined ? (description?.trim() || null) : task.description;
    const newPriority = ['low', 'medium', 'high'].includes(priority) ? priority : task.priority;

    db.prepare('UPDATE tasks SET title = ?, description = ?, priority = ? WHERE id = ?')
        .run(newTitle, newDesc, newPriority, id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    res.json(updated);
});

// Delete a task
router.delete('/:id', auth, (req, res) => {
    const { id } = req.params;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.userId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    res.json({ message: 'Task deleted' });
});

// Copy recent incomplete tasks to today (looks back up to 7 days to cover weekends/holidays)
router.post('/carry-forward', auth, (req, res) => {
    const today = getLocalToday(req);

    // Find the most recent previous day that has tasks (up to 7 days back)
    const lastTaskDay = db.prepare(`
        SELECT date FROM tasks
        WHERE user_id = ? AND date < ? AND date >= date(?, '-7 days')
        ORDER BY date DESC LIMIT 1
    `).get(req.userId, today, today);

    if (!lastTaskDay) {
        return res.json({ message: 'No tasks to carry forward', carried: 0 });
    }

    const incomplete = db.prepare(`
        SELECT title, description, priority FROM tasks
        WHERE user_id = ? AND date = ? AND status != 'done'
    `).all(req.userId, lastTaskDay.date);

    if (incomplete.length === 0) {
        return res.json({ message: 'No tasks to carry forward', carried: 0 });
    }

    const insert = db.prepare(
        'INSERT INTO tasks (user_id, date, title, description, priority) VALUES (?, ?, ?, ?, ?)'
    );
    const tx = db.transaction(() => {
        let carried = 0;
        for (const t of incomplete) {
            // Skip if a task with same title already exists today
            const exists = db.prepare('SELECT 1 FROM tasks WHERE user_id = ? AND date = ? AND title = ?')
                .get(req.userId, today, t.title);
            if (!exists) {
                insert.run(req.userId, today, t.title, t.description, t.priority);
                carried++;
            }
        }
        return carried;
    });

    const carried = tx();
    res.json({ message: `${carried} task(s) carried forward`, carried });
});

module.exports = router;
