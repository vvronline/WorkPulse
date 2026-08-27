/**
 * §1.2 gate — prove the R2 upload credentials have Object Read AND Write.
 *
 * WHY THIS EXISTS AS A SCRIPT
 *   A read-only token passes every boot check. `assertProductionStorage()` only
 *   constructs the adapter; it never writes. So the deploy goes green, `/readyz`
 *   returns 200, existing files download fine — and then the FIRST user upload
 *   fails with a 500. This script moves that discovery to before the push.
 *
 *   It also reports the current object count, which answers "has the §1.5
 *   volume->R2 copy actually happened?".
 *
 * WHY NOT THE AWS CLI
 *   The AWS CLI bundles its own CA store and fails with CERTIFICATE_VERIFY_FAILED
 *   behind a TLS-inspecting corporate proxy. Node honours NODE_EXTRA_CA_CERTS and
 *   the system trust store, so this works where `aws s3 ls` does not.
 *
 * USAGE
 *   Pull the real values from Railway (never hard-code them):
 *
 *     $j = railway variables --service WorkPulse --json | ConvertFrom-Json
 *     $env:R2_ACCOUNT_ID        = [string]$j.R2_ACCOUNT_ID
 *     $env:R2_ACCESS_KEY_ID     = [string]$j.R2_ACCESS_KEY_ID
 *     $env:R2_SECRET_ACCESS_KEY = [string]$j.R2_SECRET_ACCESS_KEY
 *     $env:R2_UPLOADS_BUCKET    = [string]$j.R2_UPLOADS_BUCKET
 *     node scripts/verify-r2-credentials.mjs
 *
 * Exits non-zero on any failure. Read-only against existing data: the only
 * object it writes is its own probe key, which it deletes again.
 */
import { createRequire } from "node:module";

// The AWS SDK is a dependency of server/, not the repo root.
const require = createRequire(new URL("../server/package.json", import.meta.url));
let S3;
try {
  S3 = require("@aws-sdk/client-s3");
} catch {
  console.error("ERROR: @aws-sdk/client-s3 not found. Run `npm ci` in server/ first.");
  process.exit(1);
}

const acct = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_UPLOADS_BUCKET || "aino-uploads";

const missing = [
  !acct && "R2_ACCOUNT_ID",
  !accessKeyId && "R2_ACCESS_KEY_ID",
  !secretAccessKey && "R2_SECRET_ACCESS_KEY",
].filter(Boolean);
if (missing.length) {
  console.error(`ERROR: missing environment: ${missing.join(", ")}`);
  process.exit(1);
}

const endpoint = `https://${acct}.r2.cloudflarestorage.com`;
const client = new S3.S3Client({
  region: "auto",
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

console.log("=".repeat(66));
console.log("R2 upload-credential probe");
console.log("=".repeat(66));
console.log(`  bucket   : ${bucket}`);
console.log(`  endpoint : ${endpoint}`);
console.log("");

let failed = false;
const probeKey = `_probe-${Date.now()}.txt`;

async function step(label, fn) {
  try {
    const out = await fn();
    console.log(`  OK    ${label}`);
    return out;
  } catch (err) {
    failed = true;
    const status = err?.$metadata?.httpStatusCode ?? "?";
    console.log(`  FAIL  ${label}: ${err.name} (http ${status}) — ${err.message}`);
    return null;
  }
}

// ── Read ────────────────────────────────────────────────────────────────────
const inventory = await step("list   (Object Read)", async () => {
  let token;
  let count = 0;
  let bytes = 0;
  const sample = [];
  do {
    const page = await client.send(new S3.ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
    }));
    for (const obj of page.Contents || []) {
      count++;
      bytes += obj.Size || 0;
      if (sample.length < 5) sample.push(obj.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { count, bytes, sample };
});

// ── Write ───────────────────────────────────────────────────────────────────
// This is the check that matters: a read-only token boots fine and only fails
// on the first real upload.
const wrote = await step("put    (Object Write)", () => client.send(new S3.PutObjectCommand({
  Bucket: bucket,
  Key: probeKey,
  Body: "probe",
  ContentType: "text/plain",
})));

if (wrote) {
  await step("head", () => client.send(new S3.HeadObjectCommand({ Bucket: bucket, Key: probeKey })));
  await step("get", () => client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: probeKey })));
  await step("delete (cleanup)", () => client.send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: probeKey })));
} else {
  console.log("  SKIP  head/get/delete — nothing was written to probe with");
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log("");
if (inventory) {
  const mb = (inventory.bytes / 1024 / 1024).toFixed(1);
  console.log(`Bucket contents: ${inventory.count} object(s), ${mb} MB`);
  for (const key of inventory.sample) console.log(`   ${key}`);
  if (inventory.count === 0) {
    console.log("   (empty — the §1.5 volume->R2 upload copy has NOT been run)");
  }
  console.log("");
}

console.log("=".repeat(66));
if (failed) {
  console.log("RESULT: FAIL");
  console.log("");
  console.log("If list succeeded but put returned AccessDenied, the API token is");
  console.log("READ-ONLY. Cloudflare dashboard -> R2 -> Manage API Tokens -> edit the");
  console.log("token -> permission must be 'Object Read & Write' on this bucket.");
  console.log("A read-only token still boots cleanly and passes /readyz — the failure");
  console.log("surfaces on the first user upload as a 500.");
} else {
  console.log("RESULT: PASS — read + write confirmed; probe object removed.");
}
console.log("=".repeat(66));
process.exit(failed ? 1 : 0);
