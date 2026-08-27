/**
 * CI guard — prove the built artifact will actually contain the .sql migrations.
 *
 * WHY
 *   The Dockerfile flattens `server/dist/*` into `/app/server`, so
 *   `dist/platform/db/migrations/*.sql` must land at
 *   `/app/server/platform/db/migrations/*.sql`, which is exactly where
 *   `migrationRunner.ts` looks (`__dirname/../platform/db/migrations`).
 *
 *   If `npm run build` ever stops copying the SQL, the container starts with
 *   ZERO migrations and every tenant silently loses push notifications,
 *   biometric login and MFA. This script turns that silent failure into a
 *   build failure.
 *
 * Run AFTER `npm run build` (from the server/ directory or repo root).
 *
 * Usage: node scripts/verify-docker-migrations.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "server");
const srcDir = path.join(serverDir, "platform/db/migrations");
const distDir = path.join(serverDir, "dist/platform/db/migrations");

let failed = false;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failed = true; };

console.log("Docker migration-shipping check\n");

// 1. Source migrations exist.
const srcFiles = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((f) => f.endsWith(".sql"))
  : [];
if (srcFiles.length) ok(`source has ${srcFiles.length} .sql file(s)`);
else bad(`no .sql files in ${path.relative(root, srcDir)}`);

// 2. dist/ must mirror them (requires a prior build).
if (!fs.existsSync(distDir)) {
  bad(`dist migrations dir missing — run "npm run build" in server/ first`);
} else {
  const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith(".sql"));
  if (distFiles.length === srcFiles.length) ok(`dist has all ${distFiles.length} migration(s)`);
  else bad(`dist has ${distFiles.length}, expected ${srcFiles.length}`);

  for (const f of srcFiles) {
    const a = path.join(srcDir, f);
    const b = path.join(distDir, f);
    if (!fs.existsSync(b)) { bad(`${f} missing from dist`); continue; }
    if (fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8")) ok(`${f} matches source`);
    else bad(`${f} differs from source`);
  }
}

// 3. The runtime path the runner computes must resolve inside dist.
//    Mirrors: path.join(__dirname, "..", "platform", "db", "migrations")
//    with __dirname = dist/utils
const runtime = path.join(serverDir, "dist/utils", "..", "platform", "db", "migrations");
if (fs.existsSync(runtime)) ok("runtime path resolves (dist/utils/../platform/db/migrations)");
else bad(`runtime path does not resolve: ${runtime}`);

// 4. .dockerignore must not exclude the source migrations.
const di = path.join(root, ".dockerignore");
if (fs.existsSync(di)) {
  const patterns = fs.readFileSync(di, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  // `dist/` is ignored, which is correct: the image rebuilds it inside the
  // backend-builder stage. What must NOT be ignored is server/platform/.
  const risky = patterns.filter((p) => /^server\/platform|^platform|\.sql$/.test(p));
  if (risky.length === 0) ok(".dockerignore does not exclude server/platform");
  else bad(`.dockerignore may exclude migrations: ${risky.join(", ")}`);
}

// 5. package.json build script must invoke the copy step.
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));
if (/copy-sql-assets/.test(pkg.scripts?.build || "")) ok("build script runs copy-sql-assets");
else bad("build script does not run copy-sql-assets");

console.log("");
if (failed) {
  console.log("RESULT: FAIL — the image would ship without migrations.");
  process.exit(1);
}
console.log("RESULT: PASS — migrations will ship in the Docker image.");
