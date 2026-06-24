import express from "express";
import type { Request, Response } from "express";
const auth = require("../middleware/auth");
const { loadUserContext, requireRole } = require("../middleware/rbac");
const { requireTenant, requireFeature } = require("../middleware/tenant");
const { logger } = require("../utils/logger");
const redis = require("../redis");

const router = express.Router();
router.use(requireTenant, requireFeature("agile"));

// ─── Helper: take a daily burndown snapshot for a sprint ────────────────────
//
// Snapshots are stored in `sprint_burndown_snapshots` (one row per
// sprint × day). Idempotent for the same date — we UPSERT on conflict.
// Used by the sprint complete flow and by the daily background job.
async function snapshotBurndown(db: any, sprintId: number) {
    const tasks = (await db.query(
        `SELECT t.story_points, ws.is_terminal, t.is_blocked
           FROM tasks t
           LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
          WHERE t.sprint_id = $1`,
        [sprintId]
    )).rows;

    const num = (v: any) => (v == null ? 0 : Number(v));
    let total = 0, done = 0, blocked = 0, openCount = 0;
    for (const t of tasks) {
        const sp = num(t.story_points);
        total += sp;
        if (t.is_terminal) done += sp;
        else openCount += 1;
        if (t.is_blocked) blocked += sp;
    }
    const remaining = total - done;

    await db.query(
        `INSERT INTO sprint_burndown_snapshots (sprint_id, snapshot_date, total_points, done_points, remaining_points, blocked_points, open_tasks)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
         ON CONFLICT (sprint_id, snapshot_date)
         DO UPDATE SET total_points = EXCLUDED.total_points,
                       done_points = EXCLUDED.done_points,
                       remaining_points = EXCLUDED.remaining_points,
                       blocked_points = EXCLUDED.blocked_points,
                       open_tasks = EXCLUDED.open_tasks`,
        [sprintId, total, done, remaining, blocked, openCount]
    );
}

router.get("/", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        if (!req.userTeamId) return res.json({ sprints: [] });

        const sprints = (await req.db!.query(`
            SELECT * FROM sprints
            WHERE team_id = $1
            ORDER BY
                CASE status WHEN 'active' THEN 1 WHEN 'planned' THEN 2 WHEN 'completed' THEN 3 END,
                start_date DESC
        `, [req.userTeamId])).rows;

        res.json({ sprints });
    } catch (err) {
        req.log.error({ err }, "Error fetching sprints:");
        res.status(500).json({ error: "Failed to fetch sprints" });
    }
});

router.get("/active", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        if (!req.userTeamId) return res.json({ sprint: null });

        // Try Redis cache first
        const cached = await redis.getActiveSprint(req.tenantId, req.userTeamId);
        if (cached !== null) return res.json({ sprint: cached || null });

        const sprint = (await req.db!.query(`
            SELECT * FROM sprints
            WHERE team_id = $1 AND status = 'active'
            ORDER BY start_date DESC LIMIT 1
        `, [req.userTeamId])).rows[0];

        await redis.setActiveSprint(req.tenantId, req.userTeamId, sprint || false);

        res.json({ sprint: sprint || null });
    } catch (err) {
        req.log.error({ err }, "Error fetching active sprint:");
        res.status(500).json({ error: "Failed to fetch active sprint" });
    }
});

router.post("/", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        if (!req.userTeamId) return res.status(403).json({ error: "You must be assigned to a team to create sprints" });

        const { name, start_date, end_date, goal } = req.body;
        if (!name || !start_date || !end_date) return res.status(400).json({ error: "Sprint name, start_date, and end_date are required" });
        if (name.trim().length > 100) return res.status(400).json({ error: "Sprint name must be 100 characters or less" });
        if (goal && goal.length > 1000) return res.status(400).json({ error: "Sprint goal must be 1000 characters or less" });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
            return res.status(400).json({ error: "Dates must be in YYYY-MM-DD format" });
        }

        const existing = (await req.db!.query("SELECT id FROM sprints WHERE team_id = $1 AND name = $2", [req.userTeamId, name])).rows[0];
        if (existing) return res.status(400).json({ error: "A sprint with this name already exists for your team" });

        const result = await req.db!.query(
            "INSERT INTO sprints (team_id, name, start_date, end_date, goal, status) VALUES ($1, $2, $3, $4, $5, 'planned') RETURNING id",
            [req.userTeamId, name, start_date, end_date, goal || null]
        );
        const newSprint = (await req.db!.query("SELECT * FROM sprints WHERE id = $1", [result.rows[0].id])).rows[0];
        res.json({ sprint: newSprint });
    } catch (err) {
        req.log.error({ err }, "Error creating sprint:");
        res.status(500).json({ error: "Failed to create sprint" });
    }
});

