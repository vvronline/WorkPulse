/**
 * GR1 (SQL half) — no raw SQL in route files.
 *
 * dependency-cruiser reasons about imports, so it cannot see a SQL string
 * literal. This guard reads the source and looks for statement keywords.
 *
 * Scope: enforced as an ERROR for migrated `server/modules/**` route files.
 * Legacy `server/routes/**` files are counted and pinned to a ratchet so the
 * number can only go down as Phase G proceeds — the same shrink-only strategy
 * as the file-size ratchet (GR2).
 */
import fs from "node:fs";
import path from "node:path";

const serverRoot = path.resolve("server");

// Statement starts, not bare words: `SELECT ... FROM`, `INSERT INTO`, etc.
// Anchoring on the second keyword avoids matching prose like "update the row".
const SQL = [
  /\bSELECT\b[\s\S]{0,400}?\bFROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\b[\s\S]{0,200}?\bSET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(TABLE|INDEX)\b/i,
  /\bALTER\s+TABLE\b/i,
];

/**
 * Legacy SQL debt, pinned per file. Phase G removes these entries.
 * A file may only shrink; a new file gets 0.
 */
const RATCHET_FILE = path.resolve("scripts/sql-in-routes-baseline.json");

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "__tests__"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Count SQL-bearing lines in a file. */
function countSql(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments so documentation about SQL is not counted as SQL.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (SQL.some((re) => re.test(line))) count++;
  }
  return count;
}

const failures = [];

// ── Hard rule: migrated modules ─────────────────────────────────────────────
for (const file of walk(path.join(serverRoot, "modules"))) {
  if (!/\.routes\.ts$/.test(file)) continue;
  const count = countSql(file);
  if (count > 0) {
    const rel = path.relative(serverRoot, file).replace(/\\/g, "/");
    failures.push(`${rel}: ${count} SQL line(s) in a migrated module route — move them to the repository.`);
  }
}

// ── Ratchet: legacy routes ──────────────────────────────────────────────────
const baseline = fs.existsSync(RATCHET_FILE)
  ? JSON.parse(fs.readFileSync(RATCHET_FILE, "utf8"))
  : {};

const current = {};
for (const file of walk(path.join(serverRoot, "routes"))) {
  if (!file.endsWith(".ts")) continue;
  const rel = path.relative(serverRoot, file).replace(/\\/g, "/");
  const count = countSql(file);
  if (count > 0) current[rel] = count;
}

if (process.argv.includes("--update")) {
  fs.writeFileSync(RATCHET_FILE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Baseline written: ${Object.keys(current).length} legacy route files with SQL.`);
  process.exit(0);
}

for (const [rel, count] of Object.entries(current)) {
  const ceiling = baseline[rel];
  if (ceiling === undefined) {
    failures.push(`${rel}: ${count} SQL line(s) in a NEW route file — routes must not contain SQL.`);
  } else if (count > ceiling) {
    failures.push(`${rel}: SQL grew ${ceiling} -> ${count}. The ratchet may only shrink.`);
  }
}

if (failures.length) {
  console.error(
    "SQL-in-routes guard (GR1) failed:\n" + failures.map((f) => `  ${f}`).join("\n") +
    "\n\nIf you intentionally REMOVED SQL, re-pin with:\n" +
    "  node scripts/check-no-sql-in-routes.mjs --update",
  );
  process.exit(1);
}

const totalNow = Object.values(current).reduce((a, b) => a + b, 0);
const totalBase = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(
  `SQL-in-routes guard passed: modules clean; legacy debt ${totalNow}/${totalBase} lines ` +
  `across ${Object.keys(current).length} files.`,
);
