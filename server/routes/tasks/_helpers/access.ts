// Permission helpers for tasks.
//
// canAccessTask    — used by status / detail / comment routes
// loadAccessibleTask — used by pass-2 routes (dependencies, criteria,
//                       blockers, hierarchy). Returns the task or sends a
//                       404/403 and returns null.

import type { Request, Response } from "express";

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

async function canAccessTask(task: any, userId: number, requesterOrgId: number | null | undefined, db: DbLike, requesterRole?: string): Promise<boolean> {
    if (!task) return false;
    if (!requesterOrgId) {
        // Users without an organization can only access their own direct tasks.
        return task.user_id === userId || task.assigned_to === userId;
    }

    const ownerRes = await db.query('SELECT team_id, org_id FROM users WHERE id = $1', [task.user_id]);
    const owner = ownerRes.rows[0];
    const taskOrgId = task.org_id || owner?.org_id || null;

    if (!taskOrgId || taskOrgId !== requesterOrgId) return false;
    if (task.user_id === userId || task.assigned_to === userId) return true;

    // Org-level admins can access any task within their org (needed for
    // service-desk tickets that get mirrored as backlog tasks for cross-team
    // triage).
    if (requesterRole === 'super_admin' || requesterRole === 'hr_admin' || requesterRole === 'platform_admin') {
        return true;
    }

    const userRes = await db.query('SELECT team_id, org_id FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user || user.org_id !== requesterOrgId) return false;
    if (!owner || owner.org_id !== requesterOrgId) return false;

    return user.team_id && owner.team_id && user.team_id === owner.team_id;
}

// Used by pass-2 routes. Slightly stricter than canAccessTask — it loads the
// task itself, sends the response on failure, and returns null.
async function loadAccessibleTask(req: Request, res: Response, taskId: number): Promise<any | null> {
    const task = (await req.db!.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
    if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
    const isOrgAdmin = ['super_admin', 'hr_admin', 'platform_admin'].includes(req.userRole as string);
    if (!isOrgAdmin && task.user_id !== req.userId && task.assigned_to !== req.userId) {
        // Fall back: allow team-mates to see the task.
        const sameTeam = (await req.db!.query(
            `SELECT 1 FROM users u WHERE u.id = $1 AND u.team_id = (SELECT team_id FROM users WHERE id = $2)`,
            [req.userId, task.user_id]
        )).rowCount > 0;
        if (!sameTeam) { res.status(403).json({ error: 'Access denied' }); return null; }
    }
    return task;
}

export = { canAccessTask, loadAccessibleTask };