/**
 * Build step — copy non-TypeScript assets into `dist/`.
 *
 * WHY THIS EXISTS
 *   `tsc` only emits `.js` for `.ts` inputs; it silently ignores `.sql`. The
 *   migration runner reads `platform/db/migrations/*.sql` at runtime, so without
 *   this step the compiled image ships ZERO migrations and every tenant DB
 *   would be left with only the `initTenantSchema()` base — no device_tokens
 *   (push), no webauthn_credentials (biometric), no users.mfa_* (2FA).
 *
 *   That failure is silent: the runner logs "loaded 0 migrations" and carries
 *   on. Hence the hard assertion at the end of this script.
 *
 * Cross-platform (no `cp -r`), so it works in the Alpine Docker build and on a
 * Windows dev machine.
 *
 * Wired into `npm run build` via `tsc -p tsconfig.json && node scripts/copy-sql-assets.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  {
    from: path.join(serverRoot, "platform/db/migrations"),
    to: path.join(serverRoot, "dist/platform/db/migrations"),
    ext: ".sql",
    required: true,
  },
  {
    // A4: master-database migrations (shards, tenants.shard_id/storage_bucket).
    from: path.join(serverRoot, "platform/db/migrations/master"),
    to: path.join(serverRoot, "dist/platform/db/migrations/master"),
    ext: ".sql",
    required: true,
  },
];

let copiedTotal = 0;

for (const p of pairs) {
  if (!fs.existsSync(p.from)) {
    if (p.required) {
      console.error(`ERROR: required source directory missing: ${p.from}`);
      process.exit(1);
    }
    continue;
  }

  fs.mkdirSync(p.to, { recursive: true });
  const files = fs.readdirSync(p.from).filter((f) => f.endsWith(p.ext));

  for (const f of files) {
    fs.copyFileSync(path.join(p.from, f), path.join(p.to, f));
    console.log(`  copied ${f}`);
    copiedTotal++;
  }

  if (p.required && files.length === 0) {
    console.error(`ERROR: no ${p.ext} files found in ${p.from}`);
    process.exit(1);
  }
}

// Hard assertion: a build that ships no migrations must fail loudly at build
// time rather than silently at runtime in production.
const migDir = pairs[0].to;
const shipped = fs.existsSync(migDir)
  ? fs.readdirSync(migDir).filter((f) => f.endsWith(".sql"))
  : [];

if (shipped.length === 0) {
  console.error("");
  console.error("BUILD FAILED: dist contains no .sql migrations.");
  console.error("The runtime would start with an incomplete tenant schema.");
  process.exit(1);
}

console.log(`\nSQL assets OK — ${copiedTotal} file(s) copied, ${shipped.length} migration(s) in dist.`);
