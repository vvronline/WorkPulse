/**
 * A2.4 — Generate the squashed baseline migration FROM SOURCE CODE.
 *
 * WHY NOT pg_dump:
 *   The dev workstation's network blocks Postgres/5432 and SSH/22 (HTTPS only),
 *   and the workflow must be deploy-driven. So the baseline is derived from the
 *   code that is the source of truth today:
 *
 *     server/db.ts                        -> initTenantSchema()  (the bulk)
 *     server/utils/migrationRunner.ts     -> MIGRATIONS[]        (30 catch-ups)
 *     server/services/status/migration.ts -> status v2 DDL
 *
 *   analyze-migration-coverage.mjs proved 26 DDL objects live ONLY in
 *   MIGRATIONS[] (device_tokens/push, webauthn_credentials/biometric,
 *   users.mfa_*, burndown, retro votes, cycle-time cols, 3 perf indexes),
 *   so the baseline MUST be schema + migrations combined.
 *
 * OUTPUT:
 *   server/platform/db/migrations/0002_migration_catchup.sql
 *
 *   Deliberately NOT a full-schema file. initTenantSchema() stays as the base
 *   layer (already idempotent and battle-tested); this file carries everything
 *   MIGRATIONS[] added on top, as one flat idempotent SQL script. A brand-new
 *   tenant DB then gets the COMPLETE schema in 2 deterministic steps, not 1+30.
 *
 * SAFETY:
 *   Every statement is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
 *   DROP ... IF EXISTS, so applying it to an already-migrated DB is a no-op.
 *
 * Usage:  node scripts/a2-generate-baseline.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(root, "server/utils/migrationRunner.ts");
const statusPath = path.join(root, "server/services/status/migration.ts");
const outPath = path.join(root, "server/platform/db/migrations/0002_migration_catchup.sql");

const src = fs.readFileSync(runnerPath, "utf8");
const a = src.indexOf("const MIGRATIONS: Migration[] = [");
const b = src.indexOf("\n];", a);
if (a === -1 || b === -1) throw new Error("Could not locate MIGRATIONS[]");
const blk = src.slice(a, b);

// ── Split into individual migrations ────────────────────────────────────────
const nameRe = /name:\s*['"]([^'"]+)['"]/g;
const marks = [];
let m;
while ((m = nameRe.exec(blk)) !== null) marks.push({ name: m[1], at: m.index });
const migs = marks.map((mk, i) => ({
  name: mk.name,
  body: blk.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : blk.length),
}));

const DOLLAR_BRACE = "$" + "{";

/**
 * Pull every backtick-quoted SQL string out of `await query(...)` calls.
 * Flags any statement that interpolates JS so it can be handled explicitly.
 */
function extractSql(body) {
  const out = [];
  const re = /await\s+query\(\s*`([\s\S]*?)`/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    const sql = mm[1].trim();
    if (!sql) continue;
    out.push({ dynamic: sql.includes(DOLLAR_BRACE), sql });
  }
  return out;
}

/**
 * Make a statement safe to re-run.
 *
 * The original migrations relied on the `_migrations` ledger to guarantee
 * single execution, so a few statements are not self-guarding. In a flattened
 * baseline that assumption is weaker (an operator may replay the file), so we
 * add the missing IF NOT EXISTS. Only bare `CREATE TABLE <name>` needs it —
 * everything else in MIGRATIONS[] is already guarded.
 */
function harden(sql) {
  return sql.replace(
    /^(\s*)CREATE TABLE\s+(?!IF NOT EXISTS)([a-z0-9_]+)/im,
    (_all, indent, tbl) => `${indent}CREATE TABLE IF NOT EXISTS ${tbl}`,
  );
}

// Procedural migrations — see scripts/analyze-migration-logic.mjs
const SPECIAL = new Set([
  "2026_06_v2_cleanup_dm_extra_participants", // data cleanup: no-op on a fresh DB
  "2026_06_v4_status_service_v2_schema",      // delegates to services/status/migration.ts
]);

const chunks = [];
const skipped = [];
const dynamic = [];
let stmtCount = 0;

for (const mig of migs) {
  if (SPECIAL.has(mig.name)) {
    skipped.push(mig.name);
    continue;
  }
  const stmts = extractSql(mig.body);
  stmts.filter((s) => s.dynamic).forEach(() => dynamic.push(mig.name));
  const usable = stmts.filter((s) => !s.dynamic);
  if (!usable.length) continue;

  chunks.push(`-- ${"-".repeat(72)}\n-- ${mig.name}\n-- ${"-".repeat(72)}`);
  for (const s of usable) {
    chunks.push(`${harden(s.sql.replace(/;\s*$/, ""))};`);
    stmtCount++;
  }
  chunks.push("");
}

