/**
 * PostgreSQL database module — multi-tenant aware.
 *
 * Master DB (DATABASE_URL) holds platform-level tables: tenants, user_directory,
 * platform_users, app_settings, _migrations.
 * Each tenant gets its own database with the full application schema.
 *
 * Exports:
 *   query(sql, params)              – alias for masterQuery (backward compat)
 *   transaction(asyncFn)            – alias for masterTransaction (backward compat)
 *   masterQuery(sql, params)        – run a query against the master DB
 *   masterTransaction(asyncFn)      – run asyncFn(client) in a master DB transaction
 *   makePoolQuery(pool)             – create a query fn bound to any pool
 *   makePoolTransaction(pool)       – create a transaction fn bound to any pool
 *   initMasterDB()                  – create master-only tables on startup
 *   initTenantSchema(queryFn)       – create all tenant-scoped tables (idempotent)
 *   initDB()                        – legacy: runs initMasterDB + initTenantSchema on master (migration compat)
 *   pool                            – the master pool (for health checks, shutdown)
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
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected master DB pool error');
});

// ────────────────────────────────────────────────────────────────────────────
// Generic pool-bound helpers
// ────────────────────────────────────────────────────────────────────────────

/** Create a query function bound to the given pool. */
function makePoolQuery(targetPool) {
    return async function boundQuery(sql, params = []) {
        const client = await targetPool.connect();
        try {
            return await client.query(sql, params);
        } finally {
            client.release();
        }
    };
}

