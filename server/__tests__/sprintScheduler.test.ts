/**
 * Unit tests for the sprint lifecycle scheduler.
 *
 * The scheduler is pure-ish: it takes a `db` with a `query(sql, params)`
 * method and a `today` string. We drive it with a tiny in-memory fake DB that
 * understands just enough SQL shape-matching to exercise the reconcile logic:
 *   - auto-create the current window
 *   - auto-start it
 *   - auto-complete + roll over the previous window when the cadence advances
 *   - skip paused / manual teams (via runSprintLifecycle's team filter)
 */
import { computeCurrentWindow, runSprintLifecycle, __test__ } from "../services/sprintScheduler";

describe("computeCurrentWindow", () => {
    test("returns window #1 on the start date", () => {
        const w = computeCurrentWindow("2026-01-05", 2, "2026-01-05");
        expect(w.number).toBe(1);
        expect(w.startDate).toBe("2026-01-05");
        expect(w.endDate).toBe("2026-01-18"); // 2 weeks = 14 days inclusive
    });

    test("advances to window #2 after the first window ends", () => {
        const w = computeCurrentWindow("2026-01-05", 2, "2026-01-19");
        expect(w.number).toBe(2);
        expect(w.startDate).toBe("2026-01-19");
        expect(w.endDate).toBe("2026-02-01");
    });

    test("clamps to window #1 before the start date", () => {
        const w = computeCurrentWindow("2026-01-05", 2, "2026-01-01");
        expect(w.number).toBe(1);
        expect(w.startDate).toBe("2026-01-05");
    });

    test("honours custom durations", () => {
        const w = computeCurrentWindow("2026-01-05", 1, "2026-01-13");
        expect(w.number).toBe(2); // week 2
        expect(w.startDate).toBe("2026-01-12");
        expect(w.endDate).toBe("2026-01-18");
    });
});

// ── Tiny in-memory fake DB ──────────────────────────────────────────────────
//
// Models a single team's sprints table just enough for reconcileTeam. Each
// `sprints` row: { id, team_id, name, start_date, end_date, status,
// auto_managed, sprint_number, carried_from_sprint_id, started_at,
// completed_at, velocity_points }. Tasks model only what burndown/rollover
// touch: { id, sprint_id, story_points, is_terminal, is_blocked,
// carried_over_from_sprint_id }.
function makeFakeDb(initial: { sprints?: any[]; tasks?: any[] } = {}) {
    const state: any = {
        sprints: initial.sprints ? [...initial.sprints] : ([] as any[]),
        tasks: initial.tasks ? [...initial.tasks] : ([] as any[]),
        snapshots: [] as any[],
        nextSprintId: 100,
        __teams: [] as any[],
    };

    async function query(sql: string, params: any[] = []) {
        const s = sql.replace(/\s+/g, " ").trim();

        // reconcileTeam: find current window sprint
        if (s.startsWith("SELECT * FROM sprints WHERE team_id = $1 AND sprint_number = $2 AND auto_managed = TRUE")) {
            const [teamId, num] = params;
            const row = state.sprints.find(
                (r: any) => r.team_id === teamId && r.sprint_number === num && r.auto_managed
            );
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }

        // reconcileTeam: find active auto sprint
        if (s.startsWith("SELECT * FROM sprints WHERE team_id = $1 AND auto_managed = TRUE AND status = 'active'")) {
            const [teamId] = params;
            const rows = state.sprints
                .filter((r: any) => r.team_id === teamId && r.auto_managed && r.status === "active")
                .sort((a: any, b: any) => (b.sprint_number || 0) - (a.sprint_number || 0));
            return { rows: rows.slice(0, 1), rowCount: Math.min(1, rows.length) };
        }

        // INSERT new auto sprint
        if (s.startsWith("INSERT INTO sprints (team_id, name, start_date, end_date, status, auto_managed, sprint_number)")) {
            const [teamId, name, start, end, num] = params;
            // emulate ON CONFLICT DO NOTHING: if a row with same number exists, no-op
            const dup = state.sprints.find((r: any) => r.team_id === teamId && r.sprint_number === num);
            if (dup) return { rows: [], rowCount: 0 };
            const row = {
                id: state.nextSprintId++,
                team_id: teamId,
                name,
                start_date: start,
                end_date: end,
                status: "planned",
                auto_managed: true,
                sprint_number: num,
                carried_from_sprint_id: null,
                started_at: null,
                completed_at: null,
                velocity_points: null,
            };
            state.sprints.push(row);
            return { rows: [row], rowCount: 1 };
        }

        // snapshotBurndown task pull
        if (s.startsWith("SELECT t.story_points, ws.is_terminal, t.is_blocked")) {
            const [sprintId] = params;
            const rows = state.tasks
                .filter((t: any) => t.sprint_id === sprintId)
                .map((t: any) => ({ story_points: t.story_points, is_terminal: t.is_terminal, is_blocked: t.is_blocked }));
            return { rows, rowCount: rows.length };
        }

        // snapshotBurndown UPSERT
        if (s.startsWith("INSERT INTO sprint_burndown_snapshots")) {
            state.snapshots.push(params);
            return { rows: [], rowCount: 1 };
        }

        // velocity computation
        if (s.includes("COALESCE(SUM(t.story_points), 0)::float AS velocity")) {
            const [sprintId] = params;
            const velocity = state.tasks
                .filter((t: any) => t.sprint_id === sprintId && t.is_terminal)
                .reduce((a: number, t: any) => a + (Number(t.story_points) || 0), 0);
            return { rows: [{ velocity }], rowCount: 1 };
        }

        // rollover UPDATE tasks ... SET sprint_id, carried_over_from_sprint_id
        if (s.startsWith("UPDATE tasks SET sprint_id = $1, carried_over_from_sprint_id = $2")) {
            const [nextId, originId] = params;
            let count = 0;
            for (const t of state.tasks) {
                if (t.sprint_id === originId && !t.is_terminal) {
                    t.sprint_id = nextId;
                    t.carried_over_from_sprint_id = originId;
                    count++;
                }
            }
            return { rows: [], rowCount: count };
        }

        // complete sprint
        if (s.startsWith("UPDATE sprints SET status = 'completed'")) {
            const [velocity, id] = params;
            const row = state.sprints.find((r: any) => r.id === id);
            if (row) {
                row.status = "completed";
                row.completed_at = "now";
                row.velocity_points = velocity;
            }
            return { rows: [], rowCount: 1 };
        }

        // set carried_from_sprint_id on the new sprint
        if (s.startsWith("UPDATE sprints SET carried_from_sprint_id = $1")) {
            const [originId, id] = params;
            const row = state.sprints.find((r: any) => r.id === id);
            if (row && row.carried_from_sprint_id == null) row.carried_from_sprint_id = originId;
            return { rows: [], rowCount: 1 };
        }

        // activate current sprint
        if (s.startsWith("UPDATE sprints SET status = 'active', started_at = COALESCE(started_at, NOW())")) {
            const [id] = params;
            const row = state.sprints.find((r: any) => r.id === id);
            if (row) {
                row.status = "active";
                row.started_at = "now";
            }
            return { rows: [], rowCount: 1 };
        }

        // runSprintLifecycle: teams query
        if (s.startsWith("SELECT id, sprint_duration_weeks, sprint_start_date FROM teams")) {
            return { rows: state.__teams || [], rowCount: (state.__teams || []).length };
        }

        throw new Error("Unhandled SQL in fake db: " + s);
    }

    return { query, state: state as any };
}

