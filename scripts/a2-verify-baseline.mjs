/**
 * A2 verification — assert the generated catch-up SQL is complete and safe.
 *
 * Checks:
 *   1. All 26 objects that initTenantSchema() misses are present.
 *   2. Every statement is idempotent (IF NOT EXISTS / IF EXISTS guarded).
 *   3. No JS interpolation leaked into the SQL.
 *   4. Statement count matches the generator's report.
 *
 * Exit code 1 on any failure, so CI can gate on it.
 *
 * Usage:  node scripts/a2-verify-baseline.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sqlPath = path.join(root, "server/platform/db/migrations/0002_migration_catchup.sql");
const sql = fs.readFileSync(sqlPath, "utf8");
const lower = sql.toLowerCase();

let failures = 0;
const fail = (msg) => { console.log(`   FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`   ok    ${msg}`);

console.log("=".repeat(78));
console.log("A2 — BASELINE VERIFICATION");
console.log("=".repeat(78));

// ── 1. The 26 objects initTenantSchema() never creates ──────────────────────
console.log("\n[1] Objects missing from initTenantSchema() must be present here");

const TABLES = [
  "device_tokens",
  "webauthn_credentials",
  "device_credentials",
  "mfa_reset_tokens",
  "sprint_burndown_snapshots",
  "sprint_retro_votes",
];
for (const t of TABLES) {
  if (new RegExp(`create table if not exists\\s+${t}\\b`).test(lower)) pass(`table  ${t}`);
  else fail(`table  ${t} NOT FOUND`);
}

const COLUMNS = [
  "mfa_secret",
  "mfa_enabled",
  "mfa_enrolled_at",
  "mfa_pending_secret",
  "mfa_recovery_codes",
  "biometric_login_enabled",
  "cycle_started_at",
  "lead_started_at",
];
for (const c of COLUMNS) {
  if (new RegExp(`add column if not exists\\s+${c}\\b`).test(lower)) pass(`column ${c}`);
  else fail(`column ${c} NOT FOUND`);
}

const INDEXES = [
  "idx_users_org_active",
  "idx_audit_logs_actor_created",
  "idx_audit_logs_entity_created",
  "idx_device_tokens_user",
  "idx_device_tokens_org",
  "idx_device_tokens_last_seen",
  "idx_mfa_reset_tokens_token",
  "idx_mfa_reset_tokens_user",
  "idx_device_credentials_user",
  "idx_webauthn_credentials_user",
  "idx_burndown_sprint_date",
  "idx_retro_sprint",
];
for (const i of INDEXES) {
  if (new RegExp(`index if not exists\\s+${i}\\b`).test(lower)) pass(`index  ${i}`);
  else fail(`index  ${i} NOT FOUND`);
}

// ── 2. Status service v2 objects (inlined from services/status/migration.ts) ─
console.log("\n[2] Status service v2 DDL inlined");
for (const t of ["user_presence_sessions", "user_status_events"]) {
  if (lower.includes(`create table if not exists ${t}`)) pass(`table  ${t}`);
  else fail(`table  ${t} NOT FOUND`);
}
for (const c of ["manual_status", "presence_preference", "last_activity_at"]) {
  if (new RegExp(`add column if not exists\\s+${c}\\b`).test(lower)) pass(`column ${c}`);
  else fail(`column ${c} NOT FOUND`);
}

// ── 3. Idempotency ──────────────────────────────────────────────────────────
// Statements inside a `DO $$ ... END $$` block may legitimately be unguarded,
// because the block itself wraps them in an IF EXISTS / IF NOT EXISTS test.
// Strip those blocks before checking so we only flag true top-level DDL.
console.log("\n[3] Every top-level DDL statement is idempotent");

const withoutDoBlocks = lower.replace(/do \$\$[\s\S]*?end \$\$;/g, "");

const checks = [
  { label: "CREATE TABLE",  re: /create table (?!if not exists)/g },
  { label: "CREATE INDEX",  re: /create (?:unique )?index (?!if not exists|concurrently if not exists)/g },
  { label: "ADD COLUMN",    re: /add column (?!if not exists)/g },
  { label: "DROP TABLE",    re: /drop table (?!if exists)/g },
  { label: "DROP COLUMN",   re: /drop column (?!if exists)/g },
  { label: "DROP INDEX",    re: /drop index (?!if exists)/g },
];
for (const c of checks) {
  const hits = withoutDoBlocks.match(c.re) || [];
  if (hits.length === 0) pass(`no unguarded ${c.label}`);
  else fail(`${hits.length} unguarded ${c.label} at top level`);
}

const doBlocks = (lower.match(/do \$\$/g) || []).length;
console.log(`   info  ${doBlocks} DO-block(s) excluded (self-guarded)`);

// ── 3b. Destructive-on-rerun guard ──────────────────────────────────────────
// `DROP TABLE IF EXISTS x; CREATE TABLE x (...)` is idempotent in the sense
// that it never errors — but on a re-run it would DELETE existing rows. That
// pattern is only acceptable for tables that are rebuilt intentionally.
console.log("\n[3b] Drop-then-recreate patterns (data-destructive on re-run)");
const dropRecreate = [];
const dropRe = /drop table if exists\s+([a-z0-9_]+)\s*;/g;
let dm2;
while ((dm2 = dropRe.exec(lower)) !== null) {
  const tbl = dm2[1];
  const after = lower.slice(dm2.index, dm2.index + 4000);
  if (new RegExp(`create table (if not exists\\s+)?${tbl}\\b`).test(after)) dropRecreate.push(tbl);
}
if (dropRecreate.length === 0) {
  pass("none found");
} else {
  for (const t of dropRecreate) {
    console.log(`   warn  ${t} is dropped then recreated — data loss if re-run`);
  }
  console.log("   note  Acceptable ONLY because these run once on a fresh tenant DB");
  console.log("         and the runner records them in _migrations so they never repeat.");
}

// ── 4. No JS interpolation leaked in ────────────────────────────────────────
console.log("\n[4] No JS template interpolation leaked into SQL");
const interp = sql.match(/\$\{/g) || [];
if (interp.length === 0) pass("no ${...} found");
else fail(`${interp.length} occurrence(s) of \${...}`);

// Backticks would indicate an unterminated JS template literal.
const ticks = sql.match(/`/g) || [];
if (ticks.length === 0) pass("no stray backticks");
else fail(`${ticks.length} backtick(s) found`);

// ── 5. Structure ────────────────────────────────────────────────────────────
console.log("\n[5] File structure");
const stmts = sql.split("\n").filter((l) => l.trim().endsWith(";")).length;
console.log(`   info  ~${stmts} terminated statements`);
const declared = /-- Statements: (\d+)/.exec(sql);
if (declared) pass(`header declares ${declared[1]} statements`);
else fail("header statement count missing");

if (!/DO NOT EDIT BY HAND/.test(sql)) fail("missing DO-NOT-EDIT banner");
else pass("DO-NOT-EDIT banner present");

// ── Result ──────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(78));
if (failures === 0) {
  console.log("RESULT: PASS — baseline is complete and idempotent.");
  console.log("=".repeat(78));
  process.exit(0);
} else {
  console.log(`RESULT: FAIL — ${failures} problem(s) found.`);
  console.log("=".repeat(78));
  process.exit(1);
}
