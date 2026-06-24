/**
 * Sprint lifecycle scheduler.
 *
 * Industry-standard automated sprint cadence. For every team that has opted
 * into AUTO mode (`teams.sprint_mode = 'auto'`) and configured a duration +
 * start date, this engine keeps a single `active` sprint row in lock-step with
 * the configured cadence:
 *
 *   1. Computes the current sprint window from `sprint_start_date` +
 *      `sprint_duration_weeks` (the same math the read-only sprint-config
 *      endpoint used to surface, now made authoritative).
 *   2. Ensures the current window's sprint row EXISTS and is `active`
 *      (auto-creating it the first time the window opens).
 *   3. When the previous auto sprint's window has ended, it:
 *        - takes a final burndown snapshot,
 *        - computes velocity (= completed story points),
 *        - marks it `completed`,
 *        - ROLLS incomplete (non-terminal) tickets into the NEW sprint,
 *          stamping `tasks.carried_over_from_sprint_id` so Sprint Insights can
 *          show a "Carried Forward" list that links back to the origin sprint,
 *        - links the new sprint via `carried_from_sprint_id`.
 *   4. Teams that are PAUSED (`teams.sprint_paused = true`) or in MANUAL mode
 *      are skipped entirely — manual lifecycle stays under human control.
 *
 * The job is idempotent and concurrency-safe: it keys auto sprints by
 * `(team_id, sprint_number)` (unique index) so a double-run can never create
 * duplicate windows.
 *
 * Exposed as `runSprintLifecycle({ db, tenantId })` so it can be driven by the
 * background job runner (per tenant) and unit-tested directly with a mock db.
 */
import { logger } from "../utils/logger";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
interface Db { query: Query; }

const DAY_MS = 86400000;

/** Parse a YYYY-MM-DD string into a UTC-midnight epoch ms. */
function parseDateUTC(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
}

