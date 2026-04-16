const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole } = require('../middleware/rbac');
const { logger } = require('../utils/logger');
const redis = require('../redis');

const router = express.Router();

router.get('/', auth, loadUserContext, async (req, res) => {
    try {
        if (!req.userTeamId) return res.json({ sprints: [] });

        const sprints = (await req.db.query(`
            SELECT * FROM sprints
            WHERE team_id = $1
            ORDER BY
                CASE status WHEN 'active' THEN 1 WHEN 'planned' THEN 2 WHEN 'completed' THEN 3 END,
                start_date DESC
        `, [req.userTeamId])).rows;

        res.json({ sprints });
    } catch (err) {
        req.log.error({ err }, 'Error fetching sprints:');
        res.status(500).json({ error: 'Failed to fetch sprints' });
    }
});

router.get('/active', auth, loadUserContext, async (req, res) => {
    try {
        if (!req.userTeamId) return res.json({ sprint: null });

        // Try Redis cache first
        const cached = await redis.getActiveSprint(req.userTeamId);
        if (cached !== null) return res.json({ sprint: cached || null });

        const sprint = (await req.db.query(`
            SELECT * FROM sprints
            WHERE team_id = $1 AND status = 'active'
            ORDER BY start_date DESC LIMIT 1
        `, [req.userTeamId])).rows[0];

        await redis.setActiveSprint(req.userTeamId, sprint || false);

        res.json({ sprint: sprint || null });
    } catch (err) {
        req.log.error({ err }, 'Error fetching active sprint:');
        res.status(500).json({ error: 'Failed to fetch active sprint' });
    }
});

router.post('/', auth, loadUserContext, requireRole('team_lead'), async (req, res) => {
    try {
        if (!req.userTeamId) return res.status(403).json({ error: 'You must be assigned to a team to create sprints' });

        const { name, start_date, end_date, goal } = req.body;
        if (!name || !start_date || !end_date) return res.status(400).json({ error: 'Sprint name, start_date, and end_date are required' });
        if (name.trim().length > 100) return res.status(400).json({ error: 'Sprint name must be 100 characters or less' });
        if (goal && goal.length > 1000) return res.status(400).json({ error: 'Sprint goal must be 1000 characters or less' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
            return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format' });
        }

        const existing = (await req.db.query('SELECT id FROM sprints WHERE team_id = $1 AND name = $2', [req.userTeamId, name])).rows[0];
        if (existing) return res.status(400).json({ error: 'A sprint with this name already exists for your team' });

        const result = await req.db.query(
            "INSERT INTO sprints (team_id, name, start_date, end_date, goal, status) VALUES ($1, $2, $3, $4, $5, 'planned') RETURNING id",
            [req.userTeamId, name, start_date, end_date, goal || null]
        );
        const newSprint = (await req.db.query('SELECT * FROM sprints WHERE id = $1', [result.rows[0].id])).rows[0];
        res.json({ sprint: newSprint });
    } catch (err) {
        req.log.error({ err }, 'Error creating sprint:');
        res.status(500).json({ error: 'Failed to create sprint' });
    }
});

router.put('/:id', auth, loadUserContext, requireRole('team_lead'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, start_date, end_date, goal, status } = req.body;

        const sprint = (await req.db.query(
            'SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: 'Access denied' });

        const updates = [];
        const params = [];
        let pi = 1;

        if (name !== undefined) { updates.push(`name = $${pi++}`); params.push(name); }
        if (start_date !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' });
            updates.push(`start_date = $${pi++}`); params.push(start_date);
        }
        if (end_date !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date)) return res.status(400).json({ error: 'end_date must be YYYY-MM-DD' });
            updates.push(`end_date = $${pi++}`); params.push(end_date);
        }
        if (goal !== undefined) { updates.push(`goal = $${pi++}`); params.push(goal); }
        if (status !== undefined && ['planned', 'active', 'completed'].includes(status)) {
            updates.push(`status = $${pi++}`); params.push(status);
        }

        if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

        params.push(id);
        await req.db.query(`UPDATE sprints SET ${updates.join(', ')} WHERE id = $${pi}`, params);
        await redis.invalidateActiveSprint(sprint.team_id);

        const updated = (await req.db.query('SELECT * FROM sprints WHERE id = $1', [id])).rows[0];
        res.json({ sprint: updated });
    } catch (err) {
        req.log.error({ err }, 'Error updating sprint:');
        res.status(500).json({ error: 'Failed to update sprint' });
    }
});

router.delete('/:id', auth, loadUserContext, requireRole('team_lead'), async (req, res) => {
    try {
        const { id } = req.params;

        const sprint = (await req.db.query(
            'SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: 'Access denied' });

        await req.db.query('UPDATE tasks SET sprint_id = NULL WHERE sprint_id = $1', [id]);
        await req.db.query('DELETE FROM sprints WHERE id = $1', [id]);
        await redis.invalidateActiveSprint(sprint.team_id);
        res.json({ message: 'Sprint deleted successfully' });
    } catch (err) {
        req.log.error({ err }, 'Error deleting sprint:');
        res.status(500).json({ error: 'Failed to delete sprint' });
    }
});

router.get('/:id/tasks', auth, loadUserContext, async (req, res) => {
    try {
        const { id } = req.params;

        const sprint = (await req.db.query(
            'SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: 'Access denied' });

        const tasks = (await req.db.query('SELECT * FROM tasks WHERE sprint_id = $1 ORDER BY created_at ASC', [id])).rows;
        res.json({ tasks });
    } catch (err) {
        req.log.error({ err }, 'Error fetching sprint tasks:');
        res.status(500).json({ error: 'Failed to fetch sprint tasks' });
    }
});

module.exports = router;