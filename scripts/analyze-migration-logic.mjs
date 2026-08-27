/**
 * A2.5 helper — classify each migration as "pure SQL" vs "procedural".
 *
 * Purpose:
 *   The squash replaces MIGRATIONS[] with .sql files. A migration whose `up()`
 *   is nothing but `await query(...)` calls converts to SQL mechanically.
 *   Anything that reads rows, branches, loops or builds SQL dynamically cannot
 *   be expressed as a static .sql file and must either be:
 *     (a) folded into the baseline as its END STATE, or
 *     (b) kept as a small code-based post-step.
 *
 * Usage:  node scripts/analyze-migration-logic.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "server/utils/migrationRunner.ts"), "utf8");

const a = src.indexOf("const MIGRATIONS: Migration[] = [");
const b = src.indexOf("\n];", a);
const blk = src.slice(a, b);

const nameRe = /name:\s*['"]([^'"]+)['"]/g;
const marks = [];
let m;
while ((m = nameRe.exec(blk)) !== null) marks.push({ name: m[1], at: m.index });

const migs = marks.map((mk, i) => ({
  name: mk.name,
  body: blk.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : blk.length),
}));

const DOLLAR_BRACE = "$" + "{";

let pure = 0;
let procedural = 0;
const proceduralList = [];

for (const mig of migs) {
  const signals = [];

  // Reading query results back into JS = procedural.
  if (/\.rows/.test(mig.body)) signals.push("reads .rows");
  // Conditional / looping control flow.
  if (/\bif\s*\(/.test(mig.body)) signals.push("if()");
  if (/\bfor\s*\(|\bfor\s+const|\.forEach\(|\bwhile\s*\(/.test(mig.body)) signals.push("loop");
  // Dynamic SQL construction.
  if (mig.body.includes(DOLLAR_BRACE)) signals.push("dynamic SQL");
  // JS-side data manipulation.
  if (/JSON\.(parse|stringify)/.test(mig.body)) signals.push("JSON.*");
  // Per-migration error swallowing.
  if (/\btry\s*\{/.test(mig.body)) signals.push("try/catch");
  // Calls into other modules.
  if (/require\(/.test(mig.body)) signals.push("require()");

  const queryCount = (mig.body.match(/await query\(/g) || []).length;

  if (signals.length === 0) {
    pure++;
  } else {
    procedural++;
    proceduralList.push({ name: mig.name, signals, queryCount });
  }
}

console.log("=".repeat(78));
console.log("A2.5 — MIGRATION LOGIC CLASSIFICATION");
console.log("=".repeat(78));
console.log(`Total migrations : ${migs.length}`);
console.log(`Pure SQL         : ${pure}   (mechanical -> .sql)`);
console.log(`Procedural       : ${procedural}   (needs review)`);
console.log("");

if (proceduralList.length) {
  console.log("PROCEDURAL MIGRATIONS — cannot be a static .sql file as-is:");
  console.log("");
  for (const p of proceduralList) {
    console.log(`  ${p.name}`);
    console.log(`     queries: ${p.queryCount}   signals: ${p.signals.join(", ")}`);
  }
}

console.log("");
console.log("=".repeat(78));
console.log("STRATEGY");
console.log("=".repeat(78));
console.log("The baseline captures the END STATE of the schema, so procedural");
console.log("migrations do NOT need to be replayed for a NEW database:");
console.log("  - data backfills   -> no rows exist yet in a fresh DB");
console.log("  - conditional DDL  -> the baseline already encodes the outcome");
console.log("  - cleanup/renames  -> nothing legacy exists to clean up");
console.log("");
console.log("They only mattered for EXISTING databases catching up, and the");
console.log("only existing DB (`default`) is being recreated from the baseline.");
console.log("=".repeat(78));
