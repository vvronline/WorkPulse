/**
 * Migration runner — regression tests for the A2 squash.
 *
 * Guards the invariants that make the SQL-file migration system safe:
 *   1. `.sql` migrations are discovered and `expectedMigrationCount` matches.
 *   2. The catch-up file contains every object `initTenantSchema()` omits.
 *      (26 objects — see scripts/analyze-migration-coverage.mjs.)
 *   3. Migrations apply in filename order and are recorded in `_migrations`.
 *   4. Already-applied migrations are skipped.
 *   5. A failing migration is non-fatal and is NOT recorded.
 *   6. Every top-level DDL statement is idempotent.
 */
import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "platform", "db", "migrations");

describe("migration files", () => {
    it("ships at least one .sql migration", () => {
        const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
        expect(files.length).toBeGreaterThan(0);
    });

    it("uses zero-padded numeric prefixes so lexical order == apply order", () => {
        const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
        for (const f of files) {
            expect(f).toMatch(/^\d{4}_/);
        }
        expect([...files].sort()).toEqual(files.sort());
    });

    it("expectedMigrationCount matches the file count", () => {
        const { expectedMigrationCount } = require("../utils/migrationRunner");
        const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
        expect(expectedMigrationCount).toBe(files.length);
    });
});

describe("0002_migration_catchup.sql", () => {
    const sql = fs.readFileSync(
        path.join(MIGRATIONS_DIR, "0002_migration_catchup.sql"),
        "utf8",
    ).toLowerCase();

    // These are the objects that initTenantSchema() (db.ts) never creates.
    // If any goes missing, a newly-provisioned tenant loses that feature.
    it.each([
        ["device_tokens", "push notifications"],
        ["webauthn_credentials", "biometric login"],
        ["device_credentials", "biometric login"],
        ["mfa_reset_tokens", "MFA"],
        ["sprint_burndown_snapshots", "burndown charts"],
        ["sprint_retro_votes", "retro voting"],
        ["user_presence_sessions", "status service v2"],
        ["user_status_events", "status service v2"],
    ])("creates table %s (%s)", (table) => {
        expect(sql).toMatch(new RegExp(`create table if not exists\\s+${table}\\b`));
    });

    it.each([
        "mfa_secret",
        "mfa_enabled",
        "mfa_recovery_codes",
        "biometric_login_enabled",
        "cycle_started_at",
        "lead_started_at",
    ])("adds column %s", (col) => {
        expect(sql).toMatch(new RegExp(`add column if not exists\\s+${col}\\b`));
    });

    it("contains no leaked JS template interpolation", () => {
        expect(sql).not.toContain("${");
        expect(sql).not.toContain("`");
    });

    it("has only idempotent top-level DDL", () => {
        // DO $$ ... END $$ blocks self-guard with IF EXISTS, so exclude them.
        const topLevel = sql.replace(/do \$\$[\s\S]*?end \$\$;/g, "");
        expect(topLevel).not.toMatch(/create table (?!if not exists)/);
        expect(topLevel).not.toMatch(/create (?:unique )?index (?!if not exists)/);
        expect(topLevel).not.toMatch(/add column (?!if not exists)/);
        expect(topLevel).not.toMatch(/drop table (?!if exists)/);
        expect(topLevel).not.toMatch(/drop column (?!if exists)/);
    });

    it("uses no CONCURRENTLY (incompatible with multi-statement transactions)", () => {
        expect(sql).not.toContain("concurrently");
    });
});

