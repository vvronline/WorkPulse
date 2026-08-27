/** Validate Railway config-as-code fields that gate automatic production deploys. */
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync("railway.json", "utf8"));
const errors = [];
const deploy = config.deploy || {};

if (config.build?.builder !== "DOCKERFILE") errors.push("build.builder must be DOCKERFILE");
if (config.build?.dockerfilePath !== "Dockerfile") errors.push("build.dockerfilePath must be Dockerfile");
if (deploy.preDeployCommand !== "node migrate.js") errors.push("preDeployCommand must run node migrate.js");

// The start command must not re-run DATABASE migrations (that is pre-deploy's
// job — running DDL from N replicas is the failure mode this guards against).
//
// A one-off prefix is tolerated so an operator can run a maintenance task that
// needs the VOLUME, which pre-deploy cannot see (Railway does not mount volumes
// during pre-deploy). `railway.json` outranks service settings, so the dashboard
// start-command field is locked while this file defines it — editing this file
// is the only way to schedule such a task.
//
// `migrate-uploads-to-r2.js` matches /migrate/ by name but touches no database;
// it is a filesystem->R2 copier. Match on the database migrator specifically.
const startCommand = deploy.startCommand || "";
// `\b` after ".js" is NOT sufficient: in "migrate-uploads-to-r2.js" the token
// "migrate" is followed by "-", so a naive /migrate\.js/ style match can still
// hit. Require migrate.js to be a whole path segment, ending the token.
const runsDbMigrations = /(^|[\s;&|"'/])migrate\.js(\s|$|["';&|])/.test(startCommand);
if (runsDbMigrations) {
  errors.push("startCommand must not run node migrate.js — migrations belong in preDeployCommand");
}
if (!/\bnode\s+index\.js\b/.test(startCommand)) {
  errors.push(`startCommand must ultimately launch node index.js, got ${JSON.stringify(startCommand)}`);
}
// Warn (do not fail) when a temporary one-off is staged, so it cannot be
// forgotten in the repository after the release it was added for.
if (startCommand !== "node index.js" && !runsDbMigrations) {
  console.warn(
    `WARNING: startCommand contains a one-off task:\n  ${startCommand}\n`
    + "  Revert it to \"node index.js\" once the task has completed.",
  );
}
if (deploy.healthcheckPath !== "/readyz") errors.push("healthcheckPath must be /readyz");
if (Number(deploy.healthcheckTimeout) < 60) errors.push("healthcheckTimeout is too short");
if (deploy.restartPolicyType !== "ON_FAILURE") errors.push("restartPolicyType must be ON_FAILURE");

// ── Field TYPES, not just values ────────────────────────────────────────────
// Railway validates railway.json against its own schema BEFORE the deploy runs.
// A type mismatch aborts with "Failed to parse your service config" — the build
// never starts and the error is only visible in the Railway UI, not in CI.
//
// This bit us on 2026-08-27: `"overlapSeconds": "30"` (string) failed the deploy
// while this script reported success, because it only checked values.
// Schema: https://railway.com/railway.schema.json — both are `number | null`.
const numericFields = [
  "healthcheckTimeout",
  "restartPolicyMaxRetries",
  "overlapSeconds",
  "drainingSeconds",
  "numReplicas",
];
for (const field of numericFields) {
  const value = deploy[field];
  if (value === undefined || value === null) continue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(
      `deploy.${field} must be a JSON number, got ${typeof value} (${JSON.stringify(value)}). `
      + "Railway rejects the whole config and the deploy never starts.",
    );
  } else if (value < 0) {
    errors.push(`deploy.${field} must be >= 0, got ${value}`);
  }
}

for (const field of ["preDeployCommand", "startCommand", "healthcheckPath", "restartPolicyType"]) {
  const value = deploy[field];
  if (value === undefined || value === null) continue;
  if (typeof value !== "string") {
    errors.push(`deploy.${field} must be a JSON string, got ${typeof value}`);
  }
}

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
if (/node migrate\.js\s*&&/.test(dockerfile)) errors.push("Dockerfile still runs migrations at startup");
const pkg = JSON.parse(fs.readFileSync("server/package.json", "utf8"));
if (/migrate/.test(pkg.scripts?.start || "")) errors.push("server start script still runs migrations");

if (errors.length) {
  console.error("Railway config verification failed:\n" + errors.map((e) => `  ${e}`).join("\n"));
  process.exit(1);
}
console.log("Railway config verified: fatal pre-deploy migrations, /readyz, no runtime migration duplication.");