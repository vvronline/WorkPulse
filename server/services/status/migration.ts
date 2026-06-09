/**
 * Status Service — idempotent schema migration.
 *
 * INVARIANTS:
 *   • Called from `server/db.js` at startup for both master DB (legacy)
 *     and every tenant DB.
 *   • MUST be safe to run repeatedly. Every statement is `IF NOT EXISTS`
 *     or guarded by a `DO $do$ … $do$` block.
 *   • Does NOT reference the legacy `users.user_status` /
 *     `users.user_status_text` columns. Those are dropped by
 *     `2026_06_v5_drop_legacy_user_status_columns` in migrationRunner.js
 *     (PR8 / ADR-0001 step 8). The PR1 backfill that used to live here
 *     was removed once it had run on every production tenant — it's
 *     no longer needed and the columns it referenced are gone.
 */

type QueryRunner = (sql: string, params?: unknown[]) => Promise<unknown>;

async function runStatusMigration(query: QueryRunner): Promise<void> {
    // 1) New columns on `users` (preferences only).
    await query(`
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS manual_status TEXT,
            ADD COLUMN IF NOT EXISTS presence_preference TEXT NOT NULL DEFAULT 'auto',
            ADD COLUMN IF NOT EXISTS status_message TEXT,
            ADD COLUMN IF NOT EXISTS status_message_expires_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW()
    `);

    // CHECK constraints — guarded so re-runs don't fail.
    await query(`
        DO $do$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'users_manual_status_check'
            ) THEN
                ALTER TABLE users
                    ADD CONSTRAINT users_manual_status_check
                    CHECK (manual_status IS NULL OR manual_status IN ('available','busy','dnd','brb'));
            END IF;
        END $do$;
    `);
    await query(`
        DO $do$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'users_presence_pref_check'
            ) THEN
                ALTER TABLE users
                    ADD CONSTRAINT users_presence_pref_check
                    CHECK (presence_preference IN ('auto','invisible'));
            END IF;
        END $do$;
    `);

    // 2) Per-device live-presence session table.
    //
    //    NB: there is ALREADY an unrelated `user_sessions` table in the
    //    legacy schema for "max 2 devices" auth enforcement (id TEXT PK +
    //    device). We do NOT touch or extend that one — it has different
    //    semantics, different lifetimes, and different writers. The status
    //    service owns its own, distinct table.
    await query(`
        CREATE TABLE IF NOT EXISTS user_presence_sessions (
            id              BIGSERIAL PRIMARY KEY,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            session_key     TEXT NOT NULL UNIQUE,
            device_label    TEXT,
            connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            disconnected_at TIMESTAMPTZ,
            activity        TEXT,
            activity_ref_id INTEGER
        )
    `);
    await query(`
        DO $do$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'user_presence_sessions_activity_check'
            ) THEN
                ALTER TABLE user_presence_sessions
                    ADD CONSTRAINT user_presence_sessions_activity_check
                    CHECK (activity IS NULL OR activity IN ('in_call','in_meeting'));
            END IF;
        END $do$;
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_user_presence_sessions_user_open
            ON user_presence_sessions(user_id) WHERE disconnected_at IS NULL
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_user_presence_sessions_user_seen
            ON user_presence_sessions(user_id, last_seen_at DESC)
    `);

    // 3) Audit/event log — answers "why is Alice showing X?".
    await query(`
        CREATE TABLE IF NOT EXISTS user_status_events (
            id           BIGSERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            source       TEXT NOT NULL,
            from_state   TEXT,
            to_state     TEXT,
            session_key  TEXT,
            metadata     JSONB,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_user_status_events_user_time
            ON user_status_events(user_id, created_at DESC)
    `);

    // (PR8) The one-shot PR1 backfill from `users.user_status` was
    // removed once it had run on every production tenant. The legacy
    // columns are dropped by the `2026_06_v5_drop_legacy_user_status_columns`
    // migration in server/utils/migrationRunner.js; any tenant that has not
    // yet run that migration still has the columns present but unused.
}

export { runStatusMigration };