/** Create a transaction function bound to the given pool. */
function makePoolTransaction(targetPool) {
    return async function boundTransaction(asyncFn) {
        const client = await targetPool.connect();
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
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Master DB helpers (bound to the master pool)
// ────────────────────────────────────────────────────────────────────────────

const masterQuery = makePoolQuery(pool);
const masterTransaction = makePoolTransaction(pool);

/** @deprecated Use masterQuery — kept for backward compatibility during migration. */
const query = masterQuery;
/** @deprecated Use masterTransaction — kept for backward compatibility during migration. */
const transaction = masterTransaction;

// ────────────────────────────────────────────────────────────────────────────
// Schema initialisation
// ────────────────────────────────────────────────────────────────────────────

async function initDB() {
    await initMasterDB();
    // Legacy: also initialise tenant schema in master DB so existing single-DB
    // deployments keep working until fully migrated to per-tenant databases.
    await initTenantSchema(masterQuery);
    // Seed Agile defaults (work item types, workflow states, settings) for any
    // org in the master DB that hasn't been seeded yet. Idempotent.
    try {
        await seedAgileDefaults(masterQuery);
    } catch (err) {
        logger.warn({ err: err.message }, 'Agile defaults seeding failed in initDB (non-fatal)');
    }
    logger.info('Database schema initialised (master + legacy tenant tables)');
}

// ────────────────────────────────────────────────────────────────────────────
// Master-only schema (tenants catalog, platform users, app settings)
// ────────────────────────────────────────────────────────────────────────────

async function initMasterDB() {
    // Migration tracking
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS _migrations (
            name       TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // ---- Tenant catalog ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS tenants (
            id               SERIAL PRIMARY KEY,
            org_name         TEXT NOT NULL,
            slug             TEXT UNIQUE NOT NULL,
            db_name          TEXT UNIQUE NOT NULL,
            db_host          TEXT,
            custom_domain    TEXT UNIQUE,
            status           TEXT NOT NULL DEFAULT 'active'
                                 CHECK(status IN ('active','suspended','migrating','deleted')),
            max_users        INTEGER,
            max_storage_mb   INTEGER,
            features         JSONB NOT NULL DEFAULT '{}',
            is_default       BOOLEAN NOT NULL DEFAULT FALSE,
            suspended_at     TIMESTAMPTZ,
            suspended_reason TEXT,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await masterQuery(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE`);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_tenants_domain ON tenants(custom_domain)`);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`);

    // Migration: ensure exactly one tenant is flagged as the default (platform)
    // tenant. If none is flagged, promote the tenant whose slug is 'default',
    // or fall back to the oldest active tenant. The default tenant's backlog
    // receives all service-desk tickets from every tenant.
    await masterQuery(`
        DO $do$
        DECLARE
            target_id INTEGER;
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM tenants WHERE is_default = TRUE) THEN
                SELECT id INTO target_id FROM tenants
                 WHERE status != 'deleted' AND slug = 'default'
                 ORDER BY id ASC LIMIT 1;
                IF target_id IS NULL THEN
                    SELECT id INTO target_id FROM tenants
                     WHERE status != 'deleted'
                     ORDER BY id ASC LIMIT 1;
                END IF;
                IF target_id IS NOT NULL THEN
                    UPDATE tenants SET is_default = TRUE WHERE id = target_id;
                END IF;
            END IF;
        END $do$;
    `);

    // ---- Service Desk Tickets (cross-tenant, managed by default tenant) ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS service_desk_tickets (
            id               SERIAL PRIMARY KEY,
            tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            submitted_by_user_id INTEGER NOT NULL,
            submitted_by_name    TEXT NOT NULL,
            submitted_by_email   TEXT,
            ticket_type      TEXT NOT NULL CHECK(ticket_type IN ('bug','feature_request','access_issue','other')),
            title            TEXT NOT NULL,
            description      TEXT,
            priority         TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
            status           TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','in_progress','resolved','closed')),
            assigned_to      TEXT,
            admin_notes      TEXT,
            resolved_at      TIMESTAMPTZ,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_service_desk_tenant ON service_desk_tickets(tenant_id, status)`);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_service_desk_status ON service_desk_tickets(status, created_at)`);

    // ---- User directory for cross-tenant login resolution ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS user_directory (
            id         SERIAL PRIMARY KEY,
            email      TEXT UNIQUE NOT NULL,
            username   TEXT UNIQUE NOT NULL,
            tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_user_directory_tenant ON user_directory(tenant_id)`);

    // ---- Platform users (platform_admin accounts — no org) ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS platform_users (
            id                   SERIAL PRIMARY KEY,
            username             TEXT UNIQUE NOT NULL,
            password             TEXT NOT NULL,
            full_name            TEXT NOT NULL,
            email                TEXT UNIQUE,
            role                 TEXT NOT NULL DEFAULT 'platform_admin'
                                     CHECK(role IN ('platform_admin')),
            is_active            BOOLEAN NOT NULL DEFAULT TRUE,
            token_version        INTEGER NOT NULL DEFAULT 0,
            failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until         TIMESTAMPTZ,
            theme                TEXT NOT NULL DEFAULT 'dark',
            avatar               TEXT,
            created_at           TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // ---- App settings (platform-wide) ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // ---- Sessions for platform_users ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            user_id    INTEGER NOT NULL,
            device     TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`);

    // ---- Platform audit logs (master-level admin actions) ----
    await masterQuery(`
        CREATE TABLE IF NOT EXISTS platform_audit_logs (
            id          SERIAL PRIMARY KEY,
            actor_id    INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
            action      TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id   INTEGER,
            tenant_id   INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
            details     JSONB,
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            ended_at    TIMESTAMPTZ
        )
    `);
    // Add ended_at if table already exists without it
    await masterQuery(`ALTER TABLE platform_audit_logs ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_platform_audit_actor ON platform_audit_logs(actor_id, created_at)`);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant ON platform_audit_logs(tenant_id, created_at)`);
    await masterQuery(`CREATE INDEX IF NOT EXISTS idx_platform_audit_action ON platform_audit_logs(action, created_at)`);

    // Seed defaults
    await masterQuery(`
        INSERT INTO app_settings (key, value) VALUES ('registration_mode', 'open')
        ON CONFLICT (key) DO NOTHING
    `);

    logger.info('Master DB schema initialised');
}

// ────────────────────────────────────────────────────────────────────────────
// Tenant schema (all org-scoped tables — run against any tenant DB pool)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Initialise all tenant-scoped tables. `q` must be a query function bound to
 * the target pool (master pool for legacy single-DB, or a tenant pool).
 */