router.put("/:id", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { name, start_date, end_date, goal, status } = req.body;

        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });

        const updates: string[] = [];
        const params: unknown[] = [];
        let pi = 1;

        if (name !== undefined) { updates.push(`name = $${pi++}`); params.push(name); }
        if (start_date !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return res.status(400).json({ error: "start_date must be YYYY-MM-DD" });
            updates.push(`start_date = $${pi++}`); params.push(start_date);
        }
        if (end_date !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date)) return res.status(400).json({ error: "end_date must be YYYY-MM-DD" });
            updates.push(`end_date = $${pi++}`); params.push(end_date);
        }
        if (goal !== undefined) { updates.push(`goal = $${pi++}`); params.push(goal); }
        if (status !== undefined && ["planned", "active", "paused", "completed"].includes(status)) {
            updates.push(`status = $${pi++}`); params.push(status);
        }

        if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });

        params.push(id);
        await req.db!.query(`UPDATE sprints SET ${updates.join(", ")} WHERE id = $${pi}`, params);
        await redis.invalidateActiveSprint(req.tenantId, sprint.team_id);

        const updated = (await req.db!.query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
        res.json({ sprint: updated });
    } catch (err) {
        req.log.error({ err }, "Error updating sprint:");
        res.status(500).json({ error: "Failed to update sprint" });
    }
});

router.delete("/:id", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });

        await req.db!.query("UPDATE tasks SET sprint_id = NULL WHERE sprint_id = $1", [id]);
        await req.db!.query("DELETE FROM sprints WHERE id = $1", [id]);
        await redis.invalidateActiveSprint(req.tenantId, sprint.team_id);
        res.json({ message: "Sprint deleted successfully" });
    } catch (err) {
        req.log.error({ err }, "Error deleting sprint:");
        res.status(500).json({ error: "Failed to delete sprint" });
    }
});

router.get("/:id/tasks", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });

        const tasks = (await req.db!.query("SELECT * FROM tasks WHERE sprint_id = $1 ORDER BY created_at ASC", [id])).rows;
        res.json({ tasks });
    } catch (err) {
        req.log.error({ err }, "Error fetching sprint tasks:");
        res.status(500).json({ error: "Failed to fetch sprint tasks" });
    }
});

