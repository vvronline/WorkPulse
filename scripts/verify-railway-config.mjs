/**
 * Validate Railway Infrastructure as Code fields that gate automatic production
 * deploys. Static source checks only — this must run in CI without Railway auth,
 * so it does not shell out to `railway config plan` (that needs a linked project).
 */
import fs from "node:fs";

const path = ".railway/railway.ts";
const src = fs.readFileSync(path, "utf8");
const errors = [];

// Isolate the WorkPulse service block so checks cannot accidentally match one
// of the aino-web/aino-realtime/aino-worker blocks instead.
const workPulseMatch = src.match(/const WorkPulse = service\("WorkPulse",\s*\{([\s\S]*?)\n {2}\}\);/);
if (!workPulseMatch) errors.push(`Could not find the WorkPulse service block in ${path}`);
const workPulse = workPulseMatch?.[1] ?? "";

// D4.5: health check must point at /readyz, not /healthz or /api/health.
// Railway (dashboard) settings lose to config-as-code, so this is the one
// place that matters.
if (!/healthcheck:\s*"\/readyz"/.test(workPulse)) {
  errors.push('WorkPulse healthcheck must be "/readyz"');
}
const healthcheckTimeoutMatch = workPulse.match(/healthcheckTimeout:\s*(\d+)/);
if (!healthcheckTimeoutMatch || Number(healthcheckTimeoutMatch[1]) < 60) {
  errors.push("WorkPulse healthcheckTimeout is missing or too short (must be >= 60)");
}

// E3.2: DB migrations run once in pre-deploy, never at runtime from N replicas.
const preDeployMatch = workPulse.match(/preDeployCommand:\s*\[([^\]]*)\]/);
const preDeployArgs = preDeployMatch?.[1] ?? "";
// Railway's schema caps preDeployCommand at one array item (a single shell
// command string), not an argv-split array — ["node", "migrate.js"] fails
// apply with "too_big: expected array to have <=1 items".
if (!/"node migrate\.js"/.test(preDeployArgs)) {
  errors.push('WorkPulse preDeployCommand must run ["node migrate.js"] (single string, not argv-split)');
}

// The start command (if the service overrides one) must not re-run DATABASE
// migrations — that is pre-deploy's job. Running DDL from N replicas is the
// failure mode this guards against. WorkPulse currently has no startCommand
// override (it uses the Dockerfile CMD), so absence is fine; only flag it if
// present and wrong.
const startCommandMatch = workPulse.match(/(?<!pre)[Ss]tartCommand:\s*"([^"]*)"/);
if (startCommandMatch) {
  const startCommand = startCommandMatch[1];
  const runsDbMigrations = /(^|[\s;&|"'/])migrate\.js(\s|$|["';&|])/.test(startCommand);
  if (runsDbMigrations) {
    errors.push("WorkPulse startCommand must not run node migrate.js — migrations belong in preDeployCommand");
  }
}

if (!/restartPolicyType:\s*"ON_FAILURE"/.test(workPulse)) {
  errors.push("WorkPulse restartPolicyType must be ON_FAILURE");
}
const maxRetriesMatch = workPulse.match(/restartPolicyMaxRetries:\s*(\d+)/);
if (!maxRetriesMatch) errors.push("WorkPulse restartPolicyMaxRetries is missing");

// ── Field TYPES, not just values ────────────────────────────────────────────
// A prior incident: "overlapSeconds": "30" (string, in the old railway.json)
// passed value checks but Railway's own schema rejects a string here — the
// build never starts and the error is only visible in the Railway UI. Guard
// against the same mistake by requiring bare numeric literals (no quotes) for
// every numeric deploy field actually present in the WorkPulse block.
const numericFields = ["healthcheckTimeout", "restartPolicyMaxRetries", "overlapSeconds", "drainingSeconds", "numReplicas"];
for (const field of numericFields) {
  const quoted = new RegExp(`${field}:\\s*"`);
  if (quoted.test(workPulse)) {
    errors.push(`WorkPulse deploy.${field} must be a bare number, not a quoted string`);
  }
}
if (!/overlapSeconds:\s*\d+/.test(workPulse)) errors.push("WorkPulse overlapSeconds is missing");
if (!/drainingSeconds:\s*\d+/.test(workPulse)) errors.push("WorkPulse drainingSeconds is missing");

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
if (/node migrate\.js\s*&&/.test(dockerfile)) errors.push("Dockerfile still runs migrations at startup");
const pkg = JSON.parse(fs.readFileSync("server/package.json", "utf8"));
if (/migrate/.test(pkg.scripts?.start || "")) errors.push("server start script still runs migrations");

if (errors.length) {
  console.error("Railway config verification failed:\n" + errors.map((e) => `  ${e}`).join("\n"));
  process.exit(1);
}
console.log("Railway config verified: fatal pre-deploy migrations, /readyz, no runtime migration duplication.");