/** Format an epoch ms as YYYY-MM-DD (UTC). */
function fmtDateUTC(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface SprintWindow {
    number: number;
    startDate: string;
    endDate: string;
    durationWeeks: number;
    /** Days remaining until the end of this window (>= 0). */
    daysRemaining: number;
}

/**
 * Compute the sprint window that contains `today` for a team configured with
 * `startDate` (YYYY-MM-DD) and `durationWeeks`. Sprint numbers are 1-based.
 * If today is before the configured start date, returns window #1 (the upcoming
 * sprint) so the scheduler can pre-create it.
 */
export function computeCurrentWindow(startDate: string, durationWeeks: number, today: string): SprintWindow {
    const durationDays = Math.max(1, durationWeeks) * 7;
    const startMs = parseDateUTC(startDate);
    const todayMs = parseDateUTC(today);
    const daysSinceStart = Math.floor((todayMs - startMs) / DAY_MS);
    const number = daysSinceStart < 0 ? 1 : Math.floor(daysSinceStart / durationDays) + 1;
    const windowStartMs = startMs + (number - 1) * durationDays * DAY_MS;
    const windowEndMs = windowStartMs + (durationDays - 1) * DAY_MS;
    return {
        number,
        startDate: fmtDateUTC(windowStartMs),
        endDate: fmtDateUTC(windowEndMs),
        durationWeeks,
        daysRemaining: Math.max(0, Math.ceil((windowEndMs - todayMs) / DAY_MS)),
    };
}

/** Take a daily burndown snapshot for a sprint (UPSERT on (sprint_id, date)). */
async function snapshotBurndown(db: Db, sprintId: number): Promise<void> {
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

/**
 * Complete an auto sprint: snapshot, compute velocity, mark completed, and roll
 * incomplete tickets into `nextSprintId` (stamping carry-over provenance).
 * Returns the number of tickets rolled over.
 */
async function completeAndRollover(db: Db, sprintId: number, nextSprintId: number): Promise<number> {
    await snapshotBurndown(db, sprintId);

    const velocityRow = (await db.query(
        `SELECT COALESCE(SUM(t.story_points), 0)::float AS velocity
           FROM tasks t
           LEFT JOIN workflow_states ws ON ws.id = t.workflow_state_id
          WHERE t.sprint_id = $1 AND COALESCE(ws.is_terminal, FALSE) = TRUE`,
        [sprintId]
    )).rows[0];

    const rolled = await db.query(
        `UPDATE tasks
            SET sprint_id = $1,
                carried_over_from_sprint_id = $2
          WHERE sprint_id = $2
            AND COALESCE((SELECT is_terminal FROM workflow_states WHERE id = tasks.workflow_state_id), FALSE) = FALSE`,
        [nextSprintId, sprintId]
    );

    await db.query(
        `UPDATE sprints
            SET status = 'completed',
                completed_at = COALESCE(completed_at, NOW()),
                velocity_points = $1
          WHERE id = $2`,
        [velocityRow.velocity, sprintId]
    );

    return rolled.rowCount || 0;
}

/**
 * Ensure the auto sprint for `window` exists and is active for a team, rotating
 * the previous active sprint if the window has advanced. Returns the active
 * sprint id (or null if nothing changed and there was no existing row to make
 * active — should not happen in practice).
 */
async function reconcileTeam(
    db: Db,
    team: { id: number; sprint_duration_weeks: number; sprint_start_date: string },
    today: string,
): Promise<{ activeSprintId: number | null; transitioned: boolean }> {
    const window = computeCurrentWindow(team.sprint_start_date, team.sprint_duration_weeks, today);

    // Is there already an auto sprint row for this window?
    let current = (await db.query(
        `SELECT * FROM sprints WHERE team_id = $1 AND sprint_number = $2 AND auto_managed = TRUE`,
        [team.id, window.number]
    )).rows[0];

    // Find any currently-active auto sprint for the team (could be a previous
    // window that needs completing).
    const activePrev = (await db.query(
        `SELECT * FROM sprints
          WHERE team_id = $1 AND auto_managed = TRUE AND status = 'active'
          ORDER BY sprint_number DESC LIMIT 1`,
        [team.id]
    )).rows[0];

    let transitioned = false;

    if (!current) {
        // Create the current-window sprint as planned. We'll set carry origin
        // below if we roll a previous sprint into it.
        const name = `Sprint ${window.number}`;
        const inserted = (await db.query(
            `INSERT INTO sprints (team_id, name, start_date, end_date, status, auto_managed, sprint_number)
             VALUES ($1, $2, $3, $4, 'planned', TRUE, $5)
             ON CONFLICT (team_id, sprint_number) WHERE sprint_number IS NOT NULL DO NOTHING
             RETURNING *`,
            [team.id, name, window.startDate, window.endDate, window.number]
        )).rows[0];
        // If the ON CONFLICT no-op fired (race), re-read.
        current = inserted || (await db.query(
            `SELECT * FROM sprints WHERE team_id = $1 AND sprint_number = $2 AND auto_managed = TRUE`,
            [team.id, window.number]
        )).rows[0];
    }

    if (!current) {
        return { activeSprintId: activePrev ? activePrev.id : null, transitioned: false };
    }

    // If a previous auto sprint is still active and it's NOT the current window,
    // complete + roll it into the current window's sprint.
    if (activePrev && activePrev.id !== current.id && activePrev.sprint_number < window.number) {
        await completeAndRollover(db, activePrev.id, current.id);
        await db.query(
            `UPDATE sprints SET carried_from_sprint_id = $1 WHERE id = $2 AND carried_from_sprint_id IS NULL`,
            [activePrev.id, current.id]
        );
        transitioned = true;
    }

    // Activate the current window's sprint if it isn't already active. We don't
    // touch sprints the user manually paused — but a paused team is filtered
    // out before we get here, so any non-active current sprint should start.
    if (current.status === "planned") {
        await db.query(
            `UPDATE sprints SET status = 'active', started_at = COALESCE(started_at, NOW()) WHERE id = $1`,
            [current.id]
        );
        await snapshotBurndown(db, current.id);
        transitioned = true;
    }

    return { activeSprintId: current.id, transitioned };
}

/**
 * Run the sprint lifecycle for a single tenant DB. Invalidates the active-sprint
 * cache for any team that transitioned so the board "Active" label refreshes.
 */
export async function runSprintLifecycle(
    ctx: { db: Db; tenantId?: number | null },
    redisLike?: { invalidateActiveSprint: (tenantId: number | null | undefined, teamId: number) => Promise<void> },
): Promise<{ teamsProcessed: number; transitions: number }> {
    const { db, tenantId } = ctx;
    const today = new Date().toISOString().slice(0, 10);

    const teams = (await db.query(
        `SELECT id, sprint_duration_weeks, sprint_start_date
           FROM teams
          WHERE sprint_mode = 'auto'
            AND sprint_paused = FALSE
            AND sprint_start_date IS NOT NULL
            AND sprint_start_date <> ''`
    )).rows;

    let transitions = 0;
    for (const team of teams) {
        try {
            const { transitioned } = await reconcileTeam(db, team, today);
            if (transitioned) {
                transitions++;
                if (redisLike) {
                    await redisLike.invalidateActiveSprint(tenantId, team.id).catch(() => { /* best-effort */ });
                }
            }
        } catch (err: any) {
            logger.warn({ err: err.message, teamId: team.id, tenantId }, "Sprint lifecycle reconcile failed for team");
        }
    }

    return { teamsProcessed: teams.length, transitions };
}

export const __test__ = { snapshotBurndown, completeAndRollover, reconcileTeam, parseDateUTC, fmtDateUTC };