async function initTenantSchema(q) {

    await q(`
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

    // Migration: minimum hours an employee must log on a working day to be
    // counted as "Present" by attendance reports/calendar. NULL = use
    // work_hours_per_day / 2 as a sensible default at query time.
    await q(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS min_hours_present NUMERIC(4,2)`);

    // Migration: regular office start time (HH:MM, 24h). Used as the default
    // clock-in time on manual time-entry forms and as the reference point for
    // attendance/presence calculations (instead of midnight). NULL = no
    // configured office hours, fall back to '09:00' on the client.
    await q(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_start_time TEXT`);

    await q(`
        CREATE TABLE IF NOT EXISTS users (
            id                   SERIAL PRIMARY KEY,
            username             TEXT UNIQUE NOT NULL,
            password             TEXT NOT NULL,
            full_name            TEXT NOT NULL,
            theme                TEXT NOT NULL DEFAULT 'dark',
            role                 TEXT NOT NULL DEFAULT 'employee'
                                     CHECK(role IN ('employee','team_lead','manager','hr_admin','super_admin','platform_admin')),
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
    await q(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)`);

    // Add lockout columns to existing databases
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`);

    await q(`
        CREATE TABLE IF NOT EXISTS departments (
            id         SERIAL PRIMARY KEY,
            org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            head_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, name)
        )
    `);

    await q(`
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
    await q(`
        DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                           WHERE constraint_name = 'users_team_id_fkey') THEN
                ALTER TABLE users ADD CONSTRAINT users_team_id_fkey
                    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
            END IF;
        END $do$
    `);
    await q(`
        DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                           WHERE constraint_name = 'users_department_id_fkey') THEN
                ALTER TABLE users ADD CONSTRAINT users_department_id_fkey
                    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
            END IF;
        END $do$
    `);

    await q(`
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
    await q(`
        CREATE INDEX IF NOT EXISTS idx_time_entries_user   ON time_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_time_entries_ts     ON time_entries(user_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_time_entries_manual ON time_entries(user_id, is_manual, approval_status);
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS leaves (
            id            SERIAL PRIMARY KEY,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            date          TEXT NOT NULL,
            leave_type    TEXT NOT NULL CHECK(leave_type IN ('sick','holiday','planned','personal','other')),
            reason        TEXT,
            status        TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','approved','rejected','withdraw_pending','revoked')),
            duration      TEXT NOT NULL DEFAULT 'full' CHECK(duration IN ('full','half','quarter')),
            approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at   TIMESTAMPTZ,
            reject_reason TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    // Migration: add created_at to existing leaves tables
    await q(`ALTER TABLE leaves ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    // Migration: update leaves status constraint to include 'revoked'
    await q(`
        DO $do$ BEGIN
            ALTER TABLE leaves DROP CONSTRAINT IF EXISTS leaves_status_check;
            ALTER TABLE leaves ADD CONSTRAINT leaves_status_check
                CHECK(status IN ('pending','approved','rejected','withdraw_pending','revoked'));
        EXCEPTION WHEN others THEN NULL;
        END $do$
    `);
    // Migration: drop the hard-coded leave_type CHECK so organisations can define
    // their own custom leave types via leave_policies. Allowed types are now
    // governed at the application layer (must exist in leave_policies for the org).
    //
    // We do this in two ways for safety:
    //   1. The well-known default constraint name `leaves_leave_type_check`.
    //   2. ANY remaining CHECK constraint on the `leave_type` column —
    //      handles tenants whose DB was bootstrapped under a different
    //      constraint name (custom ALTER TABLE ADD CONSTRAINT ... etc).
    await q(`
        DO $do$ BEGIN
            ALTER TABLE leaves DROP CONSTRAINT IF EXISTS leaves_leave_type_check;
        EXCEPTION WHEN others THEN NULL;
        END $do$
    `);
    await q(`
        DO $do$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT con.conname
                FROM   pg_constraint con
                JOIN   pg_class       rel ON rel.oid = con.conrelid
                JOIN   pg_attribute   att ON att.attrelid = rel.oid
                                         AND att.attnum   = ANY(con.conkey)
                WHERE  rel.relname = 'leaves'
                  AND  con.contype = 'c'
                  AND  att.attname = 'leave_type'
            LOOP
                EXECUTE 'ALTER TABLE leaves DROP CONSTRAINT ' || quote_ident(r.conname);
            END LOOP;
        EXCEPTION WHEN others THEN NULL;
        END $do$
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(user_id, status, date)`);

    await q(`
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
    await q(`
        CREATE INDEX IF NOT EXISTS idx_tasks_user_date   ON tasks(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to, date);
    `);
    // Migration: add org_id to tasks for tenant isolation
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id)`);
    // Backfill org_id from the task owner's org
    await q(`UPDATE tasks t SET org_id = u.org_id FROM users u WHERE u.id = t.user_id AND t.org_id IS NULL AND u.org_id IS NOT NULL`);
    // Migration: add service_desk_ticket_id to tasks for linking service desk tickets to backlog
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS service_desk_ticket_id INTEGER`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tasks_service_desk ON tasks(service_desk_ticket_id) WHERE service_desk_ticket_id IS NOT NULL`);
    // Migration: update role CHECK to include platform_admin on existing databases
    await q(`
        DO $do$ BEGIN
            ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
            ALTER TABLE users ADD CONSTRAINT users_role_check
                CHECK(role IN ('employee','team_lead','manager','hr_admin','super_admin','platform_admin'));
        EXCEPTION WHEN others THEN NULL;
        END $do$
    `);

    // Migration: drop the hard-coded tasks.status CHECK so tenants can introduce
    // custom workflow state keys via workflow_states. Status is now a mirror of
    // the workflow state key; integrity is enforced at the application layer
    // (the value must match an existing workflow_states.key for the org).
    await q(`
        DO $do$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT con.conname
                FROM   pg_constraint con
                JOIN   pg_class       rel ON rel.oid = con.conrelid
                JOIN   pg_attribute   att ON att.attrelid = rel.oid
                                         AND att.attnum   = ANY(con.conkey)
                WHERE  rel.relname = 'tasks'
                  AND  con.contype = 'c'
                  AND  att.attname = 'status'
            LOOP
                EXECUTE 'ALTER TABLE tasks DROP CONSTRAINT ' || quote_ident(r.conname);
            END LOOP;
        EXCEPTION WHEN others THEN NULL;
        END $do$
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token      TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used       BOOLEAN NOT NULL DEFAULT FALSE
        )
    `);

    // Active sessions – max 2 per user
    await q(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id         TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device     TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`);

    await q(`
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
    await q(`
        DO $do$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                           WHERE constraint_name = 'tasks_sprint_id_fkey') THEN
                ALTER TABLE tasks ADD CONSTRAINT tasks_sprint_id_fkey
                    FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL;
            END IF;
        END $do$
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS leave_policies (
            id                   SERIAL PRIMARY KEY,
            org_id               INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            leave_type           TEXT NOT NULL,
            name                 TEXT,
            color                TEXT DEFAULT '#6366f1',
            annual_quota         NUMERIC NOT NULL DEFAULT 0,
            accrual_type         TEXT NOT NULL DEFAULT 'annual',
            carry_forward_limit  NUMERIC NOT NULL DEFAULT 0,
            half_day_allowed     BOOLEAN NOT NULL DEFAULT FALSE,
            quarter_day_allowed  BOOLEAN NOT NULL DEFAULT FALSE
        )
    `);
    // Migration: add name/color to existing leave_policies tables
    await q(`ALTER TABLE leave_policies ADD COLUMN IF NOT EXISTS name TEXT`);
    await q(`ALTER TABLE leave_policies ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#6366f1'`);

    // Migration: collapse any duplicate (org_id, leave_type) rows down to a
    // single canonical row before installing the UNIQUE constraint below.
    // The oldest id wins; duplicates are deleted. This is idempotent — once
    // there are no duplicates left it's a NO-OP.
    await q(`
        DELETE FROM leave_policies a
         USING leave_policies b
         WHERE a.org_id     = b.org_id
           AND a.leave_type = b.leave_type
           AND a.id         > b.id
    `);
    // Migration: enforce one policy per (org_id, leave_type). Wrapped in a DO
    // block so re-running on databases that already have the constraint is a
    // safe NO-OP.
    await q(`
        DO $do$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'leave_policies_org_leave_type_key'
            ) THEN
                ALTER TABLE leave_policies
                    ADD CONSTRAINT leave_policies_org_leave_type_key
                    UNIQUE (org_id, leave_type);
            END IF;
        EXCEPTION WHEN others THEN NULL;
        END $do$
    `);

    await q(`
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

    await q(`
        CREATE TABLE IF NOT EXISTS holidays (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            date        TEXT NOT NULL,
            name        TEXT NOT NULL,
            is_optional BOOLEAN NOT NULL DEFAULT FALSE,
            UNIQUE(org_id, date)
        )
    `);

    await q(`
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
    await q(`
        CREATE INDEX IF NOT EXISTS idx_approval_requester   ON approval_requests(requester_id, status);
        CREATE INDEX IF NOT EXISTS idx_approval_approver    ON approval_requests(approver_id, status);
        CREATE INDEX IF NOT EXISTS idx_approval_type_status ON approval_requests(type, status);
    `);

    await q(`
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
    await q(`
        CREATE INDEX IF NOT EXISTS idx_role_change_org_status ON role_change_requests(org_id, status);
        CREATE INDEX IF NOT EXISTS idx_role_change_target     ON role_change_requests(target_user_id, status);
    `);

    await q(`
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
    // Migration: add org_id to existing audit_logs tables that pre-date tenant isolation
    await q(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_org    ON audit_logs(org_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
    `);

    await q(`
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

    await q(`
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

    await q(`
        CREATE TABLE IF NOT EXISTS task_label_map (
            task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            label_id INTEGER NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, label_id)
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_task_label_map_task  ON task_label_map(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_label_map_label ON task_label_map(label_id);
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS task_comments (
            id         SERIAL PRIMARY KEY,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content    TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at)`);

    await q(`
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
    await q(`CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, created_at)`);

    await q(`
        CREATE TABLE IF NOT EXISTS notebooks (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            data       TEXT NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await q(`
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
    await q(`
        CREATE INDEX IF NOT EXISTS idx_cal_events_user_time ON calendar_events(user_id, start_time, end_time);
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS notebook_history (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            page_id    TEXT NOT NULL,
            page_title TEXT,
            content    TEXT,
            saved_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_nb_history_page ON notebook_history(user_id, page_id, saved_at DESC)
    `);

    await q(`
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
    await q(`
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)
    `);

    // ---- Chat / Direct Messages ----
    await q(`
        CREATE TABLE IF NOT EXISTS conversations (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name        VARCHAR(100),
            is_group    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name VARCHAR(100)`);
    await q(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    await q(`
        CREATE TABLE IF NOT EXISTS conversation_participants (
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, user_id)
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants(user_id)
    `);
    await q(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS is_favourite BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`
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
    await q(`ALTER TABLE messages ALTER COLUMN content DROP NOT NULL`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url TEXT`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name VARCHAR(255)`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_type VARCHAR(50)`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size INTEGER`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    await q(`
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC)
    `);
    await q(`
        CREATE TABLE IF NOT EXISTS message_reads (
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (conversation_id, user_id)
        )
    `);

    // ---- Message Reactions ----
    await q(`
        CREATE TABLE IF NOT EXISTS message_reactions (
            id          SERIAL PRIMARY KEY,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            emoji       VARCHAR(20) NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (message_id, user_id, emoji)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id)`);

    // Presence tracking
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);

    // Full-text search index on messages
    await q(`CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING gin(to_tsvector('english', COALESCE(content, '')))`);

    // ---- Starred Messages ----
    await q(`
        CREATE TABLE IF NOT EXISTS starred_messages (
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (user_id, message_id)
        )
    `);

    // ---- Polls ----
    await q(`
        CREATE TABLE IF NOT EXISTS polls (
            id              SERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            creator_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            question        TEXT NOT NULL,
            options         JSONB NOT NULL DEFAULT '[]',
            multi_select    BOOLEAN NOT NULL DEFAULT FALSE,
            closed_at       TIMESTAMPTZ,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`
        CREATE TABLE IF NOT EXISTS poll_votes (
            id         SERIAL PRIMARY KEY,
            poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            option_idx INTEGER NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (poll_id, user_id, option_idx)
        )
    `);

    // ---- Call Logs ----
    await q(`
        CREATE TABLE IF NOT EXISTS call_logs (
            id              SERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            caller_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            call_type       VARCHAR(10) NOT NULL DEFAULT 'voice',
            status          VARCHAR(20) NOT NULL DEFAULT 'ringing',
            started_at      TIMESTAMPTZ,
            ended_at        TIMESTAMPTZ,
            duration        INTEGER,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_call_logs_conv ON call_logs(conversation_id, created_at DESC)`);

    // ---- Meetings ----
    await q(`
        CREATE TABLE IF NOT EXISTS meetings (
            id                  SERIAL PRIMARY KEY,
            org_id              INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            title               TEXT NOT NULL,
            description         TEXT,
            meeting_code        VARCHAR(20) NOT NULL UNIQUE,
            created_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            conversation_id     INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
            calendar_event_id   INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
            status              VARCHAR(20) NOT NULL DEFAULT 'scheduled',
            started_at          TIMESTAMPTZ,
            ended_at            TIMESTAMPTZ,
            max_participants    INTEGER NOT NULL DEFAULT 20,
            settings            JSONB NOT NULL DEFAULT '{"muteOnJoin":false,"allowScreenShare":true}',
            created_at          TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_meetings_org ON meetings(org_id, created_at DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_meetings_code ON meetings(meeting_code)`);

    await q(`
        CREATE TABLE IF NOT EXISTS meeting_participants (
            id          SERIAL PRIMARY KEY,
            meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role        VARCHAR(20) NOT NULL DEFAULT 'participant',
            status      VARCHAR(20) NOT NULL DEFAULT 'invited',
            joined_at   TIMESTAMPTZ,
            left_at     TIMESTAMPTZ,
            UNIQUE(meeting_id, user_id)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_meeting_participants ON meeting_participants(meeting_id, user_id)`);

    // ---- Extend calendar_events with meeting_id ----
    await q(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS participant_type VARCHAR(20) NOT NULL DEFAULT 'required'`);

    // ---- Delivery status on messages ----
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_to JSONB DEFAULT '[]'`);

    // ---- Message format_type for rich text / polls / code ----
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS format_type VARCHAR(20) DEFAULT 'text'`);
    await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB`);
    // ---- Full-text search index on tasks ----
    await q(`
        CREATE INDEX IF NOT EXISTS idx_tasks_fts ON tasks
        USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')))
    `);

    // ---- Pay periods (for payroll locking) ----
    await q(`
        CREATE TABLE IF NOT EXISTS pay_periods (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            label       TEXT NOT NULL,
            start_date  TEXT NOT NULL,
            end_date    TEXT NOT NULL,
            locked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            locked_at   TIMESTAMPTZ DEFAULT NOW(),
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, start_date, end_date)
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_pay_periods_org ON pay_periods(org_id, start_date)
    `);

    // ---- Announcements ----
    await q(`
        CREATE TABLE IF NOT EXISTS announcements (
            id           SERIAL PRIMARY KEY,
            org_id       INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message      TEXT NOT NULL,
            type         TEXT NOT NULL DEFAULT 'info',
            is_active    BOOLEAN NOT NULL DEFAULT TRUE,
            expires_at   TIMESTAMPTZ,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(org_id, is_active, created_at DESC)
    `);
    await q(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);

    // Migration: add user_status and user_status_text to users
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_status TEXT NOT NULL DEFAULT 'available' CHECK(user_status IN ('available','busy','dnd','away','offline','in_call','in_meeting'))`);
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_status_text TEXT`);

    // Per-user notification & sound preferences (ringtones, message tones,
    // mute toggle, volumes). Stored as JSONB so we can evolve the schema
    // without a follow-up migration. See client/src/utils/sounds.js for the
    // canonical default shape (DEFAULT_PREFS).
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`);

    // Tenant-level app settings (registration_mode, etc.)
    await q(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`
        INSERT INTO app_settings (key, value) VALUES ('registration_mode', 'open')
        ON CONFLICT (key) DO NOTHING
    `);

    // ---- Collaborative Notes (Yjs CRDT state per page) ----
    await q(`
        CREATE TABLE IF NOT EXISTS notebook_pages (
            page_id    TEXT PRIMARY KEY,
            tenant_id  INTEGER NOT NULL DEFAULT 0,
            yjs_state  BYTEA,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_nb_pages_tenant ON notebook_pages(tenant_id)
    `);

    // ---- Note ↔ Entity links (Tier 6 integrations) ----
    await q(`
        CREATE TABLE IF NOT EXISTS note_links (
            id           SERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            page_id      TEXT NOT NULL,
            entity_type  TEXT NOT NULL CHECK(entity_type IN ('task','calendar_event','meeting')),
            entity_id    INTEGER NOT NULL,
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(page_id, entity_type, entity_id)
        )
    `);
    await q(`
        CREATE INDEX IF NOT EXISTS idx_note_links_page   ON note_links(page_id);
        CREATE INDEX IF NOT EXISTS idx_note_links_entity ON note_links(entity_type, entity_id);
    `);

    // ─────────────────────────────────────────────────────────────────────
    // AGILE: tenant-customisable Work Item Types, Workflow States,
    // Story Points scale, Epics, Acceptance Criteria, Dependencies,
    // Sprint Retrospectives, plus a request/grant access-control model
    // for who can edit Agile settings.
    // ─────────────────────────────────────────────────────────────────────

    // Org-wide agile settings (singleton row per org)
    await q(`
        CREATE TABLE IF NOT EXISTS org_agile_settings (
            org_id                      INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
            estimation_type             TEXT NOT NULL DEFAULT 'fibonacci'
                CHECK(estimation_type IN ('fibonacci','linear','tshirt','hours','none','custom')),
            estimation_values           JSONB NOT NULL DEFAULT '[0.5,1,2,3,5,8,13,21,34]'::jsonb,
            estimation_unit_label       TEXT NOT NULL DEFAULT 'SP',
            priority_scheme             JSONB NOT NULL DEFAULT '[{"key":"low","label":"Low","color":"#10b981"},{"key":"medium","label":"Medium","color":"#f59e0b"},{"key":"high","label":"High","color":"#ef4444"}]'::jsonb,
            enable_story_points         BOOLEAN NOT NULL DEFAULT TRUE,
            enable_epics                BOOLEAN NOT NULL DEFAULT TRUE,
            enable_dependencies         BOOLEAN NOT NULL DEFAULT TRUE,
            enable_acceptance_criteria  BOOLEAN NOT NULL DEFAULT TRUE,
            enable_wip_limits           BOOLEAN NOT NULL DEFAULT FALSE,
            enable_blockers             BOOLEAN NOT NULL DEFAULT TRUE,
            enable_retrospectives       BOOLEAN NOT NULL DEFAULT TRUE,
            require_estimate_for_sprint BOOLEAN NOT NULL DEFAULT FALSE,
            default_dod                 TEXT,
            updated_at                  TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // Customisable Work Item Types (Story / Bug / Task / Epic / Spike / ...)
    await q(`
        CREATE TABLE IF NOT EXISTS work_item_types (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            key         TEXT NOT NULL,
            name        TEXT NOT NULL,
            icon        TEXT,
            color       TEXT NOT NULL DEFAULT '#6366f1',
            description TEXT,
            is_default  BOOLEAN NOT NULL DEFAULT FALSE,
            is_epic     BOOLEAN NOT NULL DEFAULT FALSE,
            is_active   BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, key)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_work_item_types_org ON work_item_types(org_id, is_active, sort_order)`);

    // Customisable Workflow States (Kanban columns).
    // Categories: 'open' | 'in_progress' | 'in_review' | 'done'
    // Every tenant must keep at least one state in each category.
    await q(`
        CREATE TABLE IF NOT EXISTS workflow_states (
            id            SERIAL PRIMARY KEY,
            org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            key           TEXT NOT NULL,
            name          TEXT NOT NULL,
            category      TEXT NOT NULL CHECK(category IN ('open','in_progress','in_review','done')),
            color         TEXT NOT NULL DEFAULT '#6b7280',
            icon          TEXT,
            wip_limit     INTEGER,
            is_initial    BOOLEAN NOT NULL DEFAULT FALSE,
            is_terminal   BOOLEAN NOT NULL DEFAULT FALSE,
            is_active     BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order    INTEGER NOT NULL DEFAULT 0,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, key)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_workflow_states_org ON workflow_states(org_id, is_active, sort_order)`);

    // Optional: which states apply to which work item types
    await q(`
        CREATE TABLE IF NOT EXISTS workflow_state_type_map (
            state_id INTEGER NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
            type_id  INTEGER NOT NULL REFERENCES work_item_types(id) ON DELETE CASCADE,
            PRIMARY KEY (state_id, type_id)
        )
    `);

    // Allowed transitions between workflow states (governance, optional)
    await q(`
        CREATE TABLE IF NOT EXISTS workflow_transitions (
            id            SERIAL PRIMARY KEY,
            org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            from_state_id INTEGER NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
            to_state_id   INTEGER NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
            required_role TEXT,
            UNIQUE(from_state_id, to_state_id)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_workflow_transitions_org ON workflow_transitions(org_id)`);

    // Per-team agile overrides (optional, falls back to org)
    await q(`
        CREATE TABLE IF NOT EXISTS team_agile_settings (
            team_id            INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
            estimation_type    TEXT,
            estimation_values  JSONB,
            capacity_points    NUMERIC(7,1),
            updated_at         TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // Access-control: who else (besides super_admin) can edit Agile settings.
    await q(`
        CREATE TABLE IF NOT EXISTS agile_editor_grants (
            id          SERIAL PRIMARY KEY,
            org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
            granted_at  TIMESTAMPTZ DEFAULT NOW(),
            revoked_at  TIMESTAMPTZ,
            UNIQUE(org_id, user_id)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_agile_grants_active ON agile_editor_grants(org_id, user_id) WHERE revoked_at IS NULL`);

    await q(`
        CREATE TABLE IF NOT EXISTS agile_editor_requests (
            id            SERIAL PRIMARY KEY,
            org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reason        TEXT,
            status        TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','approved','rejected','cancelled')),
            reviewed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at   TIMESTAMPTZ,
            reject_reason TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_agile_requests_status ON agile_editor_requests(org_id, status, created_at)`);

    // Task-level agile fields
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS story_points NUMERIC(6,2)`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_item_type_id INTEGER REFERENCES work_item_types(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workflow_state_id INTEGER REFERENCES workflow_states(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rank_value NUMERIC(20,10)`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tasks_workflow_state ON tasks(workflow_state_id) WHERE workflow_state_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tasks_sprint_points ON tasks(sprint_id) WHERE sprint_id IS NOT NULL`);

    // Task dependencies graph
    await q(`
        CREATE TABLE IF NOT EXISTS task_dependencies (
            id            SERIAL PRIMARY KEY,
            task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            type          TEXT NOT NULL DEFAULT 'blocks'
                CHECK(type IN ('blocks','relates','duplicates','clones')),
            created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(task_id, depends_on_id, type)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_id)`);

    // Sprint retrospectives
    await q(`
        CREATE TABLE IF NOT EXISTS sprint_retrospectives (
            id          SERIAL PRIMARY KEY,
            sprint_id   INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
            category    TEXT NOT NULL CHECK(category IN ('went_well','went_wrong','action_item','kudos')),
            content     TEXT NOT NULL,
            author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            votes       INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_retro_sprint ON sprint_retrospectives(sprint_id, category)`);

    await q(`
        CREATE TABLE IF NOT EXISTS sprint_retro_votes (
            retro_id INTEGER NOT NULL REFERENCES sprint_retrospectives(id) ON DELETE CASCADE,
            user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (retro_id, user_id)
        )
    `);

    logger.info('Tenant schema initialised');
}

// ────────────────────────────────────────────────────────────────────────────
// Agile defaults seeding
// ────────────────────────────────────────────────────────────────────────────

/**
 * Seed default Agile config (work item types, workflow states, settings) for
 * every org in the tenant DB that doesn't yet have org_agile_settings.
 * Idempotent — safe to run on every boot.
 *
 * Also backfills tasks.workflow_state_id from the legacy tasks.status column
 * by matching the seeded workflow state keys.
 */
async function seedAgileDefaults(q) {
    const orgs = (await q(
        `SELECT o.id FROM organizations o
         LEFT JOIN org_agile_settings s ON s.org_id = o.id
         WHERE s.org_id IS NULL`
    )).rows;

    for (const { id: orgId } of orgs) {
        // 1. Settings row
        await q(
            `INSERT INTO org_agile_settings (org_id) VALUES ($1)
             ON CONFLICT (org_id) DO NOTHING`,
            [orgId]
        );

        // 2. Default work item types
        const defaultTypes = [
            { key: 'story', name: 'Story', icon: 'BookOpen', color: '#10b981', is_default: true, is_epic: false, sort_order: 1, description: 'A user-facing piece of value.' },
            { key: 'bug', name: 'Bug', icon: 'Bug', color: '#ef4444', is_default: false, is_epic: false, sort_order: 2, description: 'Something broken to fix.' },
            { key: 'task', name: 'Task', icon: 'Circle', color: '#6366f1', is_default: false, is_epic: false, sort_order: 3, description: 'Generic work item.' },
            { key: 'epic', name: 'Epic', icon: 'Target', color: '#8b5cf6', is_default: false, is_epic: true, sort_order: 4, description: 'A large body of work that groups stories.' },
        ];
        for (const t of defaultTypes) {
            await q(
                `INSERT INTO work_item_types (org_id, key, name, icon, color, description, is_default, is_epic, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (org_id, key) DO NOTHING`,
                [orgId, t.key, t.name, t.icon, t.color, t.description, t.is_default, t.is_epic, t.sort_order]
            );
        }

        // 3. Default workflow states (one per category — matches legacy COLUMNS)
        const defaultStates = [
            { key: 'pending', name: 'To Do', category: 'open', color: '#6b7280', sort_order: 1, is_initial: true, is_terminal: false },
            { key: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#f59e0b', sort_order: 2, is_initial: false, is_terminal: false },
            { key: 'in_review', name: 'In Review', category: 'in_review', color: '#3b82f6', sort_order: 3, is_initial: false, is_terminal: false },
            { key: 'done', name: 'Done', category: 'done', color: '#10b981', sort_order: 4, is_initial: false, is_terminal: true },
        ];
        for (const st of defaultStates) {
            await q(
                `INSERT INTO workflow_states (org_id, key, name, category, color, sort_order, is_initial, is_terminal)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (org_id, key) DO NOTHING`,
                [orgId, st.key, st.name, st.category, st.color, st.sort_order, st.is_initial, st.is_terminal]
            );
        }
    }

    // Backfill tasks.workflow_state_id from tasks.status (matching by key within the same org)
    await q(`
        UPDATE tasks t
           SET workflow_state_id = ws.id
          FROM workflow_states ws
         WHERE t.workflow_state_id IS NULL
           AND ws.org_id = t.org_id
           AND ws.key   = t.status
    `);

    // Backfill tasks.work_item_type_id with the default 'story' type for tasks that
    // don't have one yet, scoped to the same org.
    await q(`
        UPDATE tasks t
           SET work_item_type_id = wit.id
          FROM work_item_types wit
         WHERE t.work_item_type_id IS NULL
           AND wit.org_id = t.org_id
           AND wit.is_default = TRUE
    `);
}

module.exports = {
    pool,
    // Master DB helpers
    masterQuery,
    masterTransaction,
    // Backward-compatible aliases (hit master DB)
    query,
    transaction,
    // Generic pool-bound factory helpers
    makePoolQuery,
    makePoolTransaction,
    // Schema init
    initDB,
    initMasterDB,
    initTenantSchema,
    seedAgileDefaults,
};