// ─── Sprint stats: story-point and task rollups by status / type / assignee ──
//
// Returns a single bundle the client can render in the Sprint header /
// Insights panel without further round-trips. Counts story points (treating
// NULL as 0 and tracking unestimated count separately), grouped by:
//   - workflow state (with category for reporting)
//   - work item type
//   - assignee
//
// Org admins can request stats for any sprint in their org; others limited
// to their own team. Visible to any member of the team.
router.get("/:id/stats", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });

        const isOrgAdmin = req.userRole === "super_admin" || req.userRole === "hr_admin" || req.userRole === "platform_admin";
        const sprint = (await req.db!.query(
            `SELECT s.*, t.org_id AS team_org_id
               FROM sprints s
               JOIN teams t ON t.id = s.team_id
              WHERE s.id = $1`,
            [id]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_org_id !== req.userOrgId) return res.status(404).json({ error: "Sprint not found" });
        if (!isOrgAdmin && sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });

        const tasks = (await req.db!.query(
            `SELECT t.id, t.title, t.status, t.workflow_state_id, t.work_item_type_id,
                    t.story_points, t.assigned_to, t.is_blocked, t.completed_at, t.priority
               FROM tasks t
              WHERE t.sprint_id = $1`,
            [id]
        )).rows;

        // Pull workflow state metadata (category, terminal flag) and type metadata
        const stateIds = [...new Set(tasks.map((t: any) => t.workflow_state_id).filter(Boolean))];
        const typeIds = [...new Set(tasks.map((t: any) => t.work_item_type_id).filter(Boolean))];
        const assigneeIds = [...new Set(tasks.map((t: any) => t.assigned_to).filter(Boolean))];

        const [states, types, users] = await Promise.all([
            stateIds.length
                ? req.db!.query(
                    "SELECT id, key, name, category, color, is_terminal FROM workflow_states WHERE id = ANY($1)",
                    [stateIds]
                ).then((r: any) => r.rows)
                : [],
            typeIds.length
                ? req.db!.query(
                    "SELECT id, key, name, color, icon FROM work_item_types WHERE id = ANY($1)",
                    [typeIds]
                ).then((r: any) => r.rows)
                : [],
            assigneeIds.length
                ? req.db!.query(
                    "SELECT id, username, full_name, avatar FROM users WHERE id = ANY($1)",
                    [assigneeIds]
                ).then((r: any) => r.rows)
                : [],
        ]);

        const stateById = Object.fromEntries(states.map((s: any) => [s.id, s]));
        const typeById = Object.fromEntries(types.map((t: any) => [t.id, t]));
        const userById = Object.fromEntries(users.map((u: any) => [u.id, u]));

        const num = (v: any) => (v == null ? 0 : Number(v));

        const totalTasks = tasks.length;
        const totalPoints = tasks.reduce((sum: number, t: any) => sum + num(t.story_points), 0);
        const unestimatedTasks = tasks.filter((t: any) => t.story_points == null).length;
        const blockedTasks = tasks.filter((t: any) => t.is_blocked).length;

        // Task / point rollup by workflow state
        const byState: Record<string, any> = {};
        for (const t of tasks) {
            const s = stateById[t.workflow_state_id] || { id: 0, key: t.status || "unknown", name: t.status || "Unknown", category: "open", color: "#6b7280", is_terminal: false };
            const k = String(s.id);
            if (!byState[k]) {
                byState[k] = { state: s, taskCount: 0, points: 0 };
            }
            byState[k].taskCount += 1;
            byState[k].points += num(t.story_points);
        }
        // Done counts (any state with is_terminal = TRUE)
        const donePoints = Object.values(byState)
            .filter((b: any) => b.state.is_terminal)
            .reduce((sum: number, b: any) => sum + b.points, 0);
        const doneTasks = Object.values(byState)
            .filter((b: any) => b.state.is_terminal)
            .reduce((sum: number, b: any) => sum + b.taskCount, 0);

        // By work item type
        const byType: Record<string, any> = {};
        for (const t of tasks) {
            const wit = typeById[t.work_item_type_id] || { id: 0, key: "unknown", name: "Unknown", color: "#6b7280" };
            const k = String(wit.id);
            if (!byType[k]) byType[k] = { type: wit, taskCount: 0, points: 0, done: 0 };
            byType[k].taskCount += 1;
            byType[k].points += num(t.story_points);
            const stateRow = stateById[t.workflow_state_id];
            if (stateRow?.is_terminal) byType[k].done += 1;
        }

        // By assignee
        const byAssignee: Record<string, any> = {};
        for (const t of tasks) {
            const u = t.assigned_to ? userById[t.assigned_to] : null;
            const k = u ? `u${u.id}` : "unassigned";
            if (!byAssignee[k]) {
                byAssignee[k] = {
                    user: u || null,
                    taskCount: 0,
                    points: 0,
                    done: 0,
                    donePoints: 0,
                };
            }
            byAssignee[k].taskCount += 1;
            byAssignee[k].points += num(t.story_points);
            const stateRow = stateById[t.workflow_state_id];
            if (stateRow?.is_terminal) {
                byAssignee[k].done += 1;
                byAssignee[k].donePoints += num(t.story_points);
            }
        }

        const remainingPoints = totalPoints - donePoints;
        const percentByPoints = totalPoints > 0 ? Math.round((donePoints / totalPoints) * 100) : 0;
        const percentByTasks = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

        res.json({
            sprint: {
                id: sprint.id, name: sprint.name, status: sprint.status,
                start_date: sprint.start_date, end_date: sprint.end_date, goal: sprint.goal,
                team_id: sprint.team_id,
            },
            totals: {
                tasks: totalTasks,
                points: totalPoints,
                doneTasks, donePoints, remainingPoints,
                unestimatedTasks, blockedTasks,
                percentByPoints, percentByTasks,
            },
            byState: Object.values(byState).sort((a: any, b: any) => (a.state.sort_order ?? 0) - (b.state.sort_order ?? 0)),
            byType: Object.values(byType),
            byAssignee: Object.values(byAssignee),
        });
    } catch (err) {
        req.log.error({ err }, "Error fetching sprint stats:");
        res.status(500).json({ error: "Failed to fetch sprint stats" });
    }
});

