// Project CRUD — Stage 3.
//
//   GET    /api/projects             — list (active by default; `?include_archived=1`)
//   POST   /api/projects             — create (manager+)
//   GET    /api/projects/:id         — single project
//   PUT    /api/projects/:id         — update (manager+)
//   PATCH  /api/projects/:id/archive — archive / unarchive (manager+)
//   DELETE /api/projects/:id         — delete (super_admin only, only if empty)
//   GET    /api/projects/:id/tasks   — list tasks in this project

import express from "express";
import type { Request, Response } from "express";
const auth = require("../middleware/auth");
const { loadUserContext, requireRole } = require("../middleware/rbac");
const { requireTenant, requireFeature } = require("../middleware/tenant");
const { logAction } = require("../utils/audit");
const { enrichTasks } = require("./tasks/_helpers/enrich");

const router = express.Router();
// Projects are part of the Agile feature bundle — same gate as /api/agile
// and /api/sprints. Without this, a Standard-plan tenant could create
// projects through the API even though the UI hides the section.
router.use(requireTenant, requireFeature("agile"));

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

const KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;

// ─── List projects in the requester's org ─────────────────────────────────
//
// Returns a plain array by default (back-compat with callers that expected
// the original shape). When `?paginate=1` is supplied, returns
// `{ projects, pagination: { limit, offset, total, hasMore } }` so the
// Projects admin page can render page controls without a second round-trip
// for the total count.
router.get("/", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const paginate = req.query.paginate === "1";
        if (!req.userOrgId) {
            return paginate
                ? res.json({ projects: [], pagination: { limit: 0, offset: 0, total: 0, hasMore: false } })
                : res.json([]);
        }
        const includeArchived = req.query.include_archived === "1";
        // Sensible caps — page sizes much above 200 defeat the purpose.
        const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit), 10) || 50));
        const offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);

        const baseWhere = `WHERE p.org_id = $1 ${includeArchived ? "" : "AND p.is_archived = FALSE"}`;
        const orderBy = "ORDER BY p.is_archived ASC, LOWER(p.name) ASC";

        if (!paginate) {
            // Legacy mode — return every matching row as a plain array.
            const rows = (await req.db!.query(
                `SELECT p.*, u.full_name AS lead_name, u.username AS lead_username,
                        (SELECT COUNT(*)::int FROM tasks WHERE project_id = p.id) AS task_count
                   FROM projects p
              LEFT JOIN users u ON u.id = p.lead_user_id
                   ${baseWhere}
                   ${orderBy}`,
                [req.userOrgId]
            )).rows;
            return res.json(rows);
        }

        const [pageRes, countRes] = await Promise.all([
            req.db!.query(
                `SELECT p.*, u.full_name AS lead_name, u.username AS lead_username,
                        (SELECT COUNT(*)::int FROM tasks WHERE project_id = p.id) AS task_count
                   FROM projects p
              LEFT JOIN users u ON u.id = p.lead_user_id
                   ${baseWhere}
                   ${orderBy}
                   LIMIT $2 OFFSET $3`,
                [req.userOrgId, limit, offset]
            ),
            req.db!.query(`SELECT COUNT(*)::int AS total FROM projects p ${baseWhere}`, [req.userOrgId]),
        ]);
        const projects = pageRes.rows;
        const total = countRes.rows[0]?.total ?? projects.length;
        res.json({
            projects,
            pagination: { limit, offset, total, hasMore: offset + projects.length < total },
        });
    } catch (err) {
        req.log.error({ err }, "Failed to list projects");
        res.status(500).json({ error: "Failed to list projects" });
    }
});