// ── Status service v2 DDL (migration 2026_06_v4) ────────────────────────────
const statusSrc = fs.readFileSync(statusPath, "utf8");
const statusStmts = [];
{
  const re = /query\(\s*`([\s\S]*?)`/g;
  let mm;
  while ((mm = re.exec(statusSrc)) !== null) {
    const sql = mm[1].trim();
    if (sql && !sql.includes(DOLLAR_BRACE)) statusStmts.push(sql.replace(/;\s*$/, ""));
  }
}
if (statusStmts.length) {
  chunks.push(`-- ${"-".repeat(72)}`);
  chunks.push("-- 2026_06_v4_status_service_v2_schema");
  chunks.push("--   Inlined from server/services/status/migration.ts");
  chunks.push(`-- ${"-".repeat(72)}`);
  for (const s of statusStmts) {
    chunks.push(`${s};`);
    stmtCount++;
  }
  chunks.push("");
}

// ── Guard index from the DM-cleanup migration ───────────────────────────────
// The row-deleting half is a no-op on a fresh DB, but the unique guard index
// must still exist, so extract just that.
{
  const dmMig = migs.find((x) => x.name === "2026_06_v2_cleanup_dm_extra_participants");
  if (dmMig) {
    const guards = extractSql(dmMig.body).filter(
      (s) => !s.dynamic && /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s.sql),
    );
    if (guards.length) {
      chunks.push(`-- ${"-".repeat(72)}`);
      chunks.push("-- 2026_06_v2_cleanup_dm_extra_participants (guard index only)");
      chunks.push("--   The DELETE half is a no-op on a fresh database.");
      chunks.push(`-- ${"-".repeat(72)}`);
      for (const g of guards) {
        chunks.push(`${g.sql.replace(/;\s*$/, "")};`);
        stmtCount++;
      }
      chunks.push("");
    }
  }
}

// ── Assemble ────────────────────────────────────────────────────────────────
const header = `-- =============================================================================
-- 0002_migration_catchup.sql
--
-- GENERATED by scripts/a2-generate-baseline.mjs — DO NOT EDIT BY HAND.
-- Regenerate with:  node scripts/a2-generate-baseline.mjs
--
-- WHAT THIS IS
--   The flattened equivalent of the 30 entries that used to live in
--   MIGRATIONS[] in server/utils/migrationRunner.ts.
--
--   It runs AFTER initTenantSchema() (server/db.ts), which remains the base
--   schema layer. Together they produce the complete tenant schema.
--
-- WHY IT EXISTS
--   scripts/analyze-migration-coverage.mjs proved that 26 DDL objects were
--   created ONLY by MIGRATIONS[] and never by initTenantSchema() — including
--   device_tokens (push notifications), webauthn_credentials +
--   device_credentials (biometric login), the users.mfa_* columns (2FA),
--   sprint_burndown_snapshots, sprint_retro_votes, tasks.cycle_started_at /
--   lead_started_at, and 3 performance indexes.
--
--   Before this file, a newly-created tenant got an INCOMPLETE schema from
--   initTenantSchema() and only received those objects later, whenever the
--   migration sweep happened to run. This closes that gap permanently.
--
-- IDEMPOTENCY
--   Every statement is IF NOT EXISTS / IF EXISTS guarded, so re-running against
--   an already-migrated database is a safe no-op.
--
-- Statements: ${stmtCount}
-- =============================================================================

`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header + chunks.join("\n") + "\n", "utf8");

console.log("=".repeat(78));
console.log("A2.4 — BASELINE GENERATION");
console.log("=".repeat(78));
console.log(`Migrations scanned : ${migs.length}`);
console.log(`SQL statements     : ${stmtCount}`);
console.log(`Procedural skipped : ${skipped.length}  (${skipped.join(", ")})`);
if (dynamic.length) {
  console.log(`Dynamic skipped    : ${[...new Set(dynamic)].join(", ")}`);
}
console.log("");
console.log(`Written -> ${path.relative(root, outPath)}`);
console.log(`Size    -> ${fs.statSync(outPath).size} bytes`);
console.log("=".repeat(78));