// ─── Sprint lifecycle: START ────────────────────────────────────────────────
//
// Transitions a sprint from 'planned' → 'active'. Enforces:
//   - Only one active sprint per team at a time (auto-completes existing).
//   - Captures starting velocity baseline as the day-0 burndown snapshot.
router.post("/:id/start", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });
        if (sprint.status === "active") return res.status(400).json({ error: "Sprint is already active" });
        if (sprint.status === "completed") return res.status(400).json({ error: "Cannot restart a completed sprint" });

        // Auto-complete any other active sprint on the same team
        await req.db!.query(
            `UPDATE sprints SET status = 'completed', completed_at = NOW()
              WHERE team_id = $1 AND status = 'active' AND id != $2`,
            [sprint.team_id, id]
        );

        await req.db!.query(
            "UPDATE sprints SET status = 'active', started_at = COALESCE(started_at, NOW()) WHERE id = $1",
            [id]
        );

        await snapshotBurndown(req.db, parseInt(String(id), 10));
        await redis.invalidateActiveSprint(req.tenantId, sprint.team_id);

        const updated = (await req.db!.query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
        res.json({ sprint: updated });
    } catch (err) {
        req.log.error({ err }, "Error starting sprint");
        res.status(500).json({ error: "Failed to start sprint" });
    }
});

// ─── Sprint lifecycle: COMPLETE (with optional rollover) ────────────────────
//
// Body: { rolloverTo?: <sprintId or "backlog"> }
//   - "backlog" (default) — moves any incomplete tickets to the backlog
//     (sprint_id = NULL) so they can be re-prioritised.
//   - sprintId — bulk-assigns the incomplete tickets to that next sprint.
// Records the velocity (= total story points completed) so the sprint
// retrospective and trend chart can use it without recomputing.
router.post("/:id/complete", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { rolloverTo } = req.body || {};

        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });
        if (sprint.status === "completed") return res.status(400).json({ error: "Sprint already completed" });

        // Capture final burndown snapshot before rollover so the chart shows
        // the true endpoint, not the post-rollover state.
        await snapshotBurndown(req.db, parseInt(String(id), 10));

        // Compute velocity = sum of completed (terminal-state) points
        const velocityRow = (await req.db!.query(
            `SELECT COALESCE(SUM(t.story_points), 0)::float AS velocity,
                    COUNT(*) FILTER (WHERE ws.is_terminal) AS done_tasks,
                    COUNT(*) AS total_tasks
               FROM tasks t
               LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
              WHERE t.sprint_id = $1`,
            [id]
        )).rows[0];

        let rolledOver = 0;
        if (rolloverTo && rolloverTo !== "backlog") {
            const targetId = parseInt(rolloverTo, 10);
            if (isNaN(targetId)) return res.status(400).json({ error: "Invalid rolloverTo sprint id" });
            const target = (await req.db!.query(
                "SELECT id, status FROM sprints WHERE id = $1 AND team_id = $2",
                [targetId, sprint.team_id]
            )).rows[0];
            if (!target) return res.status(400).json({ error: "Target sprint not found" });
            if (target.status === "completed") return res.status(400).json({ error: "Cannot roll over to a completed sprint" });
            const r = await req.db!.query(
                `UPDATE tasks SET sprint_id = $1, carried_over_from_sprint_id = $2
                  WHERE sprint_id = $2
                    AND COALESCE((SELECT is_terminal FROM workflow_states WHERE id = tasks.workflow_state_id), FALSE) = FALSE`,
                [targetId, id]
            );
            rolledOver = r.rowCount;
            // Record provenance on the target sprint so Insights can show a
            // "Carried Forward" list that links back to this origin sprint.
            await req.db!.query(
                `UPDATE sprints SET carried_from_sprint_id = $1 WHERE id = $2 AND carried_from_sprint_id IS NULL`,
                [id, targetId]
            );
        } else {
            const r = await req.db!.query(
                `UPDATE tasks SET sprint_id = NULL
                  WHERE sprint_id = $1
                    AND COALESCE((SELECT is_terminal FROM workflow_states WHERE id = tasks.workflow_state_id), FALSE) = FALSE`,
                [id]
            );
            rolledOver = r.rowCount;
        }

        await req.db!.query(
            `UPDATE sprints
                SET status = 'completed',
                    completed_at = NOW(),
                    velocity_points = $1
              WHERE id = $2`,
            [velocityRow.velocity, id]
        );

        await redis.invalidateActiveSprint(req.tenantId, sprint.team_id);

        const updated = (await req.db!.query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
        res.json({
            sprint: updated,
            velocity: Number(velocityRow.velocity),
            doneTasks: Number(velocityRow.done_tasks),
            totalTasks: Number(velocityRow.total_tasks),
            rolledOver,
        });
    } catch (err) {
        req.log.error({ err }, "Error completing sprint");
        res.status(500).json({ error: "Failed to complete sprint" });
    }
});

