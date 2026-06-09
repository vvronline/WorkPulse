// Ensures the current + next sprint exist for a team that has
// sprint_start_date / sprint_duration_weeks configured. Returns the
// materialised sprint rows (existing or newly inserted).
//
// Bug #11 (Stage 2): two concurrent requests to GET /available-sprints from
// the same admin used to race the INSERTs, occasionally raising duplicate
// errors on the (team_id, name) UNIQUE constraint. We now grab a per-team
// Postgres advisory lock for the duration of the materialisation; the lock
// is released when the wrapping transaction commits. Reads on this team's
// sprints from other connections aren't blocked — only other concurrent
// materialisations.

import type { Request } from "express";

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

function getTodayStr(req: Request): string {
    const tzOffset = req.headers['x-timezone-offset'];
    if (tzOffset !== undefined) {
        const now = new Date();
        const localNow = new Date(now.getTime() - Number(tzOffset) * 60000);
        return localNow.toISOString().split('T')[0];
    }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function fmt(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Stable namespace for the advisory lock keys so we don't clash with other
// subsystems. The two-int form of pg_advisory_xact_lock takes a namespace
// id and a key — using the team id as the key keeps the locks per-team.
const ADVISORY_NAMESPACE = 0x7407_5503; // "tasks/sprints" mnemonic

async function materialiseTeamSprints(team: any, req: Request): Promise<any[]> {
    if (!team?.sprint_start_date || !team.sprint_duration_weeks) return [];
    const todayStr = getTodayStr(req);
    const [sy, sm, sd] = team.sprint_start_date.split('-').map(Number);
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const startMs = Date.UTC(sy, sm - 1, sd);
    const todayMs = Date.UTC(ty, tm - 1, td);
    const daysSinceStart = Math.floor((todayMs - startMs) / 86400000);
    const sprintDurationDays = team.sprint_duration_weeks * 7;
    const sprintNumber = daysSinceStart < 0 ? 1 : Math.floor(daysSinceStart / sprintDurationDays) + 1;

    // Bug #11: do all of the read-then-insert work inside a transaction so we
    // can serialise concurrent callers on the per-team advisory lock. The
    // lock is auto-released on COMMIT/ROLLBACK.
    return await (req.db as DbLike).transaction(async (client: any) => {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_NAMESPACE, team.id]);
        const out: any[] = [];
        for (let i = 0; i < 2; i++) {
            const num = sprintNumber + i;
            const sprintStartDays = (num - 1) * sprintDurationDays;
            const sMs = startMs + sprintStartDays * 86400000;
            const eMs = sMs + (sprintDurationDays - 1) * 86400000;
            const name = `Sprint #${num}`;
            const existing = (await client.query(
                'SELECT id, name, start_date, end_date, status, goal FROM sprints WHERE team_id = $1 AND name = $2',
                [team.id, name]
            )).rows[0];
            if (existing) {
                out.push(existing);
            } else {
                const inserted = await client.query(
                    'INSERT INTO sprints (team_id, name, start_date, end_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, start_date, end_date, status, goal',
                    [team.id, name, fmt(sMs), fmt(eMs), i === 0 ? 'active' : 'planned']
                );
                out.push(inserted.rows[0]);
            }
        }
        return out;
    });
}

export = { materialiseTeamSprints, getTodayStr, fmt };