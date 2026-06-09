import express from "express";
import type { Request, Response } from "express";
const auth = require("../middleware/auth");
const { loadUserContext, requireRole, requireSameOrg } = require("../middleware/rbac");
import { logAction } from "../utils/audit";

const router = express.Router();
const { requireTenant } = require("../middleware/tenant");
router.use(auth, loadUserContext, requireTenant);

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

interface PolicyRow {
    id: number;
    org_id: number;
    leave_type: string;
    annual_quota: number | string;
    accrual_type: string;
    carry_forward_limit: number | string;
    [key: string]: unknown;
}

interface BalanceRow {
    quota: number | string | null;
    used: number | string | null;
    carried_forward: number | string | null;
    [key: string]: unknown;
}

// ==================== LEAVE POLICIES (HR Admin+) ====================

router.get("/policies", requireSameOrg, async (req: Request, res: Response) => {
    try {
        // Make sure every org has the built-in Holiday policy provisioned
        // (this is the only "default" policy — every other leave type is
        // entirely org-defined). Idempotent.
        await ensureDefaultHolidayPolicy(req.userOrgId, req.db as unknown as DbLike);
        const policies = (await req.db!.query("SELECT * FROM leave_policies WHERE org_id = $1 ORDER BY leave_type", [req.userOrgId])).rows;
        res.json(policies);
    } catch (err) {
        req.log.error({ err }, "GET /policies error");
        res.status(500).json({ error: "Failed to fetch policies" });
    }
});

