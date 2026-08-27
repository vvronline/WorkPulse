/**
 * A2 helper — Migration squash coverage analysis.
 *
 * Question this answers:
 *   "Does initTenantSchema() (db.ts) already create every object that the 30
 *    entries in MIGRATIONS[] (migrationRunner.ts) create?"
 *
 * Why it matters:
 *   The migrations are documented as *additive only* — they exist so EXISTING
 *   tenant DBs catch up, while initTenantSchema() creates the full schema for
 *   NEW tenants. If that holds for all 30, the A2 squash needs no pg_dump at
 *   all: a fresh DB just runs initTenantSchema() and records one baseline row.
 *
 * Usage:  node scripts/analyze-migration-coverage.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerSrc = fs.readFileSync(path.join(root, "server/utils/migrationRunner.ts"), "utf8");
const dbSrc = fs.readFileSync(path.join(root, "server/db.ts"), "utf8");

// ── Isolate the MIGRATIONS[] array ──────────────────────────────────────────
const start = runnerSrc.indexOf("const MIGRATIONS: Migration[] = [");
const end = runnerSrc.indexOf("\n];", start);
if (start === -1 || end === -1) {
  console.error("Could not locate MIGRATIONS[] bounds");
  process.exit(1);
}
const migBlock = runnerSrc.slice(start, end);

// ── Split into individual migrations by `name:` ─────────────────────────────
const nameRe = /name:\s*['"]([^'"]+)['"]/g;
const marks = [];
let m;
while ((m = nameRe.exec(migBlock)) !== null) marks.push({ name: m[1], at: m.index });

const migrations = marks.map((mk, i) => ({
  name: mk.name,
  body: migBlock.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : migBlock.length),
}));

// ── Extract the DDL objects each migration creates ──────────────────────────
const extractors = [
  { kind: "table", re: /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi },
  { kind: "index", re: /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+([a-z0-9_]+)/gi },
  { kind: "column", re: /ADD COLUMN IF NOT EXISTS\s+([a-z0-9_]+)/gi },
  { kind: "type", re: /CREATE TYPE\s+([a-z0-9_]+)/gi },
];

const norm = (s) => s.replace(/\s+/g, " ").toLowerCase();
const dbNorm = norm(dbSrc);

let totalObjs = 0;
let totalMissing = 0;
const report = [];

for (const mig of migrations) {
  const objs = [];
  for (const { kind, re } of extractors) {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(mig.body)) !== null) objs.push({ kind, name: mm[1] });
  }

  const missing = [];
  for (const o of objs) {
    // Does db.ts create the same object anywhere?
    const needle =
      o.kind === "column"
        ? `add column if not exists ${o.name.toLowerCase()}`
        : o.kind === "table"
          ? `create table if not exists ${o.name.toLowerCase()}`
          : o.kind === "index"
            ? `index if not exists ${o.name.toLowerCase()}`
            : `create type ${o.name.toLowerCase()}`;

    // Columns may also be declared inline in the CREATE TABLE body.
    const inlineOk =
      o.kind === "column" &&
      new RegExp(`\\b${o.name.toLowerCase()}\\b\\s+(text|integer|boolean|jsonb|timestamptz|serial|numeric|date|bigint|real|uuid)`).test(dbNorm);

    if (!dbNorm.includes(needle) && !inlineOk) missing.push(o);
  }

  totalObjs += objs.length;
  totalMissing += missing.length;
  report.push({ name: mig.name, objs: objs.length, missing });
}

// ── Output ──────────────────────────────────────────────────────────────────
console.log("=".repeat(78));
console.log("A2 MIGRATION SQUASH — COVERAGE ANALYSIS");
console.log("=".repeat(78));
console.log(`Migrations in MIGRATIONS[] : ${migrations.length}`);
console.log(`DDL objects they create    : ${totalObjs}`);
console.log(`NOT found in initTenantSchema(): ${totalMissing}`);
console.log("");

for (const r of report) {
  const flag = r.missing.length === 0 ? "OK  " : "GAP ";
  console.log(`${flag} ${r.name}  (${r.objs} objs)`);
  for (const o of r.missing) console.log(`       └─ MISSING ${o.kind}: ${o.name}`);
}

console.log("");
console.log("=".repeat(78));
if (totalMissing === 0) {
  console.log("RESULT: initTenantSchema() covers 100% of migration DDL.");
  console.log("→ A2 squash needs NO pg_dump. A fresh tenant DB can run");
  console.log("  initTenantSchema() and record a single baseline row.");
} else {
  console.log(`RESULT: ${totalMissing} object(s) exist ONLY in migrations.`);
  console.log("→ These must be folded into the baseline before squashing.");
  console.log("  (Review the GAP lines above — some may be false positives");
  console.log("   from dynamic SQL or renamed objects.)");
}
console.log("=".repeat(78));
