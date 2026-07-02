// Sprint-related task routes:
//   GET   /available-sprints     — sprints the requester can target
//   PATCH /:id/assign-sprint     — move a task into / out of a sprint

import express from "express";
import type { Request, Response } from "express";
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');
const { requireFeature } = require('../../middleware/tenant');

const { logHistory } = require('./_helpers/logHistory');
const { canAccessTask } = require('./_helpers/access');
const { enrichTasks } = require('./_helpers/enrich');
const { materialiseTeamSprints } = require('./_helpers/sprintMaterialise');

const router = express.Router();

// Both routes below are part of the Agile feature bundle — same gate as
// /api/sprints and /api/agile. Applied per-route (NOT router.use) because
// this sub-router is mounted at '/' under /api/tasks and a router-level
// gate would block every non-agile task route too. Without this gate a
// tenant with "Agile & Sprints" disabled could still list (and even
// auto-materialise!) sprints, which is why the mobile app kept showing the
// Sprint tab after the feature override was turned off.
const requireAgile = requireFeature('agile');

// ─── Get available sprints for user's team (current + future) ────────────
router.get('/available-sprints', requireAgile, auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const isOrgAdmin = req.userOrgId && (req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin');

        // Org admins see every active/planned sprint across all teams in their org
        // (so they can move service-desk tickets into any team's sprint). For any
        // team in the org that has a sprint_start_date configured but no sprint
        // rows yet, auto-materialise the current + next sprint so admins don't
        // have to wait for a team member to visit the Tasks page first.
        if (isOrgAdmin) {
            const teamsNeedingSprints = (await req.db!.query(`
                SELECT t.id, t.name, t.sprint_start_date, t.sprint_duration_weeks
                FROM teams t
                LEFT JOIN sprints s
                       ON s.team_id = t.id AND s.status IN ('active', 'planned')
                WHERE t.org_id = $1
                  AND t.sprint_start_date IS NOT NULL
                  AND s.id IS NULL
            `, [req.userOrgId])).rows;
            for (const team of teamsNeedingSprints) {
                try { await materialiseTeamSprints(team, req); }
                catch (e) { req.log.warn({ err: e, teamId: team.id }, 'Failed to auto-materialise sprints for team'); }
            }

            const orgSprints = (await req.db!.query(`
                SELECT s.id, s.name, s.start_date, s.end_date, s.status, s.goal, s.team_id, t.name as team_name
                FROM sprints s
                JOIN teams t ON t.id = s.team_id
                WHERE t.org_id = $1 AND s.status IN ('active', 'planned')
                ORDER BY t.name ASC, s.start_date ASC
            `, [req.userOrgId])).rows;
            return res.json(orgSprints);
        }

        if (!req.userTeamId) return res.json([]);

        const sprints = (await req.db!.query(`
            SELECT id, name, start_date, end_date, status, goal
            FROM sprints
            WHERE team_id = $1 AND status IN ('active', 'planned')
            ORDER BY start_date ASC
        `, [req.userTeamId])).rows;

        if (sprints.length === 0) {
            const team = (await req.db!.query(
                'SELECT id, sprint_start_date, sprint_duration_weeks FROM teams WHERE id = $1',
                [req.userTeamId]
            )).rows[0];
            const autoSprints = await materialiseTeamSprints(team, req);
            return res.json(autoSprints);
        }

        res.json(sprints);
    } catch (err) {
        req.log.error({ err: err }, 'Error fetching available sprints:');
        res.status(500).json({ error: 'Failed to fetch sprints' });
    }
});

// ─── Assign task to sprint ────────────────────────────────────────────────
router.patch('/:id/assign-sprint', requireAgile, auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { sprint_id } = req.body;

        const task = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        if (!await canAccessTask(task, req.userId, req.userOrgId, req.db, req.userRole)) return res.status(404).json({ error: 'Task not found' });

        if (sprint_id === null || sprint_id === undefined || sprint_id === '') {
            const oldSprint = task.sprint_id ? (await req.db!.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            await req.db!.query('UPDATE tasks SET sprint_id = NULL WHERE id = $1', [id]);
            await logHistory(id, req.userId, 'updated', 'sprint', oldSprint?.name || 'none', 'none', null, req.db);
        } else {
            // Org admins can assign to any sprint within their org; others limited to own team.
            // Bug #7 (Stage 2): the non-admin branch previously looked sprints
            // up globally by id (no org filter). With a colliding team_id across
            // tenants you could in theory attach to another org's sprint. Join
            // through teams in both branches so the org filter is always applied.
            const isOrgAdmin = req.userRole === 'super_admin' || req.userRole === 'hr_admin' || req.userRole === 'platform_admin';
            const sprint = (await req.db!.query(
                'SELECT s.id, s.team_id, s.name, s.end_date FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2',
                [sprint_id, req.userOrgId]
            )).rows[0];
            if (!sprint || (!isOrgAdmin && sprint.team_id !== req.userTeamId)) {
                return res.status(400).json({ error: 'Invalid sprint or sprint does not belong to your team' });
            }
            const oldSprint = task.sprint_id ? (await req.db!.query('SELECT name FROM sprints WHERE id = $1', [task.sprint_id])).rows[0] : null;
            if (task.due_date !== sprint.end_date) {
                await logHistory(id, req.userId, 'updated', 'due_date', task.due_date, sprint.end_date, null, req.db);
            }
            await req.db!.query('UPDATE tasks SET sprint_id = $1, due_date = $2 WHERE id = $3', [sprint.id, sprint.end_date, id]);
            await logHistory(id, req.userId, 'updated', 'sprint', oldSprint?.name || 'none', sprint.name, null, req.db);
        }

        const updated = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
        const enriched = await enrichTasks([updated], req.db);
        res.json(enriched[0]);
    } catch (err) {
        req.log.error({ err: err }, 'Error assigning sprint:');
        res.status(500).json({ error: 'Failed to assign sprint' });
    }
});

export = router;