describe("runTenantMigrations", () => {
    const { runTenantMigrations } = require("../utils/migrationRunner");

    /** Minimal fake query fn that records every SQL string it receives. */
    function makeQuery(opts: { applied?: string[]; failOn?: RegExp } = {}) {
        const seen: string[] = [];
        const recorded: string[] = [];
        const query = jest.fn(async (sql: string, params?: unknown[]) => {
            seen.push(sql);
            if (opts.failOn && opts.failOn.test(sql)) throw new Error("boom");
            if (/SELECT name FROM _migrations/i.test(sql)) {
                return { rows: (opts.applied || []).map((name) => ({ name })), rowCount: 0 };
            }
            if (/INSERT INTO _migrations/i.test(sql)) {
                recorded.push(String(params?.[0]));
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        return { query, seen, recorded };
    }

    it("applies pending migrations and records them", async () => {
        const { query, recorded } = makeQuery();
        const res = await runTenantMigrations(query, { label: "test" });

        expect(res.failed).toEqual([]);
        expect(res.applied).toContain("0002_migration_catchup");
        expect(recorded).toContain("0002_migration_catchup");
    });

    it("skips migrations already recorded in _migrations", async () => {
        const { query, recorded } = makeQuery({ applied: ["0002_migration_catchup"] });
        const res = await runTenantMigrations(query, { label: "test" });

        expect(res.applied).not.toContain("0002_migration_catchup");
        expect(res.skipped).toBeGreaterThan(0);
        expect(recorded).not.toContain("0002_migration_catchup");
    });

    it("ensures the _migrations ledger exists before reading it", async () => {
        const { query, seen } = makeQuery();
        await runTenantMigrations(query, { label: "test" });

        const createIdx = seen.findIndex((s) => /CREATE TABLE IF NOT EXISTS _migrations/i.test(s));
        const readIdx = seen.findIndex((s) => /SELECT name FROM _migrations/i.test(s));
        expect(createIdx).toBeGreaterThanOrEqual(0);
        expect(createIdx).toBeLessThan(readIdx);
    });

    it("treats a failing migration as non-fatal and does not record it", async () => {
        // Fail on the catch-up body (it creates device_tokens), not on ledger SQL.
        const { query, recorded } = makeQuery({ failOn: /device_tokens/i });
        const res = await runTenantMigrations(query, { label: "test" });

        expect(res.failed).toContain("0002_migration_catchup");
        expect(recorded).not.toContain("0002_migration_catchup");
    });

    it("returns empty results when the ledger cannot be created", async () => {
        const query = jest.fn(async () => { throw new Error("db down"); });
        const res = await runTenantMigrations(query as any, { label: "test" });

        expect(res.applied).toEqual([]);
        expect(res.failed).toEqual([]);
    });

    it("acquires a transaction-scoped advisory lock before migration SQL", async () => {
        const { query } = makeQuery();
        const seen: string[] = [];
        const transaction = jest.fn(async (fn: any) => fn({
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                seen.push(sql);
                // Delegate ledger/select/migration behavior to the existing fake.
                return query(sql, params);
            }),
        }));

        await runTenantMigrations(query, { label: "wp_test", transaction });

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(seen[0]).toMatch(/pg_advisory_xact_lock\(hashtext/);
        expect(seen[1]).toMatch(/CREATE TABLE IF NOT EXISTS _migrations/);
    });

    it("propagates a migration failure so the advisory-lock transaction can roll back", async () => {
        const query = jest.fn();
        const transaction = jest.fn(async (fn: any) => fn({
            query: jest.fn(async (sql: string) => {
                if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 1 };
                if (/CREATE TABLE IF NOT EXISTS _migrations/.test(sql)) return { rows: [], rowCount: 0 };
                if (/SELECT name FROM _migrations/.test(sql)) return { rows: [], rowCount: 0 };
                throw new Error("ddl failed");
            }),
        }));

        await expect(runTenantMigrations(query as any, {
            label: "wp_rollback",
            transaction,
        })).rejects.toThrow("ddl failed");
    });
});

/**
 * The upgrade path for the EXISTING production database.
 *
 * `default` already has the 30 pre-squash migration names recorded. The
 * catch-up file recreates `sprint_retrospectives`, so replaying it there would
 * delete live retrospectives. It must be adopted, not executed.
 */
describe("legacy adoption (pre-squash databases)", () => {
    const { runTenantMigrations } = require("../utils/migrationRunner");

    const LEGACY_30 = [
        "2026_05_v1_index_users_org_active",
        "2026_05_v1_index_audit_logs_actor_created",
        "2026_05_v1_index_audit_logs_entity_created",
        "2026_05_v1_agile_customisation_tables",
        "2026_05_v2_sprint_lifecycle",
        "2026_05_v3_cycle_time_and_retros",
        "2026_05_v4_retro_cleanup",
        "2026_06_v1_branding_and_email_templates",
        "2026_06_v2_cleanup_dm_extra_participants",
        "2026_06_v1_custom_fields",
        "2026_06_v3_compensation_payroll_tables",
        "2026_06_v4_status_service_v2_schema",
        "2026_06_v4_ctc_support",
        "2026_06_v5_drop_legacy_user_status_columns",
        "2026_06_v6_projects_and_git_integration",
        "2026_05_attendance_face_location",
        "2026_05_attendance_face_location_column_rename_fix",
        "2026_06_v7_office_wifi_verification",
        "2026_06_v8_messages_client_msg_id",
        "2026_06_v9_users_hidden_from_directory",
        "2026_06_v10_user_mfa",
        "2026_06_v11_task_comment_attachments",
        "2026_06_v12_mfa_reset_tokens",
        "2026_06_v13_push_notification_device_tokens",
        "2026_06_v14_biometric_device_credentials",
        "2026_06_v15_webauthn_credentials",
        "2026_06_v16_biometric_login_enabled_flag",
        "2026_06_v17_chat_media_jobs_foundation",
        "2026_06_v18_chat_media_pipeline_stages",
        "2026_07_v19_notification_metric_events",
    ];

    function makeQuery(applied: string[]) {
        const ddl: string[] = [];
        const recorded: string[] = [];
        const query = jest.fn(async (sql: string, params?: unknown[]) => {
            if (/SELECT name FROM _migrations/i.test(sql)) {
                return { rows: applied.map((name) => ({ name })), rowCount: 0 };
            }
            if (/INSERT INTO _migrations/i.test(sql)) {
                recorded.push(String(params?.[0]));
                return { rows: [], rowCount: 1 };
            }
            if (/CREATE TABLE IF NOT EXISTS _migrations/i.test(sql)) {
                return { rows: [], rowCount: 0 };
            }
            ddl.push(sql);
            return { rows: [], rowCount: 0 };
        });
        return { query, ddl, recorded };
    }

    it("adopts the catch-up without executing it when all 30 legacy names exist", async () => {
        const { query, ddl, recorded } = makeQuery(LEGACY_30);
        await runTenantMigrations(query, { label: "default" });

        // Recorded as applied…
        expect(recorded).toContain("0002_migration_catchup");
        // …but the destructive SQL never ran.
        const executed = ddl.join("\n").toLowerCase();
        expect(executed).not.toContain("drop table if exists sprint_retrospectives");
        expect(executed).not.toContain("create table if not exists device_tokens");
    });

    it("executes the catch-up on a fresh database", async () => {
        const { query, ddl, recorded } = makeQuery([]);
        await runTenantMigrations(query, { label: "new-tenant" });

        expect(recorded).toContain("0002_migration_catchup");
        const executed = ddl.join("\n").toLowerCase();
        expect(executed).toContain("create table if not exists device_tokens");
    });

    it("executes the catch-up when only some legacy migrations ran", async () => {
        const { query, ddl } = makeQuery(LEGACY_30.slice(0, 10));
        await runTenantMigrations(query, { label: "partial" });

        const executed = ddl.join("\n").toLowerCase();
        expect(executed).toContain("create table if not exists device_tokens");
    });

    it("does not re-adopt when the catch-up is already recorded", async () => {
        const { query, recorded } = makeQuery([...LEGACY_30, "0002_migration_catchup"]);
        await runTenantMigrations(query, { label: "already-adopted" });

        expect(recorded).not.toContain("0002_migration_catchup");
    });
});
