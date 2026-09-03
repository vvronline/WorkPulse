/**
 * Architecture ratchet: new TypeScript files may not exceed 600 lines.
 *
 * Existing oversized files are explicitly grandfathered. Their recorded line
 * ceiling may only stay the same or shrink; a PR cannot add more debt. Remove
 * an entry when Phase G splits that file.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("server");
const LIMIT = 600;

// Baseline captured 2026-08-21. Ceilings are intentionally exact.
const grandfathered = {
  "db.ts": 2320,
  "jobs.ts": 870,
  "routes/admin.ts": 1403,
  "routes/agile.ts": 788,
  "routes/auth.ts": 1513,
  "routes/chat.ts": 4489,
  "routes/compensation.ts": 1066,
  "routes/leavePolicy.ts": 686,
  "routes/leaves.ts": 727,
  "routes/manager.ts": 1085,
  "routes/meetings.ts": 963,
  "routes/notes.ts": 806,
  "routes/organization.ts": 1079,
  "routes/sprints.ts": 959,
  "routes/tasks/crud.ts": 735,
  "routes/tenants.ts": 1844,
  "routes/tracker.ts": 925,
  "services/pushNotifications.ts": 866,
  "utils/mailer.ts": 608,
  "utils/tenantManager.ts": 709,
  "utils/ws.ts": 3841,
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "graphify-out", "uploads"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const failures = [];
for (const file of walk(root).filter((f) => f.endsWith(".ts") && !f.includes(`${path.sep}__tests__${path.sep}`))) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).length;
  const ceiling = grandfathered[rel] ?? LIMIT;
  if (lines > ceiling) failures.push(`${rel}: ${lines} lines (ceiling ${ceiling})`);
}

if (failures.length) {
  console.error("Server file-size ratchet failed:\n" + failures.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}

console.log(`Server file-size ratchet passed (${LIMIT}-line limit; ${Object.keys(grandfathered).length} legacy exceptions).`);