// ─── Sprint lifecycle: PAUSE ────────────────────────────────────────────────
//
// Pauses an active sprint. Sets status='paused' + paused_at and flags the team
// as paused so the auto-scheduler skips it (the cadence clock effectively
// freezes). Restricted to team_lead and above (manager / admins inherit).
router.post("/:id/pause", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });
        if (sprint.status !== "active") return res.status(400).json({ error: "Only an active sprint can be paused" });

        await req.db!.query(
            "UPDATE sprints SET status = 'paused', paused_at = NOW() WHERE id = $1",
            [id]
        );
        // Freeze the auto-scheduler for this team while paused.
        await req.db!.query("UPDATE teams SET sprint_paused = TRUE WHERE id = $1", [sprint.team_id]);
        await redis.invalidateActiveSprint(req.tenantId, sprint.team_id);

        const updated = (await req.db!.query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
        res.json({ sprint: updated });
    } catch (err) {
        req.log.error({ err }, "Error pausing sprint");
        res.status(500).json({ error: "Failed to pause sprint" });
    }
});

// ─── Sprint lifecycle: RESUME ───────────────────────────────────────────────
//
// Resumes a paused sprint. Shifts end_date forward by the paused duration so
// the team doesn't lose the days they were paused, re-activates it, and clears
// the team pause flag so the auto-scheduler resumes. Restricted to team_lead+.
router.post("/:id/resume", auth, loadUserContext, requireRole("team_lead"), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const sprint = (await req.db!.query(
            "SELECT s.* FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 AND t.org_id = $2",
            [id, req.userOrgId]
        )).rows[0];
        if (!sprint) return res.status(404).json({ error: "Sprint not found" });
        if (sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });
        if (sprint.status !== "paused") return res.status(400).json({ error: "Only a paused sprint can be resumed" });

        // Push the end date out by however long we were paused so the team
        // keeps their full working window.
        let pausedDays = 0;
        if (sprint.paused_at) {
            pausedDays = Math.max(0, Math.floor((Date.now() - new Date(sprint.paused_at).getTime()) / 86400000));
        }
        const newEnd = new Date(new Date(sprint.end_date).getTime() + pausedDays * 86400000)
            .toISOString().slice(0, 10);

        await req.db!.query(
            "UPDATE sprints SET status = 'active', paused_at = NULL, end_date = $2 WHERE id = $1",
            [id, newEnd]
        );
        await req.db!.query("UPDATE teams SET sprint_paused = FALSE WHERE id = $1", [sprint.team_id]);
        await redis.invalidateActiveSprint(req.tenantId, sprint.team_id);

        const updated = (await req.db!.query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
        res.json({ sprint: updated });
    } catch (err) {
        req.log.error({ err }, "Error resuming sprint");
        res.status(500).json({ error: "Failed to resume sprint" });
    }
});

// ─── Carried-forward tickets (for Sprint Insights) ──────────────────────────
//
// Returns the tickets that were rolled INTO this sprint from a previous one
// (tasks.carried_over_from_sprint_id points at the origin sprint), along with
// the origin sprint metadata so the UI can link back. Visible to any member of
// the team (and org admins).
router.get("/:id/carried-over", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });
        const sprint = await loadAccessibleSprint(req, res, id);
        if (!sprint) return;

        const tasks = (await req.db!.query(
            `SELECT t.id, t.title, t.status, t.story_points, t.assigned_to,
                    t.carried_over_from_sprint_id,
                    os.name AS origin_sprint_name, os.id AS origin_sprint_id
               FROM tasks t
          LEFT JOIN sprints os ON os.id = t.carried_over_from_sprint_id
              WHERE t.sprint_id = $1 AND t.carried_over_from_sprint_id IS NOT NULL
              ORDER BY t.created_at ASC`,
            [id]
        )).rows;

        res.json({
            sprint_id: id,
            carriedFromSprintId: sprint.carried_from_sprint_id || null,
            tasks,
        });
    } catch (err) {
        req.log.error({ err }, "Error fetching carried-over tasks");
        res.status(500).json({ error: "Failed to fetch carried-over tasks" });
    }
});

