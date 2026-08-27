#!/usr/bin/env node
/**
 * Map opaque R2 key prefixes to human tenant names, with storage usage.
 *
 * WHY THIS EXISTS INSTEAD OF RENAMING THE PREFIXES
 *   Browsing `aino-uploads` shows `tenant_1/`, `tenant_4/` — readable to the
 *   database, not to a person. The tempting fix is to key objects by
 *   `tenants.slug` instead. That is unsafe:
 *
 *     - `deleteTenant()` DELIBERATELY frees the slug (tombstoning it to
 *       `<slug>_deleted_<id>`) so it can be reissued, while keeping the old
 *       tenant's data. A new, unrelated customer taking that slug would land in
 *       the deleted tenant's prefix — cross-tenant contamination, and
 *       `deletePrefix()` would then target the wrong tenant's objects.
 *     - Renaming an org syncs `tenants.org_name` (routes/admin.ts), and slugs
 *       derive from names, so keys would orphan on rename.
 *
 *   `tenants.id` is a SERIAL PRIMARY KEY: permanent and never reissued. Keys
 *   stay id-based (ADR-003); this report supplies the readability instead.
 *
 * ALSO USEFUL FOR
 *   Per-tenant storage metering. `tenants.max_storage_mb` already exists as a
 *   quota column but nothing measures against it; the byte totals here are
 *   exactly that measurement.
 *
 * READ-ONLY. Lists objects and reads the tenant catalog. Writes nothing.
 *
 * USAGE (inside the Railway container, or anywhere with R2 creds + DB access)
 *   node scripts/r2-tenant-report.js
 *   node scripts/r2-tenant-report.js --json      machine-readable
 *   node scripts/r2-tenant-report.js --by-kind   break down per upload kind
 */
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const AS_JSON = process.argv.includes("--json");
const BY_KIND = process.argv.includes("--by-kind");
const BUCKET = process.env.R2_UPLOADS_BUCKET || "aino-uploads";

