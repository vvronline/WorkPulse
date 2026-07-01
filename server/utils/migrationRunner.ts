/**
 * Versioned migration runner for WorkPulse.
 *
 * Background: the existing `initTenantSchema(query)` in db.js is a long
 * idempotent function full of `CREATE TABLE IF NOT EXISTS` and
 * `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements. It works, but has two
 * shortcomings on the multi-tenant code path:
 *
 *   1. It runs the *entire* schema script every time `getTenantPool` first
 *      touches a tenant DB in a process (slow cold start, log noise).
 *   2. There is no record of which "logical migration" has been applied to
 *      a given tenant DB — so we can't gate a feature on "migration M is
 *      applied", and we can't easily add destructive migrations later.
 *
 * This module fixes both. Each migration is a `{ name, up(query) }` object
 * that runs once per tenant DB. We track applied migrations per DB in the
 * existing `_migrations` table (which the schema bootstrap already creates).
 *
 * Migrations defined here are *additive only* — they live alongside the
 * existing `initTenantSchema()` so they cannot regress an already-bootstrapped
 * DB. Use them for new columns/indexes/feature toggles after the initial
 * schema has shipped.
 *
 * Usage:
 *   const { runTenantMigrations, sweepAllTenants } = require('./migrationRunner');
 *   await runTenantMigrations(db.query);             // for a single tenant DB
 *   await sweepAllTenants();                         // startup: every active tenant
 */
import { logger } from "./logger";
import type { QueryFn } from "../types/domain";