// ─── Burndown chart data ────────────────────────────────────────────────────
//
// Returns the per-day snapshot series + an "ideal" line computed from the
// total starting scope and the sprint duration.
router.get("/:id/burndown", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });

        const isOrgAdmin = ["super_admin", "hr_admin", "platform_admin"].includes(req.userRole as string);
        const sprint = (await req.db!.query(
            `SELECT s.*, t.org_id AS team_org_id
               FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1`,
            [id]
        )).rows[0];
        if (!sprint || sprint.team_org_id !== req.userOrgId) return res.status(404).json({ error: "Sprint not found" });
        if (!isOrgAdmin && sprint.team_id !== req.userTeamId) return res.status(403).json({ error: "Access denied" });

        // Take a fresh snapshot for today if the sprint is active so the
        // chart is always up-to-date when an admin opens it.
        if (sprint.status === "active") {
            await snapshotBurndown(req.db, id);
        }

        const snapshots = (await req.db!.query(
            `SELECT snapshot_date, total_points, done_points, remaining_points, blocked_points, open_tasks
               FROM sprint_burndown_snapshots
              WHERE sprint_id = $1
              ORDER BY snapshot_date ASC`,
            [id]
        )).rows;

        // Ideal-line: linearly burn down total starting scope across sprint duration
        const startScope = snapshots[0]?.total_points ?? 0;
        const start = new Date(sprint.start_date);
        const end = new Date(sprint.end_date);
        const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
        const ideal = [];
        for (let i = 0; i <= totalDays; i++) {
            const d = new Date(start);
            d.setDate(d.getDate() + i);
            ideal.push({
                date: d.toISOString().slice(0, 10),
                remaining: Math.max(0, Number(startScope) * (1 - i / totalDays)),
            });
        }

        res.json({
            sprint: { id: sprint.id, name: sprint.name, start_date: sprint.start_date, end_date: sprint.end_date, status: sprint.status },
            snapshots, ideal, startScope: Number(startScope),
        });
    } catch (err) {
        req.log.error({ err }, "Error fetching burndown");
        res.status(500).json({ error: "Failed to fetch burndown" });
    }
});

// ─── Velocity (last N completed sprints for the team) ───────────────────────
router.get("/velocity/recent", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        if (!req.userTeamId) return res.json({ sprints: [], average: 0 });
        const limit = Math.min(parseInt(String(req.query.limit), 10) || 6, 20);
        const rows = (await req.db!.query(
            `SELECT id, name, start_date, end_date, completed_at,
                    COALESCE(velocity_points, 0)::float AS velocity_points
               FROM sprints
              WHERE team_id = $1 AND status = 'completed'
              ORDER BY completed_at DESC NULLS LAST
              LIMIT $2`,
            [req.userTeamId, limit]
        )).rows;
        const series = rows.reverse(); // oldest → newest for charting
        const avg = series.length
            ? series.reduce((a: number, r: any) => a + Number(r.velocity_points), 0) / series.length
            : 0;
        res.json({ sprints: series, average: Number(avg.toFixed(1)) });
    } catch (err) {
        req.log.error({ err }, "Error fetching velocity");
        res.status(500).json({ error: "Failed to fetch velocity" });
    }
});

// ─── Phase 3 endpoints ─────────────────────────────────────────────────────

/**
 * Helper: ensure the requester can read this sprint (same org). Returns the
 * sprint row joined with team.org_id, or null after sending 404.
 */
async function loadAccessibleSprint(req: Request, res: Response, sprintId: number) {
    const sprint = (await req.db!.query(
        `SELECT s.*, t.org_id, t.name AS team_name
           FROM sprints s JOIN teams t ON t.id = s.team_id
          WHERE s.id = $1`,
        [sprintId]
    )).rows[0];
    if (!sprint || (req.userOrgId && sprint.org_id !== req.userOrgId)) {
        res.status(404).json({ error: "Sprint not found" });
        return null;
    }
    return sprint;
}

