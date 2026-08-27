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

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
if (/node migrate\.js\s*&&/.test(dockerfile)) errors.push("Dockerfile still runs migrations at startup");
const pkg = JSON.parse(fs.readFileSync("server/package.json", "utf8"));
if (/migrate/.test(pkg.scripts?.start || "")) errors.push("server start script still runs migrations");

if (errors.length) {
  console.error("Railway config verification failed:\n" + errors.map((e) => `  ${e}`).join("\n"));
  process.exit(1);
}
console.log("Railway config verified: fatal pre-deploy migrations, /readyz, no runtime migration duplication.");