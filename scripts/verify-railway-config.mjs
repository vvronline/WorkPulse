/** Validate Railway config-as-code fields that gate automatic production deploys. */
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync("railway.json", "utf8"));
const errors = [];
const deploy = config.deploy || {};

if (config.build?.builder !== "DOCKERFILE") errors.push("build.builder must be DOCKERFILE");
if (config.build?.dockerfilePath !== "Dockerfile") errors.push("build.dockerfilePath must be Dockerfile");
if (deploy.preDeployCommand !== "node migrate.js") errors.push("preDeployCommand must run node migrate.js");
if (deploy.startCommand !== "node index.js") errors.push("startCommand must not rerun migrations");
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