// GET /sprints/:id/cumulative-flow
//
// Returns a per-day series of how many tasks were in each workflow-state
// CATEGORY (open / in_progress / in_review / done) over the sprint window.
// Used by the Cumulative Flow chart on the Insights view.
//
// We approximate the historical state by walking task_history rows up to the
// snapshot date. This is cheap-ish for sprint-scoped task sets and avoids the
// need for a daily snapshot table.
router.get("/:id/cumulative-flow", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });
        const sprint = await loadAccessibleSprint(req, res, id);
        if (!sprint) return;

        // Pull every task that's ever belonged to this sprint along with its
        // current workflow_state's category. We then walk task_history to
        // reconstruct the state on each day.
        const tasks = (await req.db!.query(
            `SELECT t.id, t.created_at, t.completed_at,
                    ws.category AS current_category,
                    ws.key      AS current_key
               FROM tasks t
          LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
              WHERE t.sprint_id = $1`,
            [id]
        )).rows;

        if (tasks.length === 0) {
            return res.json({
                sprint: { id, start_date: sprint.start_date, end_date: sprint.end_date },
                series: [],
            });
        }

        // History rows for status changes — we use these to roll back the
        // category on each day. Any task without a history entry is assumed to
        // have been in its current category since creation.
        const taskIds = tasks.map((t: any) => t.id);
        const history = (await req.db!.query(
            `SELECT th.task_id, th.created_at, th.old_value, th.new_value
               FROM task_history th
              WHERE th.task_id = ANY($1) AND th.action = 'status_change'
              ORDER BY th.task_id, th.created_at ASC`,
            [taskIds]
        )).rows;
        const historyByTask = new Map<number, any[]>();
        for (const h of history) {
            const arr = historyByTask.get(h.task_id) || [];
            arr.push(h);
            historyByTask.set(h.task_id, arr);
        }

        // Map status keys → category for quick lookup. Org-specific.
        const stateRows = (await req.db!.query(
            "SELECT key, category FROM workflow_states WHERE org_id = $1",
            [req.userOrgId]
        )).rows;
        const keyToCategory: Record<string, string> = {};
        for (const s of stateRows) keyToCategory[s.key] = s.category;
        // Default mappings for legacy tenants without seeded states.
        const fallback: Record<string, string> = { pending: "open", in_progress: "in_progress", in_review: "in_review", done: "done" };

        /** Reconstruct category for `task` on a given date (end of day). */
        const categoryOnDate = (task: any, date: string): string | null => {
            const dateMs = new Date(date + "T23:59:59Z").getTime();
            // Task didn't exist yet
            if (new Date(task.created_at).getTime() > dateMs) return null;
            const events = historyByTask.get(task.id) || [];
            // Find the last status change that happened on or before `date`.
            // The new_value at that point is the state on that date.
            let key = null;
            for (const ev of events) {
                if (new Date(ev.created_at).getTime() <= dateMs) key = ev.new_value;
                else break;
            }
            // No status change yet → it's been in its current state since
            // creation. We approximate using the current key (best effort —
            // historical accuracy degrades for tasks that moved before the
            // earliest history row).
            if (!key) key = task.current_key;
            return keyToCategory[key] || fallback[key] || "open";
        };

        // Build day list from sprint.start_date → min(today, sprint.end_date).
        const today = new Date().toISOString().slice(0, 10);
        const endDate = (sprint.completed_at ? new Date(sprint.completed_at).toISOString().slice(0, 10) : sprint.end_date);
        const limitDate = today < endDate ? today : endDate;
        const days = [];
        let cursor = sprint.start_date;
        while (cursor <= limitDate) {
            days.push(cursor);
            const d = new Date(cursor + "T00:00:00Z");
            d.setUTCDate(d.getUTCDate() + 1);
            cursor = d.toISOString().slice(0, 10);
        }

        const series = days.map(date => {
            const counts: Record<string, any> = { date, open: 0, in_progress: 0, in_review: 0, done: 0 };
            for (const t of tasks) {
                const cat = categoryOnDate(t, date);
                if (cat && counts[cat] !== undefined) counts[cat]++;
            }
            return counts;
        });

        res.json({
            sprint: { id, start_date: sprint.start_date, end_date: sprint.end_date },
            series,
        });
    } catch (err) {
        req.log.error({ err }, "Error building cumulative flow");
        res.status(500).json({ error: "Failed to build cumulative flow" });
    }
});

// GET /sprints/:id/cycle-time
//
// Returns per-task cycle time (cycle_started_at → completed_at) and lead time
// (lead_started_at → completed_at) for every completed task in the sprint,
// plus aggregate stats (avg / median / p90 in days) used by the Insights view.
router.get("/:id/cycle-time", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });
        const sprint = await loadAccessibleSprint(req, res, id);
        if (!sprint) return;

        const rows = (await req.db!.query(
            `SELECT t.id, t.title, t.story_points,
                    t.created_at, t.cycle_started_at, t.lead_started_at, t.completed_at,
                    wit.name AS type_name, wit.color AS type_color,
                    EXTRACT(EPOCH FROM (t.completed_at - COALESCE(t.cycle_started_at, t.lead_started_at, t.created_at))) / 86400.0 AS cycle_days,
                    EXTRACT(EPOCH FROM (t.completed_at - COALESCE(t.lead_started_at, t.created_at))) / 86400.0 AS lead_days
               FROM tasks t
          LEFT JOIN work_item_types wit ON wit.id = t.work_item_type_id
              WHERE t.sprint_id = $1 AND t.completed_at IS NOT NULL
              ORDER BY t.completed_at ASC`,
            [id]
        )).rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            story_points: r.story_points != null ? Number(r.story_points) : null,
            type_name: r.type_name,
            type_color: r.type_color,
            cycle_days: r.cycle_days != null ? Number(Number(r.cycle_days).toFixed(2)) : null,
            lead_days: r.lead_days != null ? Number(Number(r.lead_days).toFixed(2)) : null,
            completed_at: r.completed_at,
        }));

        const stats = (key: string) => {
            const vals = rows.map((r: any) => r[key]).filter((v: any) => v != null && v >= 0).sort((a: number, b: number) => a - b);
            if (vals.length === 0) return { avg: null, median: null, p90: null, n: 0 };
            const sum = vals.reduce((a: number, b: number) => a + b, 0);
            return {
                n: vals.length,
                avg: Number((sum / vals.length).toFixed(2)),
                median: Number(vals[Math.floor(vals.length / 2)].toFixed(2)),
                p90: Number(vals[Math.floor(vals.length * 0.9)].toFixed(2)),
            };
        };

        res.json({
            sprint: { id, name: sprint.name, start_date: sprint.start_date, end_date: sprint.end_date },
            tasks: rows,
            cycle: stats("cycle_days"),
            lead: stats("lead_days"),
        });
    } catch (err) {
        req.log.error({ err }, "Error fetching cycle time");
        res.status(500).json({ error: "Failed to fetch cycle time" });
    }
});