router.post("/policies", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const { leave_type, annual_quota, accrual_type, carry_forward_limit, half_day_allowed, quarter_day_allowed } = req.body;
        if (!leave_type) return res.status(400).json({ error: "Leave type is required" });

        const quota = Number(annual_quota) || 0;
        const cfLimit = Number(carry_forward_limit) || 0;
        if (quota < 0 || quota > 365) return res.status(400).json({ error: "Annual quota must be between 0 and 365" });
        if (cfLimit < 0 || cfLimit > 365) return res.status(400).json({ error: "Carry forward limit must be between 0 and 365" });

        const existing = (await req.db!.query("SELECT id FROM leave_policies WHERE org_id = $1 AND leave_type = $2", [req.userOrgId, leave_type])).rows[0];

        if (existing) {
            await req.db!.query(
                `UPDATE leave_policies SET annual_quota = $1, accrual_type = $2, carry_forward_limit = $3,
                 half_day_allowed = $4, quarter_day_allowed = $5 WHERE id = $6`,
                [quota, accrual_type || "annual", cfLimit, !!half_day_allowed, !!quarter_day_allowed, existing.id],
            );
            // Propagate the new quota to all existing balance rows for this leave type
            // so every employee sees the change immediately (no need to wait for their
            // next leave request to trigger initializeBalances).
            await syncOrgBalancesToPolicy(req.userOrgId, leave_type, req.db as unknown as DbLike);
            logAction(req, "update", "leave_policy", existing.id, { leave_type });
            res.json({ message: `Leave policy for ${leave_type} updated` });
        } else {
            const result = await req.db!.query(
                `INSERT INTO leave_policies (org_id, leave_type, annual_quota, accrual_type, carry_forward_limit, half_day_allowed, quarter_day_allowed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [req.userOrgId, leave_type, quota, accrual_type || "annual", cfLimit, !!half_day_allowed, !!quarter_day_allowed],
            );
            // Sync balances for any pre-existing rows of this leave_type as well
            await syncOrgBalancesToPolicy(req.userOrgId, leave_type, req.db as unknown as DbLike);
            logAction(req, "create", "leave_policy", result.rows[0].id, { leave_type, annual_quota: quota });
            res.json({ id: result.rows[0].id, message: `Leave policy for ${leave_type} created` });
        }
    } catch (err) {
        req.log.error({ err }, "POST /policies error");
        res.status(500).json({ error: "Failed to save policy" });
    }
});

router.delete("/policies/:id", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const policy = (await req.db!.query("SELECT * FROM leave_policies WHERE id = $1 AND org_id = $2", [Number(id), req.userOrgId])).rows[0];
        if (!policy) return res.status(404).json({ error: "Policy not found" });
        // The Holiday policy is built-in and auto-managed by the Holidays tab —
        // deleting it would break the holiday auto-leave behaviour. Block the
        // delete and tell the user to manage holidays directly instead.
        if (String(policy.leave_type).toLowerCase() === "holiday") {
            return res.status(400).json({
                error: "The Holiday policy is built-in and cannot be deleted. Manage company holidays from the Holidays tab.",
            });
        }

        // Wrap policy deletion + cascade cleanup in a transaction so we never
        // leave the org in a half-deleted state where the policy is gone but
        // employees still see balances/leaves for a leave type that no longer
        // exists in the org's taxonomy.
        const result = await (req.db as unknown as DbLike).transaction<{ balances: number; leaves: number }>(async (client: any) => {
            // Drop balance rows for every employee in the org for this leave type
            const balDel = await client.query(
                `DELETE FROM leave_balances lb
                 USING users u
                 WHERE lb.user_id = u.id
                   AND u.org_id = $1
                   AND lb.leave_type = $2`,
                [req.userOrgId, policy.leave_type],
            );
            // Drop any leave records (pending / approved / etc.) for this type
            const leaveDel = await client.query(
                `DELETE FROM leaves l
                 USING users u
                 WHERE l.user_id = u.id
                   AND u.org_id = $1
                   AND l.leave_type = $2`,
                [req.userOrgId, policy.leave_type],
            );
            await client.query("DELETE FROM leave_policies WHERE id = $1", [Number(id)]);
            return { balances: balDel.rowCount, leaves: leaveDel.rowCount };
        });

        logAction(req, "delete", "leave_policy", Number(id), {
            leave_type: policy.leave_type,
            balances_removed: result.balances,
            leaves_removed: result.leaves,
        });
        res.json({
            message: `Policy deleted (also removed ${result.balances} balance row(s) and ${result.leaves} leave record(s))`,
        });
    } catch (err) {
        req.log.error({ err }, "DELETE /policies/:id error");
        res.status(500).json({ error: "Failed to delete policy" });
    }
});

// ==================== LEAVE BALANCES ====================

router.get("/balances", async (req: Request, res: Response) => {
    try {
        const year = parseInt(req.query.year as string) || new Date().getFullYear();
        if (req.userOrgId) {
            // Make sure the built-in Holiday policy exists before we provision
            // balance rows, so every employee always has a Holiday balance.
            await ensureDefaultHolidayPolicy(req.userOrgId, req.db as unknown as DbLike);
            // Clear out any orphan balance rows whose policy no longer exists
            // (e.g. policy deleted before the cascade-cleanup fix shipped) so
            // the user never sees ghost leave types in the UI.
            await pruneOrphanBalances(req.userOrgId, req.db as unknown as DbLike);
            await initializeBalances(req.userId!, req.userOrgId, year, req.db as unknown as DbLike);
            // Recompute Holiday `used` from real personal-holiday leaves only —
            // public holidays auto-booked by HR shouldn't deplete anyone's
            // quota. Idempotent, fixes any inflated counts left by older code.
            await recalcHolidayUsed(req.userId!, year, req.db as unknown as DbLike);
        }

        // Only return balances that still have a matching policy in the org.
        // Joining via leave_policies guarantees we filter ghosts even if
        // pruneOrphanBalances was skipped (e.g. user has no org).
        const balances = req.userOrgId
            ? (await req.db!.query(
                `SELECT lb.*
                 FROM leave_balances lb
                 JOIN leave_policies lp
                   ON lp.leave_type = lb.leave_type AND lp.org_id = $3
                 WHERE lb.user_id = $1 AND lb.year = $2
                 ORDER BY lb.leave_type ASC`,
                [req.userId, year, req.userOrgId],
            )).rows
            : (await req.db!.query(
                "SELECT * FROM leave_balances WHERE user_id = $1 AND year = $2",
                [req.userId, year],
            )).rows;
        // pg returns NUMERIC as strings — cast so the frontend never accidentally
        // does '8' + '0' = '80' (string concatenation).
        res.json(balances.map(numericBalance));
    } catch (err) {
        req.log.error({ err }, "GET /balances error");
        res.status(500).json({ error: "Failed to fetch balances" });
    }
});

router.get("/balances/:userId", requireRole("team_lead"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const targetUserId = Number(req.params.userId);
        const year = parseInt(req.query.year as string) || new Date().getFullYear();

        const targetUser = (await req.db!.query("SELECT org_id FROM users WHERE id = $1", [targetUserId])).rows[0];
        if (!targetUser || targetUser.org_id !== req.userOrgId) {
            return res.status(403).json({ error: "Cannot view balances for users outside your organization" });
        }

        // Same provisioning steps as GET /balances — built-in Holiday policy,
        // orphan cleanup, then make sure rows exist for the requested year,
        // then make sure Holiday `used` reflects only personal-holiday leaves.
        await ensureDefaultHolidayPolicy(req.userOrgId, req.db as unknown as DbLike);
        await pruneOrphanBalances(req.userOrgId, req.db as unknown as DbLike);
        await initializeBalances(targetUserId, req.userOrgId!, year, req.db as unknown as DbLike);
        await recalcHolidayUsed(targetUserId, year, req.db as unknown as DbLike);

        const balances = (await req.db!.query(
            `SELECT lb.*
             FROM leave_balances lb
             JOIN leave_policies lp
               ON lp.leave_type = lb.leave_type AND lp.org_id = $3
             WHERE lb.user_id = $1 AND lb.year = $2
             ORDER BY lb.leave_type ASC`,
            [targetUserId, year, req.userOrgId],
        )).rows;
        res.json(balances.map(numericBalance));
    } catch (err) {
        req.log.error({ err }, "GET /balances/:userId error");
        res.status(500).json({ error: "Failed to fetch balances" });
    }
});

router.put("/balances/:userId", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const targetUserId = Number(req.params.userId);
        const { leave_type, year, quota, carried_forward } = req.body;

        if (!leave_type || !year) return res.status(400).json({ error: "Leave type and year are required" });

        const targetUser = (await req.db!.query("SELECT org_id FROM users WHERE id = $1", [targetUserId])).rows[0];
        if (!targetUser || targetUser.org_id !== req.userOrgId) {
            return res.status(403).json({ error: "Cannot modify balances for users outside your organization" });
        }

        const existing = (await req.db!.query(
            "SELECT id FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3",
            [targetUserId, leave_type, year],
        )).rows[0];

        if (existing) {
            const updates: string[] = [];
            const params: unknown[] = [];
            let pi = 1;
            if (quota !== undefined) { updates.push(`quota = $${pi++}`); params.push(quota); }
            if (carried_forward !== undefined) { updates.push(`carried_forward = $${pi++}`); params.push(carried_forward); }
            if (updates.length === 0) return res.status(400).json({ error: "No fields to update. Provide quota or carried_forward." });
            params.push(existing.id);
            await req.db!.query(`UPDATE leave_balances SET ${updates.join(", ")} WHERE id = $${pi}`, params);
        } else {
            await req.db!.query(
                "INSERT INTO leave_balances (user_id, leave_type, year, quota, carried_forward) VALUES ($1, $2, $3, $4, $5)",
                [targetUserId, leave_type, year, quota || 0, carried_forward || 0],
            );
        }

        logAction(req, "update_balance", "leave_balance", targetUserId, { leave_type, year, quota, carried_forward });
        res.json({ message: "Balance updated" });
    } catch (err) {
        req.log.error({ err }, "PUT /balances/:userId error");
        res.status(500).json({ error: "Failed to update balance" });
    }
});

// ==================== COMPANY HOLIDAYS ====================

router.get("/holidays", requireSameOrg, async (req: Request, res: Response) => {
    try {
        const y = parseInt(req.query.year as string) || new Date().getFullYear();
        const holidays = (await req.db!.query(
            `SELECT * FROM holidays WHERE org_id = $1 AND date LIKE $2 ORDER BY date ASC`,
            [req.userOrgId, `${y}-%`],
        )).rows;
        res.json(holidays);
    } catch (err) {
        req.log.error({ err }, "GET /holidays error");
        res.status(500).json({ error: "Failed to fetch holidays" });
    }
});

router.post("/holidays", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const { date, name, is_optional } = req.body;
        if (!date || !name) return res.status(400).json({ error: "Date and name are required" });

        // Make sure the built-in Holiday policy exists before we book leaves.
        await ensureDefaultHolidayPolicy(req.userOrgId, req.db as unknown as DbLike);

        const inserted = await (req.db as unknown as DbLike).transaction<{ id: number; leavesCreated: number }>(async (client: any) => {
            const r = await client.query(
                "INSERT INTO holidays (org_id, date, name, is_optional) VALUES ($1, $2, $3, $4) RETURNING id",
                [req.userOrgId, date, name.trim(), !!is_optional],
            );
            // Auto-book this holiday as an approved Holiday leave for every
            // active employee in the org. Optional holidays are skipped — they
            // require employees to opt-in via the normal leave-request flow.
            const leavesCreated = is_optional
                ? 0
                : await bookHolidayLeavesForOrg(req.userOrgId!, date, name.trim(), req.userId!, client);
            return { id: r.rows[0].id, leavesCreated };
        });

        logAction(req, "create", "holiday", inserted.id, {
            date, name: name.trim(), auto_leaves_booked: inserted.leavesCreated,
        });
        res.json({
            id: inserted.id,
            message: is_optional
                ? "Optional holiday added"
                : `Holiday added — auto-booked Holiday leave for ${inserted.leavesCreated} employee(s)`,
        });
    } catch (err) {
        if ((err as { code?: string }).code === "23505") return res.status(400).json({ error: "Holiday already exists on this date" });
        req.log.error({ err }, "POST /holidays error");
        res.status(500).json({ error: "Failed to add holiday" });
    }
});

router.post("/holidays/batch", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const { holidays } = req.body;
        if (!holidays || !Array.isArray(holidays)) return res.status(400).json({ error: "Holidays array is required" });

        await ensureDefaultHolidayPolicy(req.userOrgId, req.db as unknown as DbLike);

        const result = await (req.db as unknown as DbLike).transaction<{ added: number; leavesBooked: number }>(async (client: any) => {
            let added = 0;
            let leavesBooked = 0;
            for (const h of holidays) {
                if (h.date && h.name) {
                    const r = await client.query(
                        "INSERT INTO holidays (org_id, date, name, is_optional) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id",
                        [req.userOrgId, h.date, h.name.trim(), !!h.is_optional],
                    );
                    if (r.rowCount > 0) {
                        added++;
                        if (!h.is_optional) {
                            leavesBooked += await bookHolidayLeavesForOrg(
                                req.userOrgId!, h.date, h.name.trim(), req.userId!, client,
                            );
                        }
                    }
                }
            }
            return { added, leavesBooked };
        });

        logAction(req, "batch_create", "holiday", null, {
            count: result.added, auto_leaves_booked: result.leavesBooked,
        });
        res.json({
            message: `${result.added} holiday(s) added — auto-booked ${result.leavesBooked} Holiday leave(s)`,
        });
    } catch (err) {
        req.log.error({ err }, "POST /holidays/batch error");
        res.status(500).json({ error: "Failed to add holidays" });
    }
});

router.delete("/holidays/:id", requireRole("hr_admin"), requireSameOrg, async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const holiday = (await req.db!.query("SELECT * FROM holidays WHERE id = $1 AND org_id = $2", [Number(id), req.userOrgId])).rows[0];
        if (!holiday) return res.status(404).json({ error: "Holiday not found" });

        // Roll back any auto-booked Holiday leaves for this date so the
        // employees' "used" count goes back to what it was before the holiday
        // was added.
        const removed = await (req.db as unknown as DbLike).transaction<number>(async (client: any) => {
            const cleared = await unbookHolidayLeavesForOrg(req.userOrgId!, holiday.date, client);
            await client.query("DELETE FROM holidays WHERE id = $1", [Number(id)]);
            return cleared;
        });

        logAction(req, "delete", "holiday", Number(id), {
            name: holiday.name, date: holiday.date, auto_leaves_removed: removed,
        });
        res.json({ message: `Holiday deleted — removed ${removed} auto-booked Holiday leave(s)` });
    } catch (err) {
        req.log.error({ err }, "DELETE /holidays/:id error");
        res.status(500).json({ error: "Failed to delete holiday" });
    }
});

// ==================== HELPERS ====================

/**
 * Make sure the org has the built-in Holiday policy, and only one of it.
 * Idempotent and cheap to run on every fetch.
 */
async function ensureDefaultHolidayPolicy(orgId: number | null | undefined, db: DbLike): Promise<PolicyRow | null> {
    if (!orgId) return null;
    return db.transaction(async (client: any) => {
        // All policies in the org that *look like* the holiday policy.
        const matches = (await client.query(
            `SELECT * FROM leave_policies
              WHERE org_id = $1 AND LOWER(leave_type) LIKE 'holiday%'
              ORDER BY id ASC`,
            [orgId],
        )).rows;

        if (matches.length === 0) {
            const inserted = (await client.query(
                `INSERT INTO leave_policies
                    (org_id, leave_type, name, color, annual_quota, accrual_type,
                     carry_forward_limit, half_day_allowed, quarter_day_allowed)
                 VALUES ($1, 'holiday', 'Holiday', '#f59e0b', 0, 'annual', 0, FALSE, FALSE)
                 RETURNING *`,
                [orgId],
            )).rows[0];
            return inserted;
        }

        // Pick the oldest as the canonical Holiday policy and normalise it.
        const survivor = matches[0];
        await client.query(
            `UPDATE leave_policies
                SET leave_type = 'holiday',
                    name       = COALESCE(NULLIF(TRIM(name), ''), 'Holiday')
              WHERE id = $1`,
            [survivor.id],
        );

        // Move balances and leaves from the duplicates onto the survivor and
        // then delete the duplicate policy rows.
        const dupes = matches.slice(1);
        for (const dup of dupes) {
            await client.query(
                `INSERT INTO leave_balances (user_id, leave_type, year, quota, used, carried_forward)
                 SELECT lb.user_id, 'holiday', lb.year, lb.quota, lb.used, lb.carried_forward
                 FROM leave_balances lb
                 JOIN users u ON u.id = lb.user_id
                 WHERE u.org_id = $1 AND lb.leave_type = $2
                 ON CONFLICT (user_id, leave_type, year) DO UPDATE
                    SET used = leave_balances.used + EXCLUDED.used`,
                [orgId, dup.leave_type],
            );
            await client.query(
                `DELETE FROM leave_balances lb
                 USING users u
                 WHERE lb.user_id = u.id AND u.org_id = $1 AND lb.leave_type = $2`,
                [orgId, dup.leave_type],
            );
            // Re-point leave records to the canonical 'holiday' slug.
            await client.query(
                `UPDATE leaves l
                    SET leave_type = 'holiday'
                  FROM users u
                 WHERE l.user_id = u.id AND u.org_id = $1 AND l.leave_type = $2`,
                [orgId, dup.leave_type],
            );
            await client.query("DELETE FROM leave_policies WHERE id = $1", [dup.id]);
        }

        const final = (await client.query(
            "SELECT * FROM leave_policies WHERE id = $1",
            [survivor.id],
        )).rows[0];
        return final;
    });
}

/**
 * Auto-book an approved "holiday" leave on `date` for every active employee
 * in the org. Returns the number of leave rows that were inserted.
 */
async function bookHolidayLeavesForOrg(orgId: number, date: string, name: string, actorId: number | null, client: any): Promise<number> {
    if (!orgId || !date) return 0;
    const inserted = (await client.query(
        `INSERT INTO leaves
            (user_id, leave_type, date, duration, reason, status, approved_by, reviewed_at)
         SELECT u.id, 'holiday', $2, 'full', $3, 'approved', $4, NOW()
         FROM users u
         WHERE u.org_id = $1
           AND u.is_active = TRUE
           AND NOT EXISTS (
               SELECT 1 FROM leaves l
               WHERE l.user_id = u.id AND l.date = $2
           )
         RETURNING user_id`,
        [orgId, date, `Public holiday: ${name}`, actorId || null],
    )).rows;
    if (inserted.length === 0) return 0;

    // Make sure every affected user has a Holiday balance row for this year
    // (so the card shows up for them) — but DO NOT increment `used`.
    const year = parseInt(String(date).slice(0, 4), 10);
    const userIds = inserted.map((r: { user_id: number }) => r.user_id);
    await client.query(
        `INSERT INTO leave_balances (user_id, leave_type, year, quota, used, carried_forward)
         SELECT uid, 'holiday', $2, 0, 0, 0 FROM unnest($1::int[]) AS uid
         ON CONFLICT (user_id, leave_type, year) DO NOTHING`,
        [userIds, year],
    );

    return inserted.length;
}

/**
 * Inverse of bookHolidayLeavesForOrg — when an admin deletes a holiday we
 * remove the auto-booked Holiday leave rows for that date.
 */
async function unbookHolidayLeavesForOrg(orgId: number, date: string, client: any): Promise<number> {
    if (!orgId || !date) return 0;
    const removed = (await client.query(
        `DELETE FROM leaves l
         USING users u
         WHERE l.user_id = u.id
           AND u.org_id = $1
           AND l.date = $2
           AND l.leave_type = 'holiday'
           AND l.status = 'approved'
           AND l.reason LIKE 'Public holiday:%'
         RETURNING l.user_id`,
        [orgId, date],
    )).rows;
    return removed.length;
}

/**
 * Recompute the Holiday `used` count for a given user/year from the leaves
 * table, counting only personal Holiday leaves.
 */
async function recalcHolidayUsed(userId: number, year: number, db: DbLike): Promise<void> {
    if (!userId || !year) return;
    await db.query(
        `UPDATE leave_balances lb
            SET used = COALESCE((
                SELECT SUM(CASE l.duration
                    WHEN 'half'    THEN 0.5
                    WHEN 'quarter' THEN 0.25
                    ELSE                1
                END)
                FROM leaves l
                WHERE l.user_id = $1
                  AND l.leave_type = 'holiday'
                  AND l.status = 'approved'
                  AND l.date LIKE $2
                  AND (l.reason IS NULL OR l.reason NOT LIKE 'Public holiday:%')
            ), 0)
          WHERE lb.user_id = $1
            AND lb.leave_type = 'holiday'
            AND lb.year = $3`,
        [userId, `${year}-%`, year],
    );
}

/**
 * Delete any leave_balances rows in the org whose leave_type no longer has a
 * matching policy.
 */
async function pruneOrphanBalances(orgId: number | null | undefined, db: DbLike): Promise<void> {
    if (!orgId) return;
    await db.query(
        `DELETE FROM leave_balances lb
         USING users u
         WHERE lb.user_id = u.id
           AND u.org_id = $1
           AND NOT EXISTS (
               SELECT 1 FROM leave_policies lp
               WHERE lp.org_id = $1 AND lp.leave_type = lb.leave_type
           )`,
        [orgId],
    );
}

/**
 * pg returns NUMERIC columns as strings. Coerce numeric balance fields before
 * sending to the client.
 */
function numericBalance(row: BalanceRow | null): BalanceRow | null {
    if (!row) return row;
    return {
        ...row,
        quota: row.quota == null ? 0 : Number(row.quota),
        used: row.used == null ? 0 : Number(row.used),
        carried_forward: row.carried_forward == null ? 0 : Number(row.carried_forward),
    };
}

/**
 * Provision balance rows for the user/year, AND keep their `quota` in sync
 * with the latest organisation policy.
 */
async function initializeBalances(userId: number, orgId: number | null | undefined, year: number, db: DbLike): Promise<void> {
    if (!orgId) return;
    const policies = (await db.query("SELECT * FROM leave_policies WHERE org_id = $1", [orgId])).rows as PolicyRow[];

    for (const policy of policies) {
        // pg returns NUMERIC as strings — coerce so arithmetic below isn't string concat.
        const policyQuota = Number(policy.annual_quota) || 0;
        const cfLimit = Number(policy.carry_forward_limit) || 0;
        let carryForward = 0;
        if (cfLimit > 0) {
            const prevBalance = (await db.query(
                "SELECT quota, used, carried_forward FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3",
                [userId, policy.leave_type, year - 1],
            )).rows[0] as BalanceRow | undefined;
            if (prevBalance) {
                const prevQuota = Number(prevBalance.quota) || 0;
                const prevUsed = Number(prevBalance.used) || 0;
                const prevCarry = Number(prevBalance.carried_forward) || 0;
                const remaining = (prevQuota + prevCarry) - prevUsed;
                carryForward = Math.min(Math.max(remaining, 0), cfLimit);
            }
        }
        // INSERT new row OR sync the quota of an existing row.
        await db.query(
            `INSERT INTO leave_balances (user_id, leave_type, year, quota, carried_forward)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, leave_type, year)
             DO UPDATE SET quota = EXCLUDED.quota`,
            [userId, policy.leave_type, year, policyQuota, carryForward],
        );
    }
}

/**
 * Re-synchronise every existing balance row in the org for the given year
 * with the current policy quotas.
 */
async function syncOrgBalancesToPolicy(orgId: number | null | undefined, leaveType: string, db: DbLike): Promise<void> {
    if (!orgId || !leaveType) return;
    const policy = (await db.query(
        "SELECT annual_quota FROM leave_policies WHERE org_id = $1 AND leave_type = $2",
        [orgId, leaveType],
    )).rows[0];
    if (!policy) return;
    await db.query(
        `UPDATE leave_balances lb SET quota = $1
         FROM users u
         WHERE u.id = lb.user_id AND u.org_id = $2 AND lb.leave_type = $3`,
        [policy.annual_quota, orgId, leaveType],
    );
}

function getAccruedQuota(policy: PolicyRow, year: number, fiscalYearStart?: number): number {
    const fys = fiscalYearStart || 1; // default January
    const now = new Date();
    const currentYear = now.getFullYear();
    const annualQuota = Number(policy.annual_quota) || 0;
    if (year !== currentYear) return annualQuota;
    switch (policy.accrual_type) {
        case "monthly": {
            // Months elapsed since fiscal year start
            const currentMonth = now.getMonth() + 1;
            const monthsElapsed = currentMonth >= fys
                ? currentMonth - fys + 1
                : 12 - fys + currentMonth + 1;
            return Math.round((annualQuota / 12) * monthsElapsed * 100) / 100;
        }
        case "quarterly": {
            const currentMonth = now.getMonth() + 1;
            const monthsElapsed = currentMonth >= fys
                ? currentMonth - fys + 1
                : 12 - fys + currentMonth + 1;
            const quarter = Math.ceil(monthsElapsed / 3);
            return Math.round((annualQuota / 4) * quarter * 100) / 100;
        }
        default:
            return annualQuota;
    }
}

// Attach helper exports consumed by routes/leaves.js (and tests).
type RouterWithHelpers = typeof router & {
    initializeBalances: typeof initializeBalances;
    getAccruedQuota: typeof getAccruedQuota;
    syncOrgBalancesToPolicy: typeof syncOrgBalancesToPolicy;
    pruneOrphanBalances: typeof pruneOrphanBalances;
    ensureDefaultHolidayPolicy: typeof ensureDefaultHolidayPolicy;
    bookHolidayLeavesForOrg: typeof bookHolidayLeavesForOrg;
    recalcHolidayUsed: typeof recalcHolidayUsed;
};

const routerWithHelpers = router as RouterWithHelpers;
routerWithHelpers.initializeBalances = initializeBalances;
routerWithHelpers.getAccruedQuota = getAccruedQuota;
routerWithHelpers.syncOrgBalancesToPolicy = syncOrgBalancesToPolicy;
routerWithHelpers.pruneOrphanBalances = pruneOrphanBalances;
routerWithHelpers.ensureDefaultHolidayPolicy = ensureDefaultHolidayPolicy;
routerWithHelpers.bookHolidayLeavesForOrg = bookHolidayLeavesForOrg;
routerWithHelpers.recalcHolidayUsed = recalcHolidayUsed;

export = routerWithHelpers;