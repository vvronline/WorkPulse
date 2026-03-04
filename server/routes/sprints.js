const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole } = require('../middleware/rbac');

const router = express.Router();

// ─── Get sprints for user's team ───────────────────────────────────────
router.get('/', auth, loadUserContext, (req, res) => {
    try {
        if (!req.userTeamId) {
            return res.json({ sprints: [] });
        }

        const sprints = db.prepare(`
            SELECT * FROM sprints
            WHERE team_id = ?
            ORDER BY 
                CASE status WHEN 'active' THEN 1 WHEN 'planned' THEN 2 WHEN 'completed' THEN 3 END,
                start_date DESC
        `).all(req.userTeamId);

        res.json({ sprints });
    } catch (err) {
        console.error('Error fetching sprints:', err.message);
        res.status(500).json({ error: 'Failed to fetch sprints' });
    }
});

// ─── Get active sprint for team ────────────────────────────────────────
router.get('/active', auth, loadUserContext, (req, res) => {
    try {
        if (!req.userTeamId) {
            return res.json({ sprint: null });
        }

        const sprint = db.prepare(`
            SELECT * FROM sprints
            WHERE team_id = ? AND status = 'active'
            ORDER BY start_date DESC
            LIMIT 1
        `).get(req.userTeamId);

        res.json({ sprint: sprint || null });
    } catch (err) {
        console.error('Error fetching active sprint:', err.message);
        res.status(500).json({ error: 'Failed to fetch active sprint' });
    }
});

// ─── Create a new sprint ───────────────────────────────────────────────
router.post('/', auth, loadUserContext, (req, res) => {
    try {
        if (!req.userTeamId) {
            return res.status(403).json({ error: 'You must be assigned to a team to create sprints' });
        }

        const { name, start_date, end_date, goal } = req.body;

        if (!name || !start_date || !end_date) {
            return res.status(400).json({ error: 'Sprint name, start_date, and end_date are required' });
        }

        // Check for duplicate sprint name in team
        const existing = db.prepare('SELECT id FROM sprints WHERE team_id = ? AND name = ?').get(req.userTeamId, name);
        if (existing) {
            return res.status(400).json({ error: 'A sprint with this name already exists for your team' });
        }

        const result = db.prepare(`
            INSERT INTO sprints (team_id, name, start_date, end_date, goal, status)
            VALUES (?, ?, ?, ?, ?, 'planned')
        `).run(req.userTeamId, name, start_date, end_date, goal || null);

        const newSprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(result.lastInsertRowid);
        res.json({ sprint: newSprint });
    } catch (err) {
        console.error('Error creating sprint:', err.message);
        res.status(500).json({ error: 'Failed to create sprint' });
    }
});

// ─── Update sprint ─────────────────────────────────────────────────────
router.put('/:id', auth, loadUserContext, (req, res) => {
    try {
        const { id } = req.params;
        const { name, start_date, end_date, goal, status } = req.body;

        const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
        if (!sprint) {
            return res.status(404).json({ error: 'Sprint not found' });
        }

        if (sprint.team_id !== req.userTeamId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const updates = [];
        const params = [];

        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name);
        }
        if (start_date !== undefined) {
            updates.push('start_date = ?');
            params.push(start_date);
        }
        if (end_date !== undefined) {
            updates.push('end_date = ?');
            params.push(end_date);
        }
        if (goal !== undefined) {
            updates.push('goal = ?');
            params.push(goal);
        }
        if (status !== undefined && ['planned', 'active', 'completed'].includes(status)) {
            updates.push('status = ?');
            params.push(status);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        params.push(id);
        db.prepare(`UPDATE sprints SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        const updated = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
        res.json({ sprint: updated });
    } catch (err) {
        console.error('Error updating sprint:', err.message);
        res.status(500).json({ error: 'Failed to update sprint' });
    }
});

// ─── Delete sprint ─────────────────────────────────────────────────────
router.delete('/:id', auth, loadUserContext, (req, res) => {
    try {
        const { id } = req.params;

        const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
        if (!sprint) {
            return res.status(404).json({ error: 'Sprint not found' });
        }

        if (sprint.team_id !== req.userTeamId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Remove sprint from tasks first
        db.prepare('UPDATE tasks SET sprint_id = NULL WHERE sprint_id = ?').run(id);

        db.prepare('DELETE FROM sprints WHERE id = ?').run(id);
        res.json({ message: 'Sprint deleted successfully' });
    } catch (err) {
        console.error('Error deleting sprint:', err.message);
        res.status(500).json({ error: 'Failed to delete sprint' });
    }
});

// ─── Get tasks in sprint ───────────────────────────────────────────────
router.get('/:id/tasks', auth, loadUserContext, (req, res) => {
    try {
        const { id } = req.params;

        const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
        if (!sprint) {
            return res.status(404).json({ error: 'Sprint not found' });
        }

        if (sprint.team_id !== req.userTeamId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const tasks = db.prepare('SELECT * FROM tasks WHERE sprint_id = ? ORDER BY created_at ASC').all(id);
        res.json({ tasks });
    } catch (err) {
        console.error('Error fetching sprint tasks:', err.message);
        res.status(500).json({ error: 'Failed to fetch sprint tasks' });
    }
});

module.exports = router;