// ── Sprint Retrospectives ──────────────────────────────────────────────────
// A retrospective is a one-row-per-sprint document with three free-text
// columns plus a JSONB array of action items and an optional team-mood vote.

function normalizeActionItems(value: any): any[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 50).map((it: any, i: number) => ({
        id: Number(it?.id) || (i + 1),
        text: String(it?.text || "").trim().slice(0, 500),
        owner: it?.owner != null ? Number(it.owner) : null,
        done: !!it?.done,
        due_date: typeof it?.due_date === "string" ? it.due_date.slice(0, 10) : null,
    })).filter((it: any) => it.text);
}

router.get("/:id/retrospective", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });
        const sprint = await loadAccessibleSprint(req, res, id);
        if (!sprint) return;
        const row = (await req.db!.query(
            `SELECT r.*, c.full_name AS created_by_name, u.full_name AS updated_by_name
               FROM sprint_retrospectives r
          LEFT JOIN users c ON c.id = r.created_by
          LEFT JOIN users u ON u.id = r.updated_by
              WHERE r.sprint_id = $1`,
            [id]
        )).rows[0];
        res.json({ sprint_id: id, retrospective: row || null });
    } catch (err) {
        req.log.error({ err }, "Error fetching retrospective");
        res.status(500).json({ error: "Failed to fetch retrospective" });
    }
});

// PUT /sprints/:id/retrospective — upsert. Anyone on the same team can edit;
// the row tracks created_by + updated_by separately.
router.put("/:id/retrospective", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid sprint id" });
        const sprint = await loadAccessibleSprint(req, res, id);
        if (!sprint) return;

        const b = req.body || {};
        const wentWell = b.went_well ? String(b.went_well).slice(0, 5000) : null;
        const toImprove = b.to_improve ? String(b.to_improve).slice(0, 5000) : null;
        const summary = b.summary ? String(b.summary).slice(0, 2000) : null;
        const teamMood = (b.team_mood >= 1 && b.team_mood <= 5) ? Number(b.team_mood) : null;
        const actionItems = normalizeActionItems(b.action_items);

        await req.db!.query(
            `INSERT INTO sprint_retrospectives
                (sprint_id, went_well, to_improve, action_items, team_mood, summary,
                 created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7, NOW())
             ON CONFLICT (sprint_id) DO UPDATE SET
                went_well   = EXCLUDED.went_well,
                to_improve  = EXCLUDED.to_improve,
                action_items= EXCLUDED.action_items,
                team_mood   = EXCLUDED.team_mood,
                summary     = EXCLUDED.summary,
                updated_by  = EXCLUDED.updated_by,
                updated_at  = NOW()`,
            [id, wentWell, toImprove, JSON.stringify(actionItems), teamMood, summary, req.userId]
        );

        const row = (await req.db!.query(
            `SELECT r.*, c.full_name AS created_by_name, u.full_name AS updated_by_name
               FROM sprint_retrospectives r
          LEFT JOIN users c ON c.id = r.created_by
          LEFT JOIN users u ON u.id = r.updated_by
              WHERE r.sprint_id = $1`,
            [id]
        )).rows[0];

        res.json({ sprint_id: id, retrospective: row });
    } catch (err) {
        req.log.error({ err }, "Error saving retrospective");
        res.status(500).json({ error: "Failed to save retrospective" });
    }
});

export = router;