interface Migration {
    name: string;
    up: (query: QueryFn) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration registry — append new migrations to the bottom; never reorder or
// rename existing ones. Each `name` is the unique key persisted in
// `_migrations.name`.
//
// `up(query)` is invoked with a pool-bound query function. Migrations should
// be idempotent (`IF NOT EXISTS`) so a partial application can be safely
// retried without manual cleanup.
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATIONS: Migration[] = [
    {
        name: '2026_05_v1_index_users_org_active',
        async up(query) {
            await query(`
                CREATE INDEX IF NOT EXISTS idx_users_org_active
                ON users (org_id) WHERE is_active = TRUE
            `);
        },
    },
    {
        name: '2026_05_v1_index_audit_logs_actor_created',
        async up(query) {
            await query(`
                CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
                ON audit_logs (actor_id, created_at DESC)
            `);
        },
    },
    {
        name: '2026_05_v1_index_audit_logs_entity_created',
        async up(query) {
            await query(`
                CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created
                ON audit_logs (entity_type, created_at DESC)
            `);
        },
    },
    {
        // Tenant-customisable Agile configuration tables (Pass 1 of the
        // story-points / work-item-types / workflow-states feature).
        // initTenantSchema() also creates these for new tenants — this
        // migration ensures every EXISTING tenant DB picks them up on the
        // next deploy without needing manual intervention.
        name: '2026_05_v1_agile_customisation_tables',
        async up(query) {
            await query(`
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
            await query(`
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
            await query(`CREATE INDEX IF NOT EXISTS idx_work_item_types_org ON work_item_types(org_id, is_active, sort_order)`);
            await query(`
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
            await query(`CREATE INDEX IF NOT EXISTS idx_workflow_states_org ON workflow_states(org_id, is_active, sort_order)`);
            await query(`
                CREATE TABLE IF NOT EXISTS workflow_state_type_map (
                    state_id INTEGER NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
                    type_id  INTEGER NOT NULL REFERENCES work_item_types(id) ON DELETE CASCADE,
                    PRIMARY KEY (state_id, type_id)
                )
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS workflow_transitions (
                    id            SERIAL PRIMARY KEY,
                    org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    from_state_id INTEGER NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
                    to_state_id   INTEGER NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
                    required_role TEXT,
                    UNIQUE(from_state_id, to_state_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_workflow_transitions_org ON workflow_transitions(org_id)`);
            await query(`
                CREATE TABLE IF NOT EXISTS team_agile_settings (
                    team_id            INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
                    estimation_type    TEXT,
                    estimation_values  JSONB,
                    capacity_points    NUMERIC(7,1),
                    updated_at         TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`
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
            await query(`CREATE INDEX IF NOT EXISTS idx_agile_grants_active ON agile_editor_grants(org_id, user_id) WHERE revoked_at IS NULL`);
            await query(`
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
            await query(`CREATE INDEX IF NOT EXISTS idx_agile_requests_status ON agile_editor_requests(org_id, status, created_at)`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS story_points NUMERIC(6,2)`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_item_type_id INTEGER REFERENCES work_item_types(id) ON DELETE SET NULL`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workflow_state_id INTEGER REFERENCES workflow_states(id) ON DELETE SET NULL`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rank_value NUMERIC(20,10)`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT`);
            await query(`CREATE INDEX IF NOT EXISTS idx_tasks_workflow_state ON tasks(workflow_state_id) WHERE workflow_state_id IS NOT NULL`);
            await query(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`);
            await query(`
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
            await query(`CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_id)`);
            await query(`
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
            // Guard: a fresh tenant may have been bootstrapped with the
            // MODERN sprint_retrospectives shape by initTenantSchema() (which
            // tracks v3/v4 and has no `category` column). In that case the
            // CREATE TABLE IF NOT EXISTS above was a no-op and creating an
            // index on the non-existent `category` column would abort the
            // entire v1 migration, blocking v2/v3/v4 forever. Skip the index
            // when the column isn't there — v4 drops this index anyway.
            await query(`
                DO $do$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_name  = 'sprint_retrospectives'
                           AND column_name = 'category'
                    ) THEN
                        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_retro_sprint ON sprint_retrospectives(sprint_id, category)';
                    END IF;
                END $do$;
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS sprint_retro_votes (
                    retro_id INTEGER NOT NULL REFERENCES sprint_retrospectives(id) ON DELETE CASCADE,
                    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    PRIMARY KEY (retro_id, user_id)
                )
            `);

            // Drop the legacy hard-coded tasks.status CHECK so custom workflow
            // state keys can flow through.
            await query(`
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
        },
    },
    {
        // Pass 2: sprint lifecycle, burndown snapshots, and the supporting
        // columns on `sprints` (started_at / completed_at / velocity_points).
        // These are additive; old sprints just have NULL until they complete.
        name: '2026_05_v2_sprint_lifecycle',
        async up(query) {
            await query(`ALTER TABLE sprints ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
            await query(`ALTER TABLE sprints ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
            await query(`ALTER TABLE sprints ADD COLUMN IF NOT EXISTS velocity_points NUMERIC(8,2)`);
            await query(`
                CREATE TABLE IF NOT EXISTS sprint_burndown_snapshots (
                    id               SERIAL PRIMARY KEY,
                    sprint_id        INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
                    snapshot_date    DATE NOT NULL,
                    total_points     NUMERIC(10,2) NOT NULL DEFAULT 0,
                    done_points      NUMERIC(10,2) NOT NULL DEFAULT 0,
                    remaining_points NUMERIC(10,2) NOT NULL DEFAULT 0,
                    blocked_points   NUMERIC(10,2) NOT NULL DEFAULT 0,
                    open_tasks       INTEGER NOT NULL DEFAULT 0,
                    created_at       TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE (sprint_id, snapshot_date)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_burndown_sprint_date ON sprint_burndown_snapshots(sprint_id, snapshot_date)`);
        },
    },
    {
        // Phase 3: per-task cycle/lead-time markers + sprint retrospectives.
        //
        // - `cycle_started_at` is set the first time a task transitions out of
        //   the initial workflow state (i.e. work actually begins).
        // - `lead_started_at` is set on task creation to anchor lead time.
        // - `sprint_retrospectives` is a one-row-per-sprint table holding the
        //   classic three columns (Went Well / Improve / Action Items) plus a
        //   numeric team-mood vote and an optional summary blurb. Action items
        //   are JSONB so we don't need a separate child table.
        name: '2026_05_v3_cycle_time_and_retros',
        async up(query) {
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cycle_started_at TIMESTAMPTZ`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lead_started_at  TIMESTAMPTZ`);
            // Backfill lead_started_at for existing rows so historical reports work.
            await query(`UPDATE tasks SET lead_started_at = COALESCE(lead_started_at, created_at) WHERE lead_started_at IS NULL`);

            // Pass 1 created a placeholder `sprint_retrospectives` table with
            // a category/content/votes shape that no UI ever consumed. Phase 3
            // replaces it with the conventional one-row-per-sprint template.
            // The drop is safe: there are no production consumers and no data
            // worth preserving (the table was empty in every tenant).
            await query(`DROP TABLE IF EXISTS sprint_retro_votes`);
            await query(`DROP TABLE IF EXISTS sprint_retrospectives`);

            await query(`
                CREATE TABLE sprint_retrospectives (
                    id              SERIAL PRIMARY KEY,
                    sprint_id       INTEGER NOT NULL UNIQUE REFERENCES sprints(id) ON DELETE CASCADE,
                    went_well       TEXT,
                    to_improve      TEXT,
                    action_items    JSONB DEFAULT '[]'::jsonb,
                    team_mood       SMALLINT CHECK (team_mood IS NULL OR team_mood BETWEEN 1 AND 5),
                    summary         TEXT,
                    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_retros_sprint ON sprint_retrospectives(sprint_id)`);
        },
    },
    {
        // Phase 4: defensive cleanup for the retrospective table.
        //
        // Some tenant DBs may still carry the legacy `category/content/votes`
        // columns (e.g. v3 partially failed mid-deploy, or the tenant was
        // bootstrapped against an older copy of `initTenantSchema()` that
        // re-added the columns after v3 ran). This migration:
        //   1. Drops the obsolete `sprint_retro_votes` table if it lingers.
        //   2. Drops the legacy `category`, `content`, `votes`, `author_id`
        //      columns from `sprint_retrospectives` if they still exist.
        //   3. Drops the legacy `idx_retro_sprint` index that referenced
        //      `(sprint_id, category)` — replaced by `idx_retros_sprint`.
        //   4. Ensures the canonical UNIQUE(sprint_id) constraint exists so
        //      the upsert in `routes/sprints.js` works even on tenants whose
        //      table was created before the constraint was added.
        // All steps are wrapped in IF EXISTS guards so the migration is a
        // safe NO-OP on already-clean tenants.
        name: '2026_05_v4_retro_cleanup',
        async up(query) {
            await query(`DROP TABLE IF EXISTS sprint_retro_votes`);
            await query(`DROP INDEX IF EXISTS idx_retro_sprint`);
            await query(`ALTER TABLE sprint_retrospectives DROP COLUMN IF EXISTS category`);
            await query(`ALTER TABLE sprint_retrospectives DROP COLUMN IF EXISTS content`);
            await query(`ALTER TABLE sprint_retrospectives DROP COLUMN IF EXISTS votes`);
            await query(`ALTER TABLE sprint_retrospectives DROP COLUMN IF EXISTS author_id`);
            // Ensure UNIQUE(sprint_id) — needed for the ON CONFLICT (sprint_id) upsert.
            await query(`
                DO $do$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                         WHERE conrelid = 'sprint_retrospectives'::regclass
                           AND contype  = 'u'
                           AND conkey   = ARRAY[(
                               SELECT attnum FROM pg_attribute
                                WHERE attrelid = 'sprint_retrospectives'::regclass
                                  AND attname  = 'sprint_id'
                           )]::smallint[]
                    ) THEN
                        BEGIN
                            ALTER TABLE sprint_retrospectives
                                ADD CONSTRAINT sprint_retrospectives_sprint_id_key
                                UNIQUE (sprint_id);
                        EXCEPTION WHEN duplicate_object THEN NULL;
                        END;
                    END IF;
                END $do$
            `);
            // Ensure the canonical index exists (idempotent).
            await query(`CREATE INDEX IF NOT EXISTS idx_retros_sprint ON sprint_retrospectives(sprint_id)`);
        },
    },
    {
        // Phase 5: Org branding (logo + accent color) and per-template
        // overrides for outgoing notification emails.
        //
        // - `org_branding` is a one-row-per-org table holding the logo URL
        //   (relative to /uploads) and an accent color used as the primary
        //   theme color across the app + email templates.
        // - `org_email_templates` holds optional per-template overrides for
        //   the subject and body HTML. The `template_key` is one of the
        //   built-in keys defined in `server/utils/mailer.js` (leaveApproved,
        //   leaveRejected, taskAssigned, mention, etc.). When no override
        //   row exists the mailer falls back to the built-in template.
        name: '2026_06_v1_branding_and_email_templates',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS org_branding (
                    org_id        INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
                    logo_url      TEXT,
                    accent_color  TEXT NOT NULL DEFAULT '#6366f1',
                    updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    updated_at    TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS org_email_templates (
                    org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    template_key  TEXT    NOT NULL,
                    subject       TEXT    NOT NULL,
                    body_html     TEXT    NOT NULL,
                    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
                    updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    updated_at    TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (org_id, template_key)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_org_email_templates_org ON org_email_templates(org_id)`);
        },
    },
    {
        // ─────────────────────────────────────────────────────────────────
        // Clean up 1:1 chats that the legacy "Add participant in call" bug
        // permanently corrupted by injecting a 3rd member into the
        // `conversation_participants` table.
        //
        // Symptoms before this migration:
        //   • A direct (`is_group = FALSE`) conversation between A and B
        //     showed up as a 3-person "group" with member_count = 3 in
        //     the sidebar after someone hit "Add participant" during a
        //     1:1 call.
        //   • The call_initiate handler uses `LIMIT 1 ORDER BY user_id ASC`
        //     for non-group conversations, so the 1:1 call would
        //     deterministically ring whichever of the 3 had the lowest
        //     user_id — even if that wasn't the intended counterpart.
        //
        // Fix strategy: for every `is_group = FALSE` conversation that has
        // more than 2 participants, keep only the 2 oldest rows (by primary
        // key — these are the original pair) and delete the rest. The
        // deleted users:
        //   • were never the intended counterpart (they were injected by a
        //     button click during somebody else's call);
        //   • could never actually hear/see anything in the call (no
        //     mesh/SFU plumbing existed for 1:1 conversations);
        //   • get their own clean self-chat or DM relationship preserved
        //     because we only touch `conversation_participants` rows for
        //     the corrupted shared DM, not the user records themselves.
        //
        // Self-chats (the rare conversation where both rows reference the
        // same user_id, used as the "Notes to self" pseudo-DM) are
        // intentionally left alone — they legitimately have just 1 or 2
        // participant rows.
        //
        // Also adds a partial unique index that *prevents* future
        // corruption from sneaking through: no more than 2 rows are
        // allowed in `conversation_participants` per non-group
        // conversation. Wrapped in a DO block so it logs+continues if
        // some other tenant has already hand-cleaned the data.
        // ─────────────────────────────────────────────────────────────────
        name: '2026_06_v2_cleanup_dm_extra_participants',
        async up(query) {
            // Step 1: identify corrupted DMs (non-group with > 2 participants)
            const corruptedRes = await query(`
                SELECT cp.conversation_id, COUNT(*)::int AS member_count
                  FROM conversation_participants cp
                  JOIN conversations c ON c.id = cp.conversation_id
                 WHERE c.is_group = FALSE
                 GROUP BY cp.conversation_id
                HAVING COUNT(*) > 2
            `);
            const corruptedIds = corruptedRes.rows.map(r => r.conversation_id);
            if (corruptedIds.length > 0) {
                // Step 2: for each corrupted DM, keep the 2 oldest rows by
                // primary key and delete the rest. Doing this in a single
                // statement keeps the migration atomic per-tenant.
                await query(`
                    DELETE FROM conversation_participants
                     WHERE id IN (
                        SELECT id FROM (
                            SELECT cp.id,
                                   ROW_NUMBER() OVER (
                                       PARTITION BY cp.conversation_id
                                       ORDER BY cp.id ASC
                                   ) AS rn
                              FROM conversation_participants cp
                              JOIN conversations c ON c.id = cp.conversation_id
                             WHERE c.is_group = FALSE
                               AND cp.conversation_id = ANY($1::int[])
                        ) ranked
                        WHERE rn > 2
                     )
                `, [corruptedIds]);
                logger.info(
                    { conversationCount: corruptedIds.length },
                    'Cleaned up legacy DM conversations with extra participants'
                );
            }

            // Step 3: install a guard so this can never happen again. We
            // use a function-based partial unique index because Postgres
            // doesn't support CHECK constraints that reference other
            // rows. The index counts how many participant rows exist for
            // a given non-group conversation and rejects any insert that
            // would push the count above 2.
            //
            // Implementation: trigger-based, because Postgres unique
            // indexes can't express "count <= 2" directly.
            await query(`
                CREATE OR REPLACE FUNCTION enforce_dm_participant_limit()
                RETURNS TRIGGER AS $fn$
                DECLARE
                    is_grp BOOLEAN;
                    cnt    INTEGER;
                BEGIN
                    SELECT is_group INTO is_grp
                      FROM conversations
                     WHERE id = NEW.conversation_id;
                    IF is_grp IS NULL OR is_grp = TRUE THEN
                        RETURN NEW; -- group / unknown: no limit
                    END IF;
                    SELECT COUNT(*) INTO cnt
                      FROM conversation_participants
                     WHERE conversation_id = NEW.conversation_id;
                    IF cnt > 2 THEN
                        RAISE EXCEPTION
                          'Direct (non-group) conversation % cannot have more than 2 participants',
                          NEW.conversation_id;
                    END IF;
                    RETURN NEW;
                END
                $fn$ LANGUAGE plpgsql
            `);
            await query(`DROP TRIGGER IF EXISTS trg_enforce_dm_participant_limit ON conversation_participants`);
            await query(`
                CREATE TRIGGER trg_enforce_dm_participant_limit
                AFTER INSERT ON conversation_participants
                FOR EACH ROW
                EXECUTE FUNCTION enforce_dm_participant_limit()
            `);
        },
    },
    {
        // Chunk 6: Custom fields on tasks. Per-org catalog of admin-defined
        // extra fields (text/number/date/select/multiselect/checkbox/url) plus
        // the JSONB value rows on each task. initTenantSchema() also creates
        // these for new tenants — this migration ensures every existing
        // tenant DB picks them up on the next deploy.
        name: '2026_06_v1_custom_fields',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS custom_field_definitions (
                    id              SERIAL PRIMARY KEY,
                    org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    key             TEXT    NOT NULL,
                    label           TEXT    NOT NULL,
                    field_type      TEXT    NOT NULL CHECK(field_type IN
                                        ('text','number','date','select','multiselect','checkbox','url')),
                    description     TEXT,
                    options         JSONB   NOT NULL DEFAULT '[]'::jsonb,
                    is_required     BOOLEAN NOT NULL DEFAULT FALSE,
                    show_on_card    BOOLEAN NOT NULL DEFAULT FALSE,
                    applies_to_types JSONB  NOT NULL DEFAULT '[]'::jsonb,
                    sort_order      INTEGER NOT NULL DEFAULT 0,
                    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
                    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(org_id, key)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_cfd_org ON custom_field_definitions(org_id, is_active, sort_order)`);
            await query(`
                CREATE TABLE IF NOT EXISTS task_custom_field_values (
                    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    field_id    INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
                    value       JSONB,
                    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    updated_at  TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (task_id, field_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tcfv_field ON task_custom_field_values(field_id)`);
        },
    },
    {
        // Compensation & Payroll tables: templates, employee compensation,
        // salary slips, disbursements, payment config, and bank details.
        name: '2026_06_v3_compensation_payroll_tables',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS compensation_templates (
                    id              SERIAL PRIMARY KEY,
                    org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    name            TEXT NOT NULL,
                    description     TEXT,
                    components      JSONB NOT NULL DEFAULT '[]',
                    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
                    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(org_id, name)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_compensation_templates_org ON compensation_templates(org_id)`);

            await query(`
                CREATE TABLE IF NOT EXISTS employee_compensation (
                    id                  SERIAL PRIMARY KEY,
                    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    org_id              INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    template_id         INTEGER REFERENCES compensation_templates(id) ON DELETE SET NULL,
                    effective_from      TEXT NOT NULL,
                    effective_to        TEXT,
                    base_salary         NUMERIC(12,2) NOT NULL DEFAULT 0,
                    components          JSONB NOT NULL DEFAULT '{}',
                    currency            TEXT NOT NULL DEFAULT 'INR',
                    payment_frequency   TEXT NOT NULL DEFAULT 'monthly' CHECK(payment_frequency IN ('monthly','biweekly','weekly')),
                    bank_account        TEXT,
                    notes               TEXT,
                    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at          TIMESTAMPTZ DEFAULT NOW(),
                    updated_at          TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(user_id, effective_from)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_employee_compensation_user ON employee_compensation(user_id, effective_from DESC)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_employee_compensation_org ON employee_compensation(org_id)`);

            await query(`
                CREATE TABLE IF NOT EXISTS salary_slips (
                    id                  SERIAL PRIMARY KEY,
                    org_id              INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    pay_period_id       INTEGER NOT NULL REFERENCES pay_periods(id) ON DELETE CASCADE,
                    compensation_id     INTEGER REFERENCES employee_compensation(id) ON DELETE SET NULL,
                    slip_month          TEXT NOT NULL,
                    earnings            JSONB NOT NULL DEFAULT '{}',
                    deductions          JSONB NOT NULL DEFAULT '{}',
                    gross_earnings      NUMERIC(12,2) NOT NULL DEFAULT 0,
                    total_deductions    NUMERIC(12,2) NOT NULL DEFAULT 0,
                    net_pay             NUMERIC(12,2) NOT NULL DEFAULT 0,
                    days_worked         NUMERIC(5,2) DEFAULT 0,
                    days_absent         NUMERIC(5,2) DEFAULT 0,
                    leave_days          NUMERIC(5,2) DEFAULT 0,
                    overtime_hours      NUMERIC(6,2) DEFAULT 0,
                    status              TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generated','published','revised')),
                    generated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    published_at        TIMESTAMPTZ,
                    created_at          TIMESTAMPTZ DEFAULT NOW(),
                    updated_at          TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(org_id, user_id, pay_period_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_salary_slips_user ON salary_slips(user_id, slip_month DESC)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_salary_slips_period ON salary_slips(pay_period_id)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_salary_slips_org_month ON salary_slips(org_id, slip_month)`);

            await query(`
                CREATE TABLE IF NOT EXISTS payroll_disbursements (
                    id                          SERIAL PRIMARY KEY,
                    org_id                      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    salary_slip_id              INTEGER NOT NULL REFERENCES salary_slips(id) ON DELETE CASCADE,
                    user_id                     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    amount                      NUMERIC(12,2) NOT NULL,
                    currency                    TEXT NOT NULL DEFAULT 'INR',
                    razorpay_payout_id          TEXT,
                    razorpay_fund_account_id    TEXT,
                    transfer_mode               TEXT NOT NULL DEFAULT 'NEFT',
                    status                      TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','processed','reversed','failed')),
                    failure_reason              TEXT,
                    utr                         TEXT,
                    initiated_by                INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    initiated_at                TIMESTAMPTZ,
                    processed_at                TIMESTAMPTZ,
                    created_at                  TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(salary_slip_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_payroll_disbursements_org ON payroll_disbursements(org_id, status)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_payroll_disbursements_user ON payroll_disbursements(user_id)`);

            await query(`
                CREATE TABLE IF NOT EXISTS org_payment_config (
                    id                      SERIAL PRIMARY KEY,
                    org_id                  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    provider                TEXT NOT NULL DEFAULT 'razorpay',
                    api_key_id              TEXT,
                    api_key_secret          TEXT,
                    account_number          TEXT,
                    webhook_secret          TEXT,
                    default_transfer_mode   TEXT NOT NULL DEFAULT 'NEFT',
                    is_active               BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at              TIMESTAMPTZ DEFAULT NOW(),
                    updated_at              TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(org_id)
                )
            `);

            await query(`
                CREATE TABLE IF NOT EXISTS employee_bank_details (
                    id                          SERIAL PRIMARY KEY,
                    user_id                     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    org_id                      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    account_holder_name         TEXT NOT NULL,
                    account_number              TEXT NOT NULL,
                    ifsc_code                   TEXT NOT NULL,
                    bank_name                   TEXT,
                    account_type                TEXT NOT NULL DEFAULT 'savings',
                    razorpay_contact_id         TEXT,
                    razorpay_fund_account_id    TEXT,
                    is_verified                 BOOLEAN NOT NULL DEFAULT FALSE,
                    verified_at                 TIMESTAMPTZ,
                    created_at                  TIMESTAMPTZ DEFAULT NOW(),
                    updated_at                  TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(user_id, org_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_employee_bank_details_org ON employee_bank_details(org_id)`);
        },
    },
    {
        // ADR-0001 step 1 (PR1): v2 status service schema.
        //
        // Adds the `manual_status` / `presence_preference` / `status_message` /
        // `status_message_expires_at` / `last_activity_at` columns on `users`,
        // creates `user_presence_sessions` (per-device live presence) and
        // `user_status_events` (audit log), plus the CHECK constraints and
        // indexes.
        //
        // SAFETY:
        //   • Implementation lives in services/status/migration.js so the
        //     status service stays self-contained. We delegate to it here so
        //     existing tenants pick it up via the versioned runner, not just
        //     on a fresh-tenant initTenantSchema() call.
        //   • Idempotent — every statement is IF NOT EXISTS / guarded.
        //   • Must run BEFORE 2026_06_v5_drop_legacy_user_status_columns so
        //     the new columns exist before the old ones go away.
        name: '2026_06_v4_status_service_v2_schema',
        async up(query) {
            const { runStatusMigration } = require('../services/status/migration');
            await runStatusMigration(query);
        },
    },
    {
        name: '2026_06_v4_ctc_support',
        async up(query) {
            await query(`
                ALTER TABLE employee_compensation
                ADD COLUMN IF NOT EXISTS ctc_annual NUMERIC(12,2) NOT NULL DEFAULT 0
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS org_ctc_config (
                    org_id          INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
                    basic_pct       NUMERIC(5,2) NOT NULL DEFAULT 40,
                    hra_pct         NUMERIC(5,2) NOT NULL DEFAULT 50,
                    conveyance_pct  NUMERIC(5,2) NOT NULL DEFAULT 5,
                    pf_pct          NUMERIC(5,2) NOT NULL DEFAULT 12,
                    pf_max          NUMERIC(10,2) NOT NULL DEFAULT 1800,
                    pt_fixed        NUMERIC(10,2) NOT NULL DEFAULT 200,
                    updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    updated_at      TIMESTAMPTZ DEFAULT NOW()
                )
            `);
        },
    },
    {
        // ADR-0001 step 8: drop the legacy `users.user_status` and
        // `users.user_status_text` columns + their CHECK constraint.
        //
        // Safety:
        //   • PR7 removed every reader/writer of these columns from the
        //     application code. They have been stale since the deploy that
        //     shipped PR7, and the resolver+broadcaster path is the only
        //     source of presence/status state in production.
        //   • The status backfill in services/status/migration.js was
        //     gated on "IF EXISTS users.user_status" so it becomes a NO-OP
        //     once the columns are dropped — this migration is safe to
        //     run before, after, or interleaved with that bootstrap.
        //   • DROP CONSTRAINT IF EXISTS / DROP COLUMN IF EXISTS keep the
        //     migration idempotent across reruns and across tenants that
        //     never had the columns (fresh databases).
        name: '2026_06_v5_drop_legacy_user_status_columns',
        async up(query) {
            // The CHECK constraint name follows Postgres' default naming
            // convention `<table>_<col>_check`. We also defensively look
            // for any other CHECK on `user_status` in case an earlier
            // tenant copy used a non-default name.
            await query(`
                DO $do$
                DECLARE r record;
                BEGIN
                    FOR r IN
                        SELECT con.conname
                        FROM   pg_constraint con
                        JOIN   pg_class       rel ON rel.oid = con.conrelid
                        JOIN   pg_attribute   att ON att.attrelid = rel.oid
                                                 AND att.attnum   = ANY(con.conkey)
                        WHERE  rel.relname = 'users'
                          AND  con.contype = 'c'
                          AND  att.attname = 'user_status'
                    LOOP
                        EXECUTE 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(r.conname);
                    END LOOP;
                EXCEPTION WHEN others THEN NULL;
                END $do$
            `);
            await query(`ALTER TABLE users DROP COLUMN IF EXISTS user_status`);
            await query(`ALTER TABLE users DROP COLUMN IF EXISTS user_status_text`);
        },
    },
    {
        // Stage 3 — Projects, human-readable task keys, and per-org Git
        // integration (GitHub OAuth + webhook handling). All of these tables
        // are tenant-scoped — they're inside the per-tenant DB so each org's
        // projects / integrations live alongside their tasks, never in the
        // master DB. New tenants pick the same schema up directly from
        // initTenantSchema(); this migration backfills existing tenants.
        name: '2026_06_v6_projects_and_git_integration',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS projects (
                    id              SERIAL PRIMARY KEY,
                    org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    key             TEXT    NOT NULL,
                    name            TEXT    NOT NULL,
                    description     TEXT,
                    color           TEXT    NOT NULL DEFAULT '#6366f1',
                    lead_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    next_task_number INTEGER NOT NULL DEFAULT 1,
                    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
                    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE (org_id, key)
                )
            `);
            await query(`
                DO $do$ BEGIN
                    ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_key_format_check;
                    ALTER TABLE projects ADD CONSTRAINT projects_key_format_check
                        CHECK (key ~ '^[A-Z][A-Z0-9_]{1,9}$');
                EXCEPTION WHEN others THEN NULL;
                END $do$
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id, is_archived)`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);
            await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_number INTEGER`);
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_project_number ON tasks(project_id, task_number) WHERE project_id IS NOT NULL`);
            await query(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id) WHERE project_id IS NOT NULL`);
            await query(`
                CREATE TABLE IF NOT EXISTS org_integrations (
                    id           SERIAL PRIMARY KEY,
                    org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    provider     TEXT    NOT NULL CHECK (provider IN ('github','gitlab','bitbucket')),
                    config       JSONB   NOT NULL DEFAULT '{}'::jsonb,
                    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
                    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at   TIMESTAMPTZ DEFAULT NOW(),
                    updated_at   TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE (org_id, provider)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_integrations_org ON org_integrations(org_id, is_active)`);
            await query(`
                CREATE TABLE IF NOT EXISTS org_integration_secrets (
                    integration_id   INTEGER PRIMARY KEY REFERENCES org_integrations(id) ON DELETE CASCADE,
                    webhook_secret   TEXT,
                    access_token     TEXT,
                    refresh_token    TEXT,
                    token_expires_at TIMESTAMPTZ,
                    github_login     TEXT,
                    github_avatar    TEXT,
                    scopes           TEXT,
                    updated_at       TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            // Older tenants may already have org_integration_secrets without
            // the GitHub identity columns — ensure they're present.
            await query(`ALTER TABLE org_integration_secrets ADD COLUMN IF NOT EXISTS github_login TEXT`);
            await query(`ALTER TABLE org_integration_secrets ADD COLUMN IF NOT EXISTS github_avatar TEXT`);
            await query(`ALTER TABLE org_integration_secrets ADD COLUMN IF NOT EXISTS scopes TEXT`);
            await query(`
                CREATE TABLE IF NOT EXISTS task_git_refs (
                    id              SERIAL PRIMARY KEY,
                    task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    integration_id  INTEGER REFERENCES org_integrations(id) ON DELETE SET NULL,
                    ref_type        TEXT NOT NULL CHECK (ref_type IN ('branch','pull_request','commit')),
                    status          TEXT NOT NULL DEFAULT 'open'
                                         CHECK (status IN ('open','merged','closed','draft','committed')),
                    external_id     TEXT,
                    title           TEXT,
                    url             TEXT,
                    repository      TEXT,
                    ref_name        TEXT,
                    author_login    TEXT,
                    commit_sha      TEXT,
                    payload         JSONB,
                    event_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE (task_id, ref_type, external_id, repository)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_task_git_refs_task ON task_git_refs(task_id, event_at DESC)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_task_git_refs_status ON task_git_refs(status) WHERE status != 'merged'`);
            await query(`
                CREATE TABLE IF NOT EXISTS github_repo_connections (
                    id              SERIAL PRIMARY KEY,
                    integration_id  INTEGER NOT NULL REFERENCES org_integrations(id) ON DELETE CASCADE,
                    full_name       TEXT    NOT NULL,
                    html_url        TEXT,
                    default_branch  TEXT,
                    hook_id         BIGINT,
                    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE (integration_id, full_name)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_gh_repo_conn_integration ON github_repo_connections(integration_id, is_active)`);
        },
    },
    {
        // Attendance verification — adds the office-location + face-enrollment
        // columns required by the "Face + Location validation for clock-in"
        // feature. Without this migration `PUT /api/org/settings` and
        // `POST /api/tracker/clock-in` fail with 500 on tenants whose DB
        // was bootstrapped before the feature shipped, because the runtime
        // queries reference columns that don't exist yet.
        name: '2026_05_attendance_face_location',
        async up(query) {
            // ── organizations ────────────────────────────────────────────
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS attendance_verification_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_latitude DOUBLE PRECISION`);
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_longitude DOUBLE PRECISION`);
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_radius_m INTEGER`);
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_address TEXT`);

            // ── users ────────────────────────────────────────────────────
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS face_descriptor JSONB`);
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ`);

            // ── time_entries ────────────────────────────────────────────
            // NOTE: column names MUST match those used by the runtime code in
            // server/routes/tracker.js and the bootstrap in server/db.js.
            // Earlier revisions of this migration used different names
            // (clock_in_latitude/_longitude/_accuracy) which caused the
            // INSERT in POST /api/tracker/clock-in to fail with
            // `column "clock_in_lat" does not exist` → HTTP 500.
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_lat DOUBLE PRECISION`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_lng DOUBLE PRECISION`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_accuracy_m REAL`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_distance_m INTEGER`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS face_verified BOOLEAN`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS face_match_score REAL`);

            // Backfill: if a previous run of this migration created the
            // mis-named columns, copy their values over and drop them so the
            // runtime INSERT/SELECT statements work consistently.
            await query(`
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'time_entries' AND column_name = 'clock_in_latitude'
                    ) THEN
                        UPDATE time_entries SET clock_in_lat = clock_in_latitude
                            WHERE clock_in_lat IS NULL AND clock_in_latitude IS NOT NULL;
                        ALTER TABLE time_entries DROP COLUMN clock_in_latitude;
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'time_entries' AND column_name = 'clock_in_longitude'
                    ) THEN
                        UPDATE time_entries SET clock_in_lng = clock_in_longitude
                            WHERE clock_in_lng IS NULL AND clock_in_longitude IS NOT NULL;
                        ALTER TABLE time_entries DROP COLUMN clock_in_longitude;
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'time_entries' AND column_name = 'clock_in_accuracy'
                    ) THEN
                        UPDATE time_entries SET clock_in_accuracy_m = clock_in_accuracy
                            WHERE clock_in_accuracy_m IS NULL AND clock_in_accuracy IS NOT NULL;
                        ALTER TABLE time_entries DROP COLUMN clock_in_accuracy;
                    END IF;
                END $$;
            `);
        },
    },
    {
        // ── HOTFIX ───────────────────────────────────────────────────────
        // The original `2026_05_attendance_face_location` migration created
        // the time_entries columns with names that didn't match the runtime
        // code:
        //     migration              runtime (db.js + routes/tracker.js)
        //     ───────────────────    ────────────────────────────────────
        //     clock_in_latitude   →  clock_in_lat
        //     clock_in_longitude  →  clock_in_lng
        //     clock_in_accuracy   →  clock_in_accuracy_m
        //
        // For tenants whose DB was bootstrapped via the migration runner
        // (not via initTenantSchema in db.js), the columns the route INSERTs
        // into don't exist, so POST /api/tracker/clock-in fails with
        //   `column "clock_in_lat" of relation "time_entries" does not exist`
        // and returns HTTP 500 "Clock-in failed".
        //
        // We can't fix this by editing the original migration body — it has
        // already been recorded in `_migrations` for those tenants and won't
        // re-run. This dedicated hotfix migration runs once per tenant to:
        //   1. Add the canonical columns (clock_in_lat / clock_in_lng /
        //      clock_in_accuracy_m) if they're missing.
        //   2. Copy data out of the mis-named columns if those exist.
        //   3. Drop the mis-named columns.
        //
        // Every statement is idempotent so tenants that were never affected
        // (e.g. brand-new ones bootstrapped post-fix) skip through without
        // touching the schema.
        name: '2026_05_attendance_face_location_column_rename_fix',
        async up(query) {
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_lat DOUBLE PRECISION`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_lng DOUBLE PRECISION`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_accuracy_m REAL`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_distance_m INTEGER`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS face_verified BOOLEAN`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS face_match_score REAL`);

            await query(`
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'time_entries' AND column_name = 'clock_in_latitude'
                    ) THEN
                        UPDATE time_entries SET clock_in_lat = clock_in_latitude
                            WHERE clock_in_lat IS NULL AND clock_in_latitude IS NOT NULL;
                        ALTER TABLE time_entries DROP COLUMN clock_in_latitude;
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'time_entries' AND column_name = 'clock_in_longitude'
                    ) THEN
                        UPDATE time_entries SET clock_in_lng = clock_in_longitude
                            WHERE clock_in_lng IS NULL AND clock_in_longitude IS NOT NULL;
                        ALTER TABLE time_entries DROP COLUMN clock_in_longitude;
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'time_entries' AND column_name = 'clock_in_accuracy'
                    ) THEN
                        UPDATE time_entries SET clock_in_accuracy_m = clock_in_accuracy
                            WHERE clock_in_accuracy_m IS NULL AND clock_in_accuracy IS NOT NULL;
                        ALTER TABLE time_entries DROP COLUMN clock_in_accuracy;
                    END IF;
                END $$;
            `);
        },
    },
    {
        // Wi-Fi-first attendance verification.
        //
        // The geofence-only flow that ships in `2026_05_attendance_face_location`
        // is unreliable on most laptops: Chromium's geolocation falls back to
        // IP-based lookup when no GOOGLE_API_KEY is configured (typical for
        // packaged Electron builds), producing fixes that are tens of
        // kilometres off the actual office. That makes the "you must be in
        // the geofence" check effectively impossible to pass for many users.
        //
        // The fix is to layer a Wi-Fi check *in front of* the geofence:
        //   - admin registers the BSSIDs (MAC addresses) of the office APs
        //   - desktop client reads its current BSSID via the OS (netsh /
        //     airport / iwgetid) and sends it with the clock-in
        //   - server: if the BSSID is whitelisted → user is "at office",
        //     skip the geofence; otherwise fall back to today's geofence
        //     logic (which keeps working for Ethernet / non-Electron / etc.)
        //
        // We also add a `verified_via` column to `time_entries` so HR can
        // see which signal (wifi, geofence, none) verified each clock-in.
        name: '2026_06_v7_office_wifi_verification',
        async up(query) {
            // ── organizations ────────────────────────────────────────────
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_wifi_bssids JSONB NOT NULL DEFAULT '[]'::jsonb`);
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS office_wifi_verification_enabled BOOLEAN NOT NULL DEFAULT FALSE`);

            // ── time_entries: audit which signal verified the clock-in ──
            // Values are 'wifi' | 'geofence' | 'none' (NULL for pre-feature rows).
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS verified_via TEXT`);
            await query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_wifi_bssid TEXT`);
        },
    },
    {
        // ── In-meeting chat reliability (Phase 0.5) ──────────────────────────
        //
        // Background: in-meeting chat messages were occasionally "disappearing"
        // for users on flaky networks. Five overlapping issues caused it:
        //
        //   1. Chat lived only in React state inside useMeetingState; remounts
        //      (PiP swap, navigation, Strict Mode) gave a fresh empty Map and
        //      the network re-hydrate took ~200-800ms — perceived as data loss.
        //   2. Hydration only ran on `code` change, never on WS reconnect, so
        //      any messages sent during a brief WS drop were silently missed
        //      (the server's broadcast loop only delivered to participants
        //      currently in `status='joined'`).
        //   3. Sender-side fire-and-forget WS send had no ack — if WS was
        //      mid-reconnect the message went nowhere; the sender's optimistic
        //      bubble sat there forever, but refreshing wiped it (never
        //      persisted on the server).
        //   4. Optimistic dedup matched by (sender_id + text) which broke for
        //      files and double-sent identical text.
        //   5. Server `meeting_chat` persist errors were swallowed silently
        //      (`logger.warn` + continuing broadcast), so transient DB hiccups
        //      produced ephemeral-only messages that vanished on rejoin.
        //
        // This migration adds the DB primitive that closes hole #4 and #5:
        // a `client_msg_id` column on the messages table, with a partial
        // unique index so the server can safely `INSERT ... ON CONFLICT DO
        // NOTHING` when a client retries the same logical message after a
        // missed ack. The same column also lets the client robustly dedup
        // incoming server echoes against its pending-send queue.
        //
        // The column is nullable on purpose — every existing chat message in
        // the database (DMs, group chat, in-meeting chat from before this
        // change) keeps working unchanged.
        name: '2026_06_v8_messages_client_msg_id',
        async up(query) {
            await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_msg_id TEXT`);
            // Partial unique index: only enforce uniqueness when the client
            // actually supplied an id. Scoped by (conversation, sender) so two
            // different users' random UUIDs can't collide (and a deleted-then-
            // recreated conversation gets a fresh namespace via cascade).
            await query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg_id
                ON messages (conversation_id, sender_id, client_msg_id)
                WHERE client_msg_id IS NOT NULL
            `);
        },
    },
    {
        // Synthetic Platform Inspector users.
        //
        // The consent-gated impersonation flow used to mint its JWT against
        // the tenant's highest-role active user (e.g. "Vaishak Pramod"), so
        // the inspector spent the whole session wearing a teammate's
        // identity. Every avatar, "created by", chat presence, task
        // assignee — all wrong, and very confusing for tenant staff who
        // saw their colleague making changes they hadn't actually made.
        //
        // The new model creates a dedicated synthetic `users` row per
        // (tenant, platform_admin) pair:
        //   - role = 'platform_admin'        ← full access by design
        //   - full_name = "<Vishnu V R> (Platform Support)"
        //   - org_id / team_id / department_id = NULL
        //   - is_active = TRUE
        //   - hidden_from_directory = TRUE   ← new column
        //
        // Every "list users" / "directory" / "chat search" endpoint adds
        // `AND hidden_from_directory = FALSE` so synthetic rows never show
        // up as teammates. FK joins, RBAC, audit logs, history tables all
        // keep working because the row is real.
        name: '2026_06_v9_users_hidden_from_directory',
        async up(query) {
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_from_directory BOOLEAN NOT NULL DEFAULT FALSE`);
            await query(`CREATE INDEX IF NOT EXISTS idx_users_directory_visible ON users (org_id) WHERE hidden_from_directory = FALSE`);
        },
    },
    {
        // MFA (TOTP) columns on tenant `users`. Opt-in for tenant admins
        // (super_admin / hr_admin). initTenantSchema() also adds these for
        // new tenants — this migration backfills existing tenant DBs so the
        // /api/mfa endpoints and the login MFA gate don't 500 on a missing
        // column. All additive + idempotent.
        name: '2026_06_v10_user_mfa',
        async up(query) {
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT`);
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ`);
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT`);
            await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes JSONB`);
        },
    },
    {
        // File attachments on task comments. Adds nullable file_* columns and
        // relaxes the content NOT NULL constraint so a comment may carry just
        // a file (or text, or both). initTenantSchema() also applies these for
        // new tenants — this backfills existing tenant DBs. All idempotent.
        name: '2026_06_v11_task_comment_attachments',
        async up(query) {
            await query(`ALTER TABLE task_comments ALTER COLUMN content DROP NOT NULL`);
            await query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS file_url   TEXT`);
            await query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS file_name  VARCHAR(255)`);
            await query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS file_type  VARCHAR(100)`);
            await query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS file_size  INTEGER`);
        },
    },
    {
        // Email-based MFA recovery tokens for tenant users (super_admin /
        // hr_admin lockout escape hatch). initTenantSchema() also creates this
        // for new tenants — this backfills existing tenant DBs so the
        // /auth/mfa/request-reset + /auth/mfa/confirm-reset endpoints don't
        // 500 on a missing table. All additive + idempotent.
        name: '2026_06_v12_mfa_reset_tokens',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS mfa_reset_tokens (
                    id         SERIAL PRIMARY KEY,
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token      TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    used       BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_mfa_reset_tokens_token ON mfa_reset_tokens(token)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_mfa_reset_tokens_user ON mfa_reset_tokens(user_id)`);
        },
    },
    {
        // Push notification device tokens for mobile app (iOS/Android).
        // Stores FCM registration tokens so the backend can send push notifications
        // for incoming calls, messages, and alerts when the app is backgrounded.
        // Tokens are tenant-scoped so multi-tenant orgs don't leak device tokens
        // across workspaces. A device may have multiple tokens if the user reinstalls
        // or the app is used across multiple devices.
        name: '2026_06_v13_push_notification_device_tokens',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS device_tokens (
                    id              SERIAL PRIMARY KEY,
                    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    tenant_id       INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
                    device_token    TEXT NOT NULL,
                    platform        TEXT NOT NULL CHECK(platform IN ('ios','android','web')),
                    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(user_id, device_token)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_org ON device_tokens(tenant_id) WHERE tenant_id IS NOT NULL`);
            // NOTE: the predicate must NOT reference NOW()/CURRENT_TIMESTAMP —
            // those are STABLE, not IMMUTABLE, and Postgres rejects a partial
            // index whose predicate isn't immutable with:
            //   "functions in index predicate must be marked IMMUTABLE".
            // A plain b-tree on last_seen_at supports the same range/order
            // lookups (e.g. pruning stale tokens) without an illegal predicate.
            await query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_last_seen ON device_tokens(last_seen_at)`);
        },
    },
    {
        // Biometric ("login with your face") device credentials.
        //
        // Option-B biometric login model: the OS authenticator (Face ID /
        // Touch ID / Windows Hello / Android BiometricPrompt) performs the
        // match LOCALLY on the device and unlocks a high-entropy device secret
        // that the client stores in its secure enclave / keystore. No face or
        // biometric data ever reaches the server — we only store a one-way
        // HASH of the device secret here, exactly like a password.
        //
        // Flow:
        //   1. After a normal username/password login, the client calls
        //      POST /api/auth/biometric/enroll. The server generates a random
        //      secret, stores its hash in this table, and returns the RAW
        //      secret ONCE. The client stashes it behind the OS biometric.
        //   2. On later launches the client unlocks the secret via the OS
        //      biometric and calls POST /api/auth/biometric/login with
        //      { credentialId, deviceSecret }. The server verifies the hash
        //      and mints the normal JWT/session via finishLogin().
        //
        // Security:
        //   • secret_hash is bcrypt — never reversible.
        //   • revoked_at + a password reset / "log out everywhere" (which
        //     bumps users.token_version) invalidate the credential.
        //   • One row per (user, device); a device may re-enroll (new secret).
        name: '2026_06_v14_biometric_device_credentials',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS device_credentials (
                    id            TEXT PRIMARY KEY,
                    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    secret_hash   TEXT NOT NULL,
                    device_label  TEXT,
                    platform      TEXT NOT NULL CHECK(platform IN ('ios','android','desktop','web')),
                    last_used_at  TIMESTAMPTZ,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    revoked_at    TIMESTAMPTZ
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_device_credentials_user ON device_credentials(user_id) WHERE revoked_at IS NULL`);
        },
    },
    {
        // WebAuthn / passkeys for web biometric login (Phase 3).
        //
        // Unlike the mobile/desktop `device_credentials` model (a shared
        // secret), WebAuthn uses public-key cryptography: the browser's
        // platform authenticator (Touch ID / Windows Hello / Face ID / a
        // security key) holds the PRIVATE key and never exports it. We store
        // only the PUBLIC key + a monotonic signature counter here.
        //
        // On login the server issues a random challenge; the authenticator
        // signs it with the private key (gated by the OS biometric) and we
        // verify the signature against the stored public key. No password, no
        // shared secret, no biometric data ever leaves the device.
        //
        // credential_id is the base64url WebAuthn credential ID (unique per
        // passkey). counter guards against cloned-authenticator replay.
        name: '2026_06_v15_webauthn_credentials',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS webauthn_credentials (
                    id             SERIAL PRIMARY KEY,
                    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    credential_id  TEXT NOT NULL UNIQUE,
                    public_key     TEXT NOT NULL,
                    counter        BIGINT NOT NULL DEFAULT 0,
                    transports     TEXT,
                    device_label   TEXT,
                    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_used_at   TIMESTAMPTZ,
                    revoked_at     TIMESTAMPTZ
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id) WHERE revoked_at IS NULL`);
        },
    },
    {
        // Phase 5 — per-tenant feature flag for biometric / passkey login.
        //
        // Adds `organizations.biometric_login_enabled` (default TRUE so the
        // feature keeps working for every existing tenant on deploy). When an
        // admin turns it OFF, the server refuses both NEW enrollments AND
        // biometric/passkey LOGINS for users in that org — see the
        // `isBiometricLoginEnabled()` gate in routes/auth.ts. Password login
        // is unaffected. The toggle lives on the org-settings screen
        // (PUT /api/org/settings).
        name: '2026_06_v16_biometric_login_enabled_flag',
        async up(query) {
            await query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS biometric_login_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
        },
    },
    {
        // Chat media pipeline foundation — durable per-message media job state so
        // queued / processing / failed / cancelled can survive app reconnects and
        // be reconciled over websocket progress events.
        name: '2026_06_v17_chat_media_jobs_foundation',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS chat_media_jobs (
                    id                SERIAL PRIMARY KEY,
                    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE UNIQUE,
                    conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    sender_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    status            TEXT NOT NULL DEFAULT 'queued'
                                        CHECK (status IN ('queued','processing','completed','failed','cancelled')),
                    progress          INTEGER NOT NULL DEFAULT 0,
                    attempts          INTEGER NOT NULL DEFAULT 0,
                    failure_reason    TEXT,
                    cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at        TIMESTAMPTZ DEFAULT NOW(),
                    updated_at        TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_chat_media_jobs_conv ON chat_media_jobs(conversation_id, created_at DESC)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_chat_media_jobs_sender ON chat_media_jobs(sender_id, created_at DESC)`);
        },
    },
    {
        // Chat media staged-pipeline metadata. Adds explicit stage + resumable/
        // checksum fields so media processing can run as durable queued jobs.
        name: '2026_06_v18_chat_media_pipeline_stages',
        async up(query) {
            await query(`ALTER TABLE chat_media_jobs ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued'`);
            await query(`ALTER TABLE chat_media_jobs ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT`);
            await query(`ALTER TABLE chat_media_jobs ADD COLUMN IF NOT EXISTS resumable_token TEXT`);
            await query(`ALTER TABLE chat_media_jobs ADD COLUMN IF NOT EXISTS pipeline_meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
        },
    },
    {
        // Phase 5 — tenant-scoped notification lifecycle telemetry for the
        // mobile push-routing overhaul. Stores structured client events
        // (displayed, tapped, route_persisted, route_consumed, etc.) so the
        // backend can aggregate success-rate / latency metrics for the web
        // dashboard.
        name: '2026_07_v19_notification_metric_events',
        async up(query) {
            await query(`
                CREATE TABLE IF NOT EXISTS notification_metric_events (
                    id                SERIAL PRIMARY KEY,
                    client_event_id   TEXT NOT NULL UNIQUE,
                    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dedupe_key        TEXT,
                    conversation_id   TEXT,
                    message_id        TEXT,
                    notification_type TEXT,
                    level             TEXT NOT NULL DEFAULT 'INFO',
                    event             TEXT NOT NULL,
                    state             TEXT,
                    source            TEXT,
                    duration_ms       INTEGER,
                    error_hash        TEXT,
                    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
                    client_timestamp  TIMESTAMPTZ NOT NULL,
                    received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_notification_metric_events_timestamp
                ON notification_metric_events(client_timestamp DESC)
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_notification_metric_events_dedupe
                ON notification_metric_events(dedupe_key)
                WHERE dedupe_key IS NOT NULL
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_notification_metric_events_state
                ON notification_metric_events(state, client_timestamp DESC)
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_notification_metric_events_user
                ON notification_metric_events(user_id, client_timestamp DESC)
            `);
        },
    },
];

interface MigrationOpts {
    label?: string;
}

interface MigrationResult {
    applied: string[];
    skipped: number;
    failed: string[];
}

/**
 * Apply pending migrations against a single tenant database (or the master
 * legacy DB). Safe to call multiple times.
 */
async function runTenantMigrations(query: QueryFn, opts: MigrationOpts = {}): Promise<MigrationResult> {
    const label = opts.label || 'tenant';
    const applied: string[] = [];
    const failed: string[] = [];
    let skipped = 0;

    // Ensure the tracking table exists (initTenantSchema also creates this,
    // but we don't want to depend on call order).
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message, label }, 'Migration runner: failed to ensure _migrations table');
        return { applied, skipped, failed };
    }

    // Read the set of already-applied names in one query
    let appliedSet = new Set<string>();
    try {
        const res = await query('SELECT name FROM _migrations');
        appliedSet = new Set(res.rows.map((r) => (r as { name: string }).name));
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message, label }, 'Migration runner: failed to read _migrations');
        return { applied, skipped, failed };
    }

    for (const mig of MIGRATIONS) {
        if (appliedSet.has(mig.name)) {
            skipped++;
            continue;
        }
        try {
            await mig.up(query);
            await query(
                'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
                [mig.name],
            );
            applied.push(mig.name);
            logger.info({ migration: mig.name, label }, 'Migration applied');
        } catch (err: unknown) {
            failed.push(mig.name);
            logger.error({
                migration: mig.name,
                label,
                err: (err as Error).message,
            }, 'Migration failed (non-fatal — will retry on next sweep)');
        }
    }

    // Always re-run the Agile defaults seeder. It's idempotent and only does
    // work for orgs that haven't been seeded yet (or whose tasks still need
    // backfilling). This makes the customisable Work Item Types / Workflow
    // States feature available to every existing tenant on next deploy with
    // zero manual intervention.
    try {
        const { seedAgileDefaults } = require('../db');
        await seedAgileDefaults(query);
    } catch (err: unknown) {
        logger.error({ err: (err as Error).message, label }, 'Agile defaults seeding failed (non-fatal)');
    }

    return { applied, skipped, failed };
}

/**
 * Iterate every active tenant and apply pending migrations to their DB.
 * Intended to be called once at server startup (after `initDB()`).
 *
 * Lazy-loads tenantManager to avoid the circular-import that exists between
 * tenantManager → db → migrationRunner.
 */
interface SweepTotals {
    applied: number;
    skipped: number;
    failed: number;
    tenants: number;
}

async function sweepAllTenants(): Promise<SweepTotals> {
    const { forEachTenant } = require('./tenantManager');
    const totals: SweepTotals = { applied: 0, skipped: 0, failed: 0, tenants: 0 };

    await forEachTenant(async (db: { query: QueryFn }, tenant: { slug?: string; db_name?: string }) => {
        totals.tenants++;
        const label = tenant.slug || tenant.db_name;
        const r = await runTenantMigrations(db.query, { label });
        totals.applied += r.applied.length;
        totals.skipped += r.skipped;
        totals.failed += r.failed.length;
        // Surface per-tenant failures loudly. A silently-failing migration (e.g.
        // the device_tokens table never gets created) otherwise hides forever,
        // breaking features like push notifications with no obvious cause.
        if (r.failed.length > 0) {
            logger.error(
                { label, failedMigrations: r.failed },
                'Migration sweep: tenant has FAILED migrations — feature schema may be incomplete',
            );
        }
    }, { label: 'migration-sweep' });

    if (totals.failed > 0) {
        logger.error(totals, 'Migration sweep complete WITH FAILURES — see per-tenant errors above');
    } else {
        logger.info(totals, 'Migration sweep complete');
    }
    return totals;
}

const expectedMigrationCount = MIGRATIONS.length;

export {
    MIGRATIONS,
    runTenantMigrations,
    sweepAllTenants,
    expectedMigrationCount,
};
