#!/usr/bin/env node
/**
 * One-off: move pre-tenant-prefix upload objects onto the canonical layout.
 *
 * BACKGROUND
 *   Before per-tenant prefixes existed, avatars were written to:
 *       avatars/user_1_1775078052613.png
 *       org_1/avatars/user_1_1777270695696.jpg
 *   The canonical layout is:
 *       tenant_<tenantId>/org_<orgId>/avatars/<file>
 *
 *   `urlToKey()` still resolves the old shapes and `http/middleware/uploads.ts`
 *   has an explicit legacy branch, so these objects WORK today. This script
 *   exists so that branch can eventually be deleted: legacy paths carry no
 *   tenant segment, so the tenant assertion cannot run on them and they rely on
 *   the weaker org-only check.
 *
 * WHAT IT DOES
 *   For each legacy object:
 *     1. copy  ->  tenant_<t>/org_<o>/avatars/<filename>   (server-side copy)
 *     2. UPDATE users.avatar / org_branding.logo_url to the new URL
 *     3. delete the old object   (only with --delete-old, and only after 2)
 *
 *   The DB update is the commit point. If the process dies after the copy the
 *   old object is still referenced and still works — a duplicate object is
 *   harmless; a dangling URL is not.
 *
 * SAFETY
 *   --dry-run (default) makes NO writes of any kind.
 *   --apply performs copy + DB update, leaving the old object in place.
 *   --delete-old additionally removes the old object once its URL is unreferenced.
 *
 * USAGE (inside the Railway container, where DATABASE_URL and R2 creds exist)
 *   node scripts/normalize-legacy-uploads.js --dry-run
 *   node scripts/normalize-legacy-uploads.js --apply
 *   node scripts/normalize-legacy-uploads.js --apply --delete-old
 */
import {
    S3Client,
    CopyObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
} from "@aws-sdk/client-s3";

const APPLY = process.argv.includes("--apply");
const DELETE_OLD = process.argv.includes("--delete-old");
const BUCKET = process.env.R2_UPLOADS_BUCKET || "aino-uploads";

/** Canonical layout: tenant_<id>/org_<id>/<kind>/<file> — 4 segments. */
const CANONICAL = /^tenant_\d+\/org_\d+\/[^/]+\/[^/]+$/;

interface LegacyObject {
    key: string;
    /** org id parsed from the key, when the legacy path carried one. */
    orgId: number | null;
    kind: string;
    filename: string;
}

/** Classify a key that is not already canonical. */
export function classifyLegacyKey(key: string): LegacyObject | null {
    if (CANONICAL.test(key)) return null;
    if (key.startsWith("_probe")) return null; // verification leftovers

    const parts = key.split("/");
    const filename = parts[parts.length - 1];
    if (!filename) return null;

    // org_<id>/<kind>/<file>
    const withOrg = /^org_(\d+)\/([^/]+)\/([^/]+)$/.exec(key);
    if (withOrg) {
        return { key, orgId: parseInt(withOrg[1], 10), kind: withOrg[2], filename: withOrg[3] };
    }

    // <kind>/<file>   (oldest shape: no org, no tenant)
    const bare = /^([^/]+)\/([^/]+)$/.exec(key);
    if (bare) return { key, orgId: null, kind: bare[1], filename: bare[2] };

    return null;
}

function buildClient(): S3Client {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
        console.error("ERROR: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY required");
        process.exit(1);
    }
    return new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
    });
}

