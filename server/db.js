/**
 * PostgreSQL database module.
 *
 * Exports:
 *   query(sql, params)       – run a query, returns pg Result { rows, rowCount }
 *   transaction(asyncFn)     – run asyncFn(client) inside BEGIN/COMMIT/ROLLBACK
 *   initDB()                 – create all tables on startup
 */
const { Pool } = require('pg');
const { logger } = require('./utils/logger');

if (!process.env.DATABASE_URL) {
    logger.fatal('DATABASE_URL environment variable is not set. Server cannot start.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require'))
        ? { rejectUnauthorized: false }
        : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected DB pool error');
});

/** Run a parameterised query. Returns a pg Result object ({ rows, rowCount }). */
async function query(sql, params = []) {
    const client = await pool.connect();
    try {
        return await client.query(sql, params);
    } finally {
        client.release();
    }
}

/**
 * Run an async function inside a single DB transaction.
 * asyncFn receives a pg Client. On success, commits. On exception, rolls back.
 */
async function transaction(asyncFn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await asyncFn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Schema initialisation
// ────────────────────────────────────────────────────────────────────────────

async function initDB() {
    // Migration tracking
    await query(`
        CREATE TABLE IF NOT EXISTS _migrations (
            name       TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS organizations (
            id                  SERIAL PRIMARY KEY,
            name                TEXT NOT NULL,
            slug                TEXT UNIQUE NOT NULL,
            logo                TEXT,
            work_hours_per_day  INTEGER NOT NULL DEFAULT 8,
            work_days           TEXT NOT NULL DEFAULT '1,2,3,4,5',
            timezone            TEXT NOT NULL DEFAULT 'UTC',
            fiscal_year_start   INTEGER NOT NULL DEFAULT 1,
            created_by          INTEGER,
            created_at          TIMESTAMPTZ DEFAULT NOW(),
            updated_at          TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id                   SERIAL PRIMARY KEY,
            username             TEXT UNIQUE NOT NULL,
            password             TEXT NOT NULL,
            full_name            TEXT NOT NULL,
            theme                TEXT NOT NULL DEFAULT 'dark',
            role                 TEXT NOT NULL DEFAULT 'employee'
                                     CHECK(role IN ('employee','team_lead','manager','hr_admin','super_admin')),
            is_active            BOOLEAN NOT NULL DEFAULT TRUE,
            org_id               INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            team_id              INTEGER,
            department_id        INTEGER,
            manager_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
            timezone_offset      INTEGER NOT NULL DEFAULT 0,
            avatar               TEXT,
            email                TEXT UNIQUE,
            failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until         TIMESTAMPTZ,
            token_version        INTEGER NOT NULL DEFAULT 0,
            must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
            created_at           TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)`);

    // Add lockout columns to existing databases
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`);

    await query(`
        CREATE TABLE IF NOT EXISTS departments (
            id         SERIAL PRIMARY KEY,
            org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            head_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, name)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS teams (
            id                    SERIAL PRIMARY KEY,
            org_id                INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            department_id         INTEGER REFERENCES departments(id) ON DELETE SET NULL,
            name                  TEXT NOT NULL,
            lead_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at            TIMESTAMPTZ DEFAULT NOW(),
            sprint_duration_weeks INTEGER NOT NULL DEFAULT 2,
            sprint_start_date     TEXT,
            UNIQUE(org_id, name)
        )
    `);

    // Add deferred FK from users -> teams and users -> departments
    await query(`
        DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                           WHERE constraint_name = 'users_team_id_fkey') THEN
                ALTER TABLE users ADD CONSTRAINT users_team_id_fkey
                    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
            END IF;
        END $do$
    `);
    await query(`
        DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                           WHERE constraint_name = 'users_department_id_fkey') THEN
                ALTER TABLE users ADD CONSTRAINT users_department_id_fkey
                    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
            END IF;
        END $do$
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS time_entries (
            id              SERIAL PRIMARY KEY,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            entry_type      TEXT NOT NULL CHECK(entry_type IN ('clock_in','break_start','break_end','clock_out')),
            timestamp       TIMESTAMPTZ DEFAULT NOW(),
            work_mode       TEXT CHECK(work_mode IN ('office','remote','hybrid')),
            is_manual       BOOLEAN NOT NULL DEFAULT FALSE,
            approval_status TEXT NOT NULL DEFAULT 'approved'
                                CHECK(approval_status IN ('pending','approved','rejected')),
            approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_time_entries_user   ON time_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_time_entries_ts     ON time_entries(user_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_time_entries_manual ON time_entries(user_id, is_manual, approval_status);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS leaves (
            id            SERIAL PRIMARY KEY,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            date          TEXT NOT NULL,
            leave_type    TEXT NOT NULL CHECK(leave_type IN ('sick','holiday','planned','personal','other')),
            reason        TEXT,
            status        TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','approved','rejected','withdraw_pending')),
            duration      TEXT NOT NULL DEFAULT 'full' CHECK(duration IN ('full','half','quarter')),
            approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at   TIMESTAMPTZ,
            reject_reason TEXT
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(user_id, status, date)`);

    await query(`
        CREATE TABLE IF NOT EXISTS tasks (
            id           SERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            date         TEXT,
            title        TEXT NOT NULL,
            description  TEXT,
            priority     TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
            status       TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','in_progress','in_review','done')),
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
            due_date     TEXT,
            sprint_id    INTEGER
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_tasks_user_date   ON tasks(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to, date);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token      TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used       BOOLEAN NOT NULL DEFAULT FALSE
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS sprints (
            id         SERIAL PRIMARY KEY,
            team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date   TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','completed')),
            goal       TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(team_id, name)
        )
    `);

    // Deferred FK from tasks -> sprints
    await query(`
        DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                           WHERE constraint_name = 'tasks_sprint_id_fkey') THEN
                ALTER TABLE tasks ADD CONSTRAINT tasks_sprint_id_fkey
                    FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL;
            END IF;
        END $do$
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS leave_policies (
            id                   SERIAL PRIMARY KEY,
            org_id               INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            leave_type           TEXT NOT NULL,
            annual_quota         NUMERIC NOT NULL DEFAULT 0,
            accrual_type         TEXT NOT NULL DEFAULT 'annual',
            carry_forward_limit  NUMERIC NOT NULL DEFAULT 0,
            half_day_allowed     BOOLEAN NOT NULL DEFAULT FALSE,
            quarter_day_allowed  BOOLEAN NOT NULL DEFAULT FALSE
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS leave_balances (
            id              SERIAL PRIMARY KEY,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            leave_type      TEXT NOT NULL,
            year            INTEGER NOT NULL,
            quota           NUMERIC NOT NULL DEFAULT 0,
            used            NUMERIC NOT NULL DEFAULT 0,
            carried_forward NUMERIC NOT NULL DEFAULT 0,
            UNIQUE(user_id, leave_type, year)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS holidays (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            date        TEXT NOT NULL,
            name        TEXT NOT NULL,
            is_optional BOOLEAN NOT NULL DEFAULT FALSE,
            UNIQUE(org_id, date)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS approval_requests (
            id            SERIAL PRIMARY KEY,
            org_id        INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            approver_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            type          TEXT NOT NULL CHECK(type IN ('leave','manual_entry','overtime','leave_withdraw')),
            reference_id  INTEGER,
            status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
            reason        TEXT,
            reject_reason TEXT,
            metadata      TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            reviewed_at   TIMESTAMPTZ
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_approval_requester   ON approval_requests(requester_id, status);
        CREATE INDEX IF NOT EXISTS idx_approval_approver    ON approval_requests(approver_id, status);
        CREATE INDEX IF NOT EXISTS idx_approval_type_status ON approval_requests(type, status);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS role_change_requests (
            id              SERIAL PRIMARY KEY,
            org_id          INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            target_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            requested_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            from_role       TEXT NOT NULL,
            to_role         TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
            reason          TEXT,
            reject_reason   TEXT,
            rejected_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            approvals       JSONB NOT NULL DEFAULT '{}',
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_role_change_org_status ON role_change_requests(org_id, status);
        CREATE INDEX IF NOT EXISTS idx_role_change_target     ON role_change_requests(target_user_id, status);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            action      TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id   INTEGER,
            details     TEXT,
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_org    ON audit_logs(org_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS invite_codes (
            id          SERIAL PRIMARY KEY,
            code        TEXT UNIQUE NOT NULL,
            created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            role        TEXT NOT NULL DEFAULT 'employee',
            max_uses    INTEGER NOT NULL DEFAULT 1,
            used_count  INTEGER NOT NULL DEFAULT 0,
            expires_at  TIMESTAMPTZ,
            is_active   BOOLEAN NOT NULL DEFAULT TRUE,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS task_labels (
            id         SERIAL PRIMARY KEY,
            org_id     INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            color      TEXT NOT NULL DEFAULT '#6366f1',
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, name)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS task_label_map (
            task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            label_id INTEGER NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, label_id)
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_task_label_map_task  ON task_label_map(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_label_map_label ON task_label_map(label_id);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS task_comments (
            id         SERIAL PRIMARY KEY,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content    TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at)`);

    await query(`
        CREATE TABLE IF NOT EXISTS task_history (
            id         SERIAL PRIMARY KEY,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            action     TEXT NOT NULL,
            field      TEXT,
            old_value  TEXT,
            new_value  TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, created_at)`);

    await query(`
        CREATE TABLE IF NOT EXISTS notebooks (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            data       TEXT NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS calendar_events (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            org_id      INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            title       TEXT NOT NULL,
            description TEXT,
            start_time  TIMESTAMPTZ NOT NULL,
            end_time    TIMESTAMPTZ NOT NULL,
            all_day     BOOLEAN NOT NULL DEFAULT FALSE,
            color       TEXT DEFAULT '#6366f1',
            task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_cal_events_user_time ON calendar_events(user_id, start_time, end_time);
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS notebook_history (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            page_id    TEXT NOT NULL,
            page_title TEXT,
            content    TEXT,
            saved_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_nb_history_page ON notebook_history(user_id, page_id, saved_at DESC)
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id           SERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type         TEXT NOT NULL,
            title        TEXT NOT NULL,
            body         TEXT,
            link_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
            is_read      BOOLEAN NOT NULL DEFAULT FALSE,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)
    `);

    // ---- Chat / Direct Messages ----
    await query(`
        CREATE TABLE IF NOT EXISTS conversations (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name        VARCHAR(100),
            is_group    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name VARCHAR(100)`);
    await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE`);

    await query(`
        CREATE TABLE IF NOT EXISTS conversation_participants (
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, user_id)
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants(user_id)
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS messages (
            id              SERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content         TEXT,
            reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
            file_url        TEXT,
            file_name       VARCHAR(255),
            file_type       VARCHAR(50),
            file_size        INTEGER,
            edited_at       TIMESTAMPTZ,
            deleted_at      TIMESTAMPTZ,
            forwarded_from_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
            pinned_at       TIMESTAMPTZ,
            pinned_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    // Migrate existing messages tables
    await query(`ALTER TABLE messages ALTER COLUMN content DROP NOT NULL`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url TEXT`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name VARCHAR(255)`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_type VARCHAR(50)`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size INTEGER`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC)
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS message_reads (
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (conversation_id, user_id)
        )
    `);

    // ---- Message Reactions ----
    await query(`
        CREATE TABLE IF NOT EXISTS message_reactions (
            id          SERIAL PRIMARY KEY,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            emoji       VARCHAR(20) NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (message_id, user_id, emoji)
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id)`);

    // Presence tracking
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);

    // Full-text search index on messages
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING gin(to_tsvector('english', COALESCE(content, '')))`);

    // Seed defaults
    await query(`
        INSERT INTO app_settings (key, value) VALUES ('registration_mode', 'open')
        ON CONFLICT (key) DO NOTHING
    `);

    // Promote first registered user to super_admin (one-time setup, guarded by migration)
    const migName = 'promote_first_admin';
    const alreadyRan = (await query(
        'SELECT 1 FROM _migrations WHERE name = $1', [migName]
    )).rows[0];
    if (!alreadyRan) {
        const firstUser = (await query(
            "SELECT id FROM users WHERE role = 'employee' ORDER BY id ASC LIMIT 1"
        )).rows[0];
        if (firstUser) {
            await query("UPDATE users SET role = 'super_admin' WHERE id = $1", [firstUser.id]);
            await query('INSERT INTO _migrations (name) VALUES ($1)', [migName]);
            logger.info({ userId: firstUser.id }, 'Promoted first user to super_admin');
        }
    }

    logger.info('Database schema initialised');
}

module.exports = { query, transaction, initDB, pool };