interface PrefixUsage {
    prefix: string;
    tenantId: number | null;
    objects: number;
    bytes: number;
    byKind: Record<string, { objects: number; bytes: number }>;
    newest: Date | null;
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

/**
 * Group every object by its top-level prefix.
 *
 * `tenant_<id>/...` is the canonical layout. Anything else is a legacy key from
 * before tenant prefixes existed; it is reported under its own heading rather
 * than being silently folded into a tenant it may not belong to.
 */
export function summarise(
    objects: { key: string; size: number; at?: Date }[],
): Map<string, PrefixUsage> {
    const byPrefix = new Map<string, PrefixUsage>();

    for (const obj of objects) {
        const tenantMatch = /^tenant_(\d+)\//.exec(obj.key);
        const prefix = tenantMatch ? `tenant_${tenantMatch[1]}/` : "(legacy)";
        const tenantId = tenantMatch ? parseInt(tenantMatch[1], 10) : null;

        let entry = byPrefix.get(prefix);
        if (!entry) {
            entry = { prefix, tenantId, objects: 0, bytes: 0, byKind: {}, newest: null };
            byPrefix.set(prefix, entry);
        }

        entry.objects++;
        entry.bytes += obj.size;
        if (obj.at && (!entry.newest || obj.at > entry.newest)) entry.newest = obj.at;

        // tenant_<id>/org_<id>/<kind>/<file> -> kind is segment 2.
        const parts = obj.key.split("/");
        const kind = tenantMatch && parts.length >= 4 ? parts[2] : "(legacy)";
        const k = entry.byKind[kind] || (entry.byKind[kind] = { objects: 0, bytes: 0 });
        k.objects++;
        k.bytes += obj.size;
    }

    return byPrefix;
}

export function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Every object in the bucket. */
async function listAll(client: S3Client) {
    const out: { key: string; size: number; at?: Date }[] = [];
    let token: string | undefined;
    do {
        const page = await client.send(new ListObjectsV2Command({
            Bucket: BUCKET, ContinuationToken: token,
        }));
        for (const o of page.Contents || []) {
            if (o.Key) out.push({ key: o.Key, size: o.Size || 0, at: o.LastModified });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
}

/**
 * Tenant catalog, keyed by id.
 *
 * Includes deleted tenants: their objects may still be in the bucket (soft
 * delete keeps the data), and showing "Acme Corp [deleted]" is far more useful
 * than an unexplained prefix.
 */
async function loadTenants(): Promise<Map<number, { name: string; slug: string; status: string; quotaMb: number | null }>> {
    const map = new Map<number, { name: string; slug: string; status: string; quotaMb: number | null }>();

    // `../db` calls process.exit() at import time when DATABASE_URL is absent,
    // which would kill the report instead of degrading it. Check first so the
    // R2-only view still works from a workstation with no database access.
    if (!process.env.DATABASE_URL) {
        console.error("NOTE: DATABASE_URL not set — showing prefixes without tenant names.");
        console.error("      Run inside the Railway container for the full report.\n");
        return map;
    }

    try {
        const { masterQuery } = require("../db");
        const res = await masterQuery(
            "SELECT id, org_name, slug, status, max_storage_mb FROM tenants ORDER BY id",
        );
        for (const r of res.rows) {
            map.set(Number(r.id), {
                name: r.org_name || r.slug,
                slug: r.slug,
                status: r.status || "active",
                quotaMb: r.max_storage_mb ?? null,
            });
        }
    } catch (err) {
        // Without the catalog the report still works — prefixes just stay
        // unlabelled — so degrade rather than fail.
        console.error(`WARNING: could not read the tenant catalog: ${(err as Error).message}`);
        console.error("         Prefixes will be shown without names.\n");
    }
    return map;
}

async function main(): Promise<void> {
    const client = buildClient();
    const [objects, tenants] = await Promise.all([listAll(client), loadTenants()]);
    const usage = [...summarise(objects).values()]
        .sort((a, b) => b.bytes - a.bytes);

    if (AS_JSON) {
        console.log(JSON.stringify({
            bucket: BUCKET,
            generatedAt: new Date().toISOString(),
            totals: {
                objects: objects.length,
                bytes: objects.reduce((n, o) => n + o.size, 0),
            },
            prefixes: usage.map((u) => {
                const t = u.tenantId !== null ? tenants.get(u.tenantId) : undefined;
                return {
                    prefix: u.prefix,
                    tenantId: u.tenantId,
                    tenantName: t?.name ?? null,
                    slug: t?.slug ?? null,
                    status: t?.status ?? null,
                    quotaMb: t?.quotaMb ?? null,
                    objects: u.objects,
                    bytes: u.bytes,
                    newest: u.newest?.toISOString() ?? null,
                    byKind: u.byKind,
                };
            }),
        }, null, 2));
        return;
    }

    const totalBytes = objects.reduce((n, o) => n + o.size, 0);
    console.log("=".repeat(78));
    console.log(`R2 usage by tenant — ${BUCKET}`);
    console.log("=".repeat(78));
    console.log(`${objects.length} object(s), ${humanBytes(totalBytes)} total\n`);

    const head = "PREFIX".padEnd(14) + "TENANT".padEnd(26) + "OBJECTS".padStart(8)
        + "SIZE".padStart(11) + "  QUOTA";
    console.log(head);
    console.log("-".repeat(78));

    for (const u of usage) {
        const t = u.tenantId !== null ? tenants.get(u.tenantId) : undefined;

        let label: string;
        if (u.prefix === "(legacy)") {
            label = "pre-tenant-prefix keys";
        } else if (!t) {
            // A prefix with no catalog row: hard-deleted tenant, or orphans.
            label = `UNKNOWN (no tenant row)`;
        } else {
            label = t.status === "active" ? t.name : `${t.name} [${t.status}]`;
        }

        let quota = "—";
        if (t?.quotaMb) {
            const usedMb = u.bytes / 1024 / 1024;
            quota = `${Math.round((usedMb / t.quotaMb) * 100)}% of ${t.quotaMb} MB`;
        }

        console.log(
            u.prefix.padEnd(14)
            + label.slice(0, 25).padEnd(26)
            + String(u.objects).padStart(8)
            + humanBytes(u.bytes).padStart(11)
            + "  " + quota,
        );

        if (BY_KIND) {
            for (const [kind, k] of Object.entries(u.byKind).sort((a, b) => b[1].bytes - a[1].bytes)) {
                console.log(`  └─ ${kind.padEnd(20)}${String(k.objects).padStart(20)}${humanBytes(k.bytes).padStart(11)}`);
            }
        }
    }

    // Tenants with no objects still matter: a tenant that should have uploads
    // but shows nothing is a signal worth surfacing.
    const seen = new Set(usage.map((u) => u.tenantId).filter((id): id is number => id !== null));
    const empty = [...tenants.entries()].filter(([id, t]) => !seen.has(id) && t.status === "active");
    if (empty.length) {
        console.log("\nActive tenants with no objects:");
        for (const [id, t] of empty) console.log(`  tenant_${id}/  ${t.name} (${t.slug})`);
    }

    console.log("");
    console.log("Prefixes are keyed by tenants.id, never by slug: a slug is freed and");
    console.log("reissued on tenant deletion, which would collide across customers.");
    console.log("See docs/adr/ADR-003-r2-prefixes-not-buckets.md");
}

if (require.main === module) {
    main().catch((err: unknown) => {
        console.error("FATAL:", (err as Error).message);
        process.exit(1);
    });
}

export { BUCKET, main, listAll, loadTenants };