async function listAll(client: S3Client): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
        const page = await client.send(new ListObjectsV2Command({
            Bucket: BUCKET, ContinuationToken: token,
        }));
        for (const o of page.Contents || []) if (o.Key) keys.push(o.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

/**
 * Resolve the tenant that owns a legacy object.
 *
 * Legacy keys predate tenant prefixes, so the tenant cannot be read from the
 * key — it has to come from whichever tenant database actually references the
 * URL. We therefore search every tenant DB for a row pointing at the old URL.
 * A key nothing references is an orphan and is left alone.
 */
interface Owner {
    tenantId: number;
    orgId: number;
    table: "users" | "org_branding";
    id: number;
    dbName: string;
    dbHost?: string | null;
}

async function findOwner(legacyKey: string): Promise<Owner | null> {
    const { forEachTenant } = require("../utils/tenantManager");
    const oldUrl = `/uploads/${legacyKey}`;
    let found: Owner | null = null;

    // forEachTenant isolates per-tenant errors, so one unreachable tenant DB
    // cannot abort the sweep. It hands us an open pool per tenant.
    await forEachTenant(async (db: any, tenant: any) => {
        if (found) return; // first match wins; a URL belongs to one tenant

        try {
            const user = (await db.query(
                "SELECT id, org_id FROM users WHERE avatar = $1 LIMIT 1", [oldUrl],
            )).rows[0];
            if (user) {
                found = {
                    tenantId: tenant.id, orgId: user.org_id,
                    table: "users", id: user.id,
                    dbName: tenant.db_name, dbHost: tenant.db_host,
                };
                return;
            }
        } catch { /* table may be absent on very old tenants */ }

        try {
            const brand = (await db.query(
                "SELECT org_id FROM org_branding WHERE logo_url = $1 LIMIT 1", [oldUrl],
            )).rows[0];
            if (brand) {
                found = {
                    tenantId: tenant.id, orgId: brand.org_id,
                    table: "org_branding", id: brand.org_id,
                    dbName: tenant.db_name, dbHost: tenant.db_host,
                };
            }
        } catch { /* ditto */ }
    }, { label: "normalize-legacy-uploads" });

    return found;
}

async function main(): Promise<void> {
    console.log("=".repeat(70));
    console.log("Normalize legacy upload keys");
    console.log("=".repeat(70));
    console.log(`  bucket : ${BUCKET}`);
    console.log(`  mode   : ${APPLY ? (DELETE_OLD ? "APPLY + DELETE OLD" : "APPLY") : "DRY RUN"}`);
    console.log("");

    const client = buildClient();
    const allKeys = await listAll(client);
    const legacy = allKeys
        .map(classifyLegacyKey)
        .filter((o): o is LegacyObject => o !== null);

    console.log(`Objects: ${allKeys.length} total, ${legacy.length} legacy`);
    if (legacy.length === 0) {
        console.log("\nNothing to do — every key is already canonical.");
        return;
    }
    console.log("");

    let moved = 0;
    let orphaned = 0;
    let failed = 0;

    for (const obj of legacy) {
        const owner = await findOwner(obj.key);
        if (!owner) {
            orphaned++;
            console.log(`  ORPHAN   ${obj.key} (no DB row references it — left in place)`);
            continue;
        }

        const newKey = `tenant_${owner.tenantId}/org_${owner.orgId}/${obj.kind}/${obj.filename}`;
        const newUrl = `/uploads/${newKey}`;

        if (!APPLY) {
            console.log(`  would move  ${obj.key}`);
            console.log(`           -> ${newKey}  (${owner.table} #${owner.id})`);
            moved++;
            continue;
        }

        try {
            // 1. Server-side copy — bytes never transit this process.
            await client.send(new CopyObjectCommand({
                Bucket: BUCKET,
                CopySource: `/${BUCKET}/${encodeURIComponent(obj.key).replace(/%2F/g, "/")}`,
                Key: newKey,
            }));
            // Prove the copy landed before repointing the database at it.
            await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: newKey }));

            // 2. Commit point: the DB now references the new key.
            const { getTenantPool } = require("../utils/tenantManager");
            const db = await getTenantPool(owner.dbName, owner.dbHost);
            if (owner.table === "users") {
                await db.query("UPDATE users SET avatar = $1 WHERE id = $2", [newUrl, owner.id]);
            } else {
                await db.query(
                    "UPDATE org_branding SET logo_url = $1 WHERE org_id = $2", [newUrl, owner.id],
                );
            }

            // 3. Only now is the old object unreferenced.
            if (DELETE_OLD) {
                await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.key }));
            }

            moved++;
            console.log(`  MOVED    ${obj.key} -> ${newKey}${DELETE_OLD ? " (old deleted)" : ""}`);
        } catch (err) {
            failed++;
            console.error(`  FAIL     ${obj.key}: ${(err as Error).message}`);
        }
    }

    console.log("");
    console.log("=".repeat(70));
    console.log(`${APPLY ? "Moved" : "Would move"} : ${moved}`);
    console.log(`Orphaned      : ${orphaned}  (unreferenced; safe to review by hand)`);
    console.log(`Failed        : ${failed}`);
    if (!APPLY) console.log("\nDRY RUN — nothing was changed. Re-run with --apply.");
    if (APPLY && !DELETE_OLD) {
        console.log("\nOld objects kept. Re-run with --delete-old once verified.");
    }
    console.log("=".repeat(70));
    if (failed > 0) process.exit(1);
}

if (require.main === module) {
    main().catch((err: unknown) => {
        console.error("FATAL:", (err as Error).message);
        process.exit(1);
    });
}

export { BUCKET, CANONICAL, findOwner, main };