// ─── Create project ──────────────────────────────────────────────────────
router.post("/", auth, loadUserContext, requireRole("manager"), async (req: Request, res: Response) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: "Organization required" });
        const { key, name, description, color, lead_user_id } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: "Project name is required" });
        if (!key || !KEY_RE.test(String(key))) {
            return res.status(400).json({
                error: "Project key must be 2–10 uppercase letters/digits/underscores starting with a letter (e.g. PSSPMT).",
            });
        }
        const upperKey = String(key).toUpperCase();
        const dup = await req.db!.query("SELECT id FROM projects WHERE org_id = $1 AND key = $2", [req.userOrgId, upperKey]);
        if (dup.rowCount > 0) return res.status(409).json({ error: "A project with this key already exists" });
        const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#6366f1";
        let validLead = null;
        if (lead_user_id) {
            const leadNum = parseInt(lead_user_id, 10);
            if (!isNaN(leadNum)) {
                const lead = (await req.db!.query("SELECT id FROM users WHERE id = $1 AND org_id = $2 AND is_active = TRUE", [leadNum, req.userOrgId])).rows[0];
                if (lead) validLead = lead.id;
            }
        }
        const inserted = (await req.db!.query(
            `INSERT INTO projects (org_id, key, name, description, color, lead_user_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [req.userOrgId, upperKey, name.trim().slice(0, 200), description?.slice(0, 2000) || null,
                validColor, validLead, req.userId]
        )).rows[0];
        logAction(req, "create", "project", inserted.id, { key: upperKey, name: inserted.name });
        res.json(inserted);
    } catch (err) {
        req.log.error({ err }, "Failed to create project");
        res.status(500).json({ error: "Failed to create project" });
    }
});

// ─── Get one project ─────────────────────────────────────────────────────
router.get("/:id", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid project id" });
        const row = (await req.db!.query(
            `SELECT p.*, u.full_name AS lead_name, u.username AS lead_username,
                    (SELECT COUNT(*)::int FROM tasks WHERE project_id = p.id) AS task_count
               FROM projects p
          LEFT JOIN users u ON u.id = p.lead_user_id
              WHERE p.id = $1 AND p.org_id = $2`,
            [id, req.userOrgId]
        )).rows[0];
        if (!row) return res.status(404).json({ error: "Project not found" });
        res.json(row);
    } catch (err) {
        req.log.error({ err }, "Failed to fetch project");
        res.status(500).json({ error: "Failed to fetch project" });
    }
});

// ─── Update project ──────────────────────────────────────────────────────
router.put("/:id", auth, loadUserContext, requireRole("manager"), async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid project id" });
        const existing = (await req.db!.query("SELECT * FROM projects WHERE id = $1 AND org_id = $2", [id, req.userOrgId])).rows[0];
        if (!existing) return res.status(404).json({ error: "Project not found" });
        // KEY is immutable post-creation — changing it would orphan every
        // existing PROJ-123 reference (branches, commit messages, history).
        const { name, description, color, lead_user_id } = req.body || {};
        const newName = name?.trim() || existing.name;
        const newDesc = description !== undefined ? (description?.slice(0, 2000) || null) : existing.description;
        const newColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : existing.color;
        let newLead = existing.lead_user_id;
        if (lead_user_id !== undefined) {
            if (lead_user_id === null || lead_user_id === "") {
                newLead = null;
            } else {
                const leadNum = parseInt(lead_user_id, 10);
                if (!isNaN(leadNum)) {
                    const lead = (await req.db!.query("SELECT id FROM users WHERE id = $1 AND org_id = $2 AND is_active = TRUE", [leadNum, req.userOrgId])).rows[0];
                    if (lead) newLead = lead.id;
                }
            }
        }
        const updated = (await req.db!.query(
            `UPDATE projects
                SET name = $1, description = $2, color = $3, lead_user_id = $4, updated_at = NOW()
              WHERE id = $5
              RETURNING *`,
            [newName, newDesc, newColor, newLead, id]
        )).rows[0];
        logAction(req, "update", "project", id, { name: newName });
        res.json(updated);
    } catch (err) {
        req.log.error({ err }, "Failed to update project");
        res.status(500).json({ error: "Failed to update project" });
    }
});

// ─── Archive / unarchive ─────────────────────────────────────────────────
router.patch("/:id/archive", auth, loadUserContext, requireRole("manager"), async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid project id" });
        const archived = !!req.body?.is_archived;
        const r = await req.db!.query(
            "UPDATE projects SET is_archived = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3 RETURNING *",
            [archived, id, req.userOrgId]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: "Project not found" });
        logAction(req, archived ? "archive" : "unarchive", "project", id, null);
        res.json(r.rows[0]);
    } catch (err) {
        req.log.error({ err }, "Failed to archive project");
        res.status(500).json({ error: "Failed to archive project" });
    }
});

// ─── Delete (super_admin only) ───────────────────────────────────────────
//
// By default the endpoint refuses if any tasks still belong to the project,
// to protect against accidental data loss. A super_admin can override that
// with `?force=1`, which detaches every task from the project (project_id
// and task_number set to NULL — the tickets themselves stay; only their
// issue key disappears). External references like branches/commits that
// already mention `PROJ-N` will of course no longer resolve, which is the
// whole reason we discourage this — but it's the right escape hatch when
// a project was created by mistake.
router.delete("/:id", auth, loadUserContext, requireRole("super_admin"), async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid project id" });
        const existing = (await req.db!.query("SELECT key FROM projects WHERE id = $1 AND org_id = $2", [id, req.userOrgId])).rows[0];
        if (!existing) return res.status(404).json({ error: "Project not found" });
        const force = req.query.force === "1" || req.body?.force === true;
        const taskCount = (await req.db!.query("SELECT COUNT(*)::int AS c FROM tasks WHERE project_id = $1", [id])).rows[0].c;
        if (taskCount > 0 && !force) {
            return res.status(409).json({
                error: `Cannot delete project: ${taskCount} task(s) still belong to it. Archive instead, or move/delete the tasks first, or retry with force=1 to detach them.`,
                task_count: taskCount,
                code: "PROJECT_NOT_EMPTY",
            });
        }
        // Wrap detach + delete in a single transaction so a failure between
        // them can't leave the project gone with task_number references still
        // pointing into nowhere.
        await (req.db as unknown as DbLike).transaction(async (client) => {
            if (taskCount > 0) {
                await client.query(
                    "UPDATE tasks SET project_id = NULL, task_number = NULL WHERE project_id = $1",
                    [id]
                );
            }
            await client.query("DELETE FROM projects WHERE id = $1", [id]);
        });
        logAction(req, "delete", "project", id, {
            key: existing.key,
            detached_tasks: taskCount,
            forced: force && taskCount > 0,
        });
        res.json({ ok: true, detached_tasks: taskCount });
    } catch (err) {
        req.log.error({ err }, "Failed to delete project");
        res.status(500).json({ error: "Failed to delete project" });
    }
});

// ─── Tasks in a project (paginated list) ─────────────────────────────────
router.get("/:id/tasks", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid project id" });
        const proj = (await req.db!.query("SELECT id FROM projects WHERE id = $1 AND org_id = $2", [id, req.userOrgId])).rows[0];
        if (!proj) return res.status(404).json({ error: "Project not found" });
        const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit), 10) || 25));
        const offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
        const [tasksRes, countRes] = await Promise.all([
            req.db!.query(
                `SELECT t.* FROM tasks t
                  WHERE t.project_id = $1
                  ORDER BY t.task_number ASC NULLS LAST
                  LIMIT $2 OFFSET $3`,
                [id, limit, offset]
            ),
            req.db!.query(`SELECT COUNT(*)::int AS total FROM tasks WHERE project_id = $1`, [id]),
        ]);
        const tasks = tasksRes.rows;
        const total = countRes.rows[0]?.total ?? tasks.length;
        const enriched = await enrichTasks(tasks, req.db);
        res.json({
            tasks: enriched,
            pagination: { limit, offset, total, hasMore: offset + enriched.length < total },
        });
    } catch (err) {
        req.log.error({ err }, "Failed to list project tasks");
        res.status(500).json({ error: "Failed to list project tasks" });
    }
});

export = router;