describe("reconcileTeam", () => {
    const team = { id: 1, sprint_duration_weeks: 2, sprint_start_date: "2026-01-05" };

    test("auto-creates and starts the current window when none exists", async () => {
        const db = makeFakeDb();
        const res = await __test__.reconcileTeam(db as any, team, "2026-01-05");
        expect(res.transitioned).toBe(true);
        const sprint = db.state.sprints[0];
        expect(sprint.status).toBe("active");
        expect(sprint.sprint_number).toBe(1);
        expect(sprint.auto_managed).toBe(true);
    });

    test("is idempotent — a second run on the same day does not transition", async () => {
        const db = makeFakeDb();
        await __test__.reconcileTeam(db as any, team, "2026-01-05");
        const res2 = await __test__.reconcileTeam(db as any, team, "2026-01-05");
        expect(res2.transitioned).toBe(false);
        expect(db.state.sprints.length).toBe(1);
    });

    test("completes the previous sprint and rolls incomplete tasks into the new one", async () => {
        // Sprint 1 active, with one done + one open task.
        const db = makeFakeDb({
            sprints: [
                {
                    id: 50,
                    team_id: 1,
                    name: "Sprint 1",
                    start_date: "2026-01-05",
                    end_date: "2026-01-18",
                    status: "active",
                    auto_managed: true,
                    sprint_number: 1,
                    carried_from_sprint_id: null,
                },
            ],
            tasks: [
                { id: 1, sprint_id: 50, story_points: 3, is_terminal: true, is_blocked: false, carried_over_from_sprint_id: null },
                { id: 2, sprint_id: 50, story_points: 5, is_terminal: false, is_blocked: false, carried_over_from_sprint_id: null },
            ],
        });

        // Now we're in window 2.
        const res = await __test__.reconcileTeam(db as any, team, "2026-01-19");
        expect(res.transitioned).toBe(true);

        const s1 = db.state.sprints.find((r: any) => r.sprint_number === 1);
        const s2 = db.state.sprints.find((r: any) => r.sprint_number === 2);
        expect(s1.status).toBe("completed");
        expect(s1.velocity_points).toBe(3); // only the done task's points
        expect(s2.status).toBe("active");
        expect(s2.carried_from_sprint_id).toBe(50);

        // The open task rolled into sprint 2 with provenance stamped.
        const rolled = db.state.tasks.find((t: any) => t.id === 2);
        expect(rolled.sprint_id).toBe(s2.id);
        expect(rolled.carried_over_from_sprint_id).toBe(50);

        // The done task stays in sprint 1.
        const done = db.state.tasks.find((t: any) => t.id === 1);
        expect(done.sprint_id).toBe(50);
    });
});

describe("runSprintLifecycle", () => {
    test("only processes auto, non-paused teams (filter is in SQL)", async () => {
        const db = makeFakeDb();
        // The teams SQL filter is applied by the DB; our fake returns whatever
        // we stash in __teams, simulating the filtered result set.
        db.state.__teams = [{ id: 1, sprint_duration_weeks: 2, sprint_start_date: "2026-01-05" }];
        const redis = { invalidateActiveSprint: jest.fn().mockResolvedValue(undefined) };
        const res = await runSprintLifecycle({ db: db as any, tenantId: 7 }, redis);
        expect(res.teamsProcessed).toBe(1);
        expect(res.transitions).toBe(1);
        expect(redis.invalidateActiveSprint).toHaveBeenCalledWith(7, 1);
    });

    test("no teams → no transitions, no cache invalidation", async () => {
        const db = makeFakeDb();
        db.state.__teams = [];
        const redis = { invalidateActiveSprint: jest.fn().mockResolvedValue(undefined) };
        const res = await runSprintLifecycle({ db: db as any, tenantId: 7 }, redis);
        expect(res.teamsProcessed).toBe(0);
        expect(res.transitions).toBe(0);
        expect(redis.invalidateActiveSprint).not.toHaveBeenCalled();
    });
});