/**
 * Attendance background operations.
 *
 * Extracted from the HTTP/process entrypoint during Phase C. Keeping this
 * domain logic here lets both the combined process and the future worker role
 * invoke it without importing the Express app.
 */
import { logger } from "../../utils/logger";
import { forEachTenant } from "../../utils/tenantManager";
import type { DbContext } from "../../types/domain";

/** Close open attendance sessions that have crossed local midnight. */
async function autoClockOut(): Promise<void> {
    const result = await forEachTenant(
        async (db: DbContext) => { await autoClockOutForDb(db); },
        { label: "autoClockOut" },
    );
    if (result.failed > 0) {
        logger.warn({ ok: result.ok, failed: result.failed }, "autoClockOut completed with failures");
    }
}

async function autoClockOutForDb(db: DbContext): Promise<void> {
    const activeUsers = (await db.query<{ id: number; timezone_offset?: number }>(`
        SELECT u.id, u.timezone_offset
        FROM users u
        INNER JOIN LATERAL (
            SELECT entry_type FROM time_entries t
            WHERE t.user_id = u.id
            ORDER BY t.timestamp DESC
            LIMIT 1
        ) latest ON latest.entry_type != 'clock_out'
    `)).rows;

    if (activeUsers.length === 0) return;

    // Process in batches to avoid overwhelming the connection pool.
    const BATCH = 50;
    for (let i = 0; i < activeUsers.length; i += BATCH) {
        const batch = activeUsers.slice(i, i + BATCH);
        await Promise.allSettled(batch.map((user) =>
            autoClockOutUser(db, user).catch((e) =>
                logger.error({ userId: user.id, err: e }, "Auto clock-out failed"),
            ),
        ));
    }
}

async function autoClockOutUser(
    db: DbContext,
    user: { id: number; timezone_offset?: number },
): Promise<void> {
    const rawOffset = user.timezone_offset || 0;
    // Clamp to valid timezone range: UTC-12 (720) to UTC+14 (-840).
    const offsetMin = (typeof rawOffset === "number" && rawOffset >= -840 && rawOffset <= 720)
        ? rawOffset
        : 0;

    await db.transaction!(async (client: any) => {
        // Find the user's single most-recent live entry across ALL dates. A
        // session is "open" when this latest entry is not a clock_out. Working
        // from the actual open entry (rather than a recomputed "yesterday")
        // makes the boundary robust even when `users.timezone_offset` is stale
        // or 0 — the previous version recomputed "yesterday" from that offset,
        // so a wrong offset stamped the clock_out into the wrong local day,
        // which the non-live attendance reader then couldn't pair → the day was
        // truncated and wrongly marked Absent (e.g. an 8h overnight shift that
        // showed as 4.06h). We anchor the end-of-day boundary on the OPEN
        // session's own clock-in day instead.
        const lastEntryRow = (await client.query(`
            SELECT id, entry_type, timestamp FROM time_entries
            WHERE user_id = $1 AND is_manual IS NOT TRUE
            ORDER BY timestamp DESC, id DESC LIMIT 1
        `, [user.id])).rows[0];

        if (!lastEntryRow || lastEntryRow.entry_type === "clock_out") return;

        // Parse the open entry's timestamp to epoch ms (DB stores UTC; the value
        // may or may not carry a trailing 'Z').
        const lastTsRaw = lastEntryRow.timestamp instanceof Date
            ? lastEntryRow.timestamp.toISOString()
            : String(lastEntryRow.timestamp).replace(" ", "T");
        const lastMs = new Date(/[Zz]$/.test(lastTsRaw) ? lastTsRaw : lastTsRaw + "Z").getTime();

        // Only auto-close sessions that are no longer "today" in the user's
        // local timezone — i.e. the session has rolled past local midnight.
        const nowMs = Date.now();
        const localToday = new Date(nowMs - offsetMin * 60000).toISOString().slice(0, 10);
        const sessionLocalDay = new Date(lastMs - offsetMin * 60000).toISOString().slice(0, 10);
        if (sessionLocalDay >= localToday) return;

        // End-of-day (23:59:59 local) of the OPEN session's own local day,
        // expressed back in UTC. Never stamp a clock_out before the open entry.
        const [y, m, d] = sessionLocalDay.split("-").map(Number);
        let boundaryMs = Date.UTC(y, m - 1, d, 23, 59, 59) + offsetMin * 60000;
        if (boundaryMs <= lastMs) boundaryMs = lastMs + 1000;
        const autoTs = new Date(boundaryMs).toISOString().slice(0, 19).replace("T", " ");

        if (lastEntryRow.entry_type === "break_start") {
            await client.query(
                "INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES ($1, $2, $3)",
                [user.id, "break_end", autoTs],
            );
        }
        await client.query(
            "INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES ($1, $2, $3)",
            [user.id, "clock_out", autoTs],
        );
        logger.info({ userId: user.id, date: sessionLocalDay, offsetMin }, "Auto clock-out applied");
    });
}

/** Remove expired/consumed password-reset tokens from every tenant. */
async function cleanupTokens(): Promise<void> {
    const result = await forEachTenant(
        async (db: DbContext) => {
            await db.query("DELETE FROM password_reset_tokens WHERE used = TRUE OR expires_at < NOW()");
        },
        { label: "cleanupTokens" },
    );
    if (result.failed > 0) {
        logger.warn({ ok: result.ok, failed: result.failed }, "cleanupTokens completed with failures");
    }
}

export { autoClockOut, autoClockOutForDb, autoClockOutUser, cleanupTokens };