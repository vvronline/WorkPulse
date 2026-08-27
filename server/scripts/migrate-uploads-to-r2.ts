#!/usr/bin/env node
/**
 * A3.8 — one-shot copy of the Railway upload volume into Cloudflare R2.
 *
 * WHY THIS EXISTS
 *   The volume is mounted at /app/server/uploads and is reachable ONLY from
 *   inside a Railway container. A workstation behind a corporate firewall
 *   cannot SSH/SFTP to it, so "sync it from your laptop" is not a real option.
 *   This script therefore runs *in* the container, where the volume is a plain
 *   local directory and the R2 credentials are already in the environment.
 *
 * KEY FORMAT
 *   The R2 key is the path relative to the uploads root, unchanged:
 *       /app/server/uploads/tenant_1/org_1/avatar/x.png
 *                        -> tenant_1/org_1/avatar/x.png
 *   That equivalence is the whole reason no data migration is needed — every
 *   avatar/logo_url/file_url already in a tenant DB keeps resolving.
 *
 * SAFETY
 *   - READ-ONLY against the volume. Never deletes or modifies a local file.
 *   - IDEMPOTENT + RESUMABLE: an object already in R2 with the same byte size
 *     is skipped, so re-running is the supported way to do the final delta pass.
 *   - --dry-run makes no writes at all.
 *
 * USAGE (inside the container)
 *   node scripts/migrate-uploads-to-r2.js --dry-run    # inspect, write nothing
 *   node scripts/migrate-uploads-to-r2.js              # perform the copy
 *   node scripts/migrate-uploads-to-r2.js --verify     # compare counts/sizes
 *   node scripts/migrate-uploads-to-r2.js --force      # re-upload even if present
 *
 * ENVIRONMENT
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY  (required)
 *   R2_UPLOADS_BUCKET   default: aino-uploads
 *   UPLOADS_DIR         default: /app/server/uploads
 *
 *   STORAGE_DRIVER is deliberately NOT read: this talks to R2 directly, so it
 *   works regardless of how the app itself is configured.
 */
import fs from "fs";
import path from "path";
import {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");
const VERIFY_ONLY = process.argv.includes("--verify");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = Math.max(1, parseInt(process.env.COPY_CONCURRENCY || "", 10) || 8);

const UPLOADS_DIR = process.env.UPLOADS_DIR || "/app/server/uploads";
const BUCKET = process.env.R2_UPLOADS_BUCKET || "aino-uploads";

/** Minimal content-type map; anything unknown is served as a download. */
const CONTENT_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
    ".json": "application/json", ".zip": "application/zip",
    ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function contentTypeFor(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

interface LocalFile {
    absPath: string;
    key: string;
    size: number;
}

/** Recursively list every real file under the uploads root. */
function walk(dir: string, root: string, out: LocalFile[] = []): LocalFile[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.error(`  ! cannot read ${dir}: ${(err as Error).message}`);
        return out;
    }

    for (const entry of entries) {
        // Skip dotfiles (.gitkeep, .DS_Store): not user content.
        if (entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(abs, root, out);
        } else if (entry.isFile()) {
            // An S3/R2 key always uses forward slashes.
            const key = path.relative(root, abs).split(path.sep).join("/");
            out.push({ absPath: abs, key, size: fs.statSync(abs).size });
        }
    }
    return out;
}

function buildClient(): S3Client {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    const missing = [
        !accountId && "R2_ACCOUNT_ID",
        !accessKeyId && "R2_ACCESS_KEY_ID",
        !secretAccessKey && "R2_SECRET_ACCESS_KEY",
    ].filter(Boolean);

    if (missing.length) {
        console.error(`ERROR: missing environment: ${missing.join(", ")}`);
        process.exit(1);
    }

    return new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    });
}

/** Every object currently in the bucket, key -> size. */
async function listRemote(client: S3Client): Promise<Map<string, number>> {
    const remote = new Map<string, number>();
    let token: string | undefined;
    do {
        const page = await client.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            ContinuationToken: token,
        }));
        for (const obj of page.Contents || []) {
            if (obj.Key) remote.set(obj.Key, obj.Size || 0);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return remote;
}

function human(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function main(): Promise<void> {
    console.log("=".repeat(70));
    console.log("A3.8 — copy upload volume to Cloudflare R2");
    console.log("=".repeat(70));
    console.log(`  source : ${UPLOADS_DIR}`);
    console.log(`  bucket : ${BUCKET}`);
    console.log(`  mode   : ${VERIFY_ONLY ? "VERIFY" : DRY_RUN ? "DRY RUN" : "COPY"}`);
    console.log("");

    if (!fs.existsSync(UPLOADS_DIR)) {
        console.error(`ERROR: ${UPLOADS_DIR} does not exist.`);
        console.error("Is the volume still attached to this service?");
        process.exit(1);
    }

    const files = walk(UPLOADS_DIR, UPLOADS_DIR);
    const localBytes = files.reduce((n, f) => n + f.size, 0);
    console.log(`Local:  ${files.length} file(s), ${human(localBytes)}`);

    if (files.length === 0) {
        console.log("\nNothing to copy. (An empty volume is expected once R2 is live.)");
        return;
    }

    const client = buildClient();
    const remote = await listRemote(client);
    const remoteBytes = [...remote.values()].reduce((n, s) => n + s, 0);
    console.log(`Remote: ${remote.size} object(s), ${human(remoteBytes)}`);
    console.log("");

    // ── Verify mode: report only, change nothing ────────────────────────────
    if (VERIFY_ONLY) {
        const missing = files.filter((f) => !remote.has(f.key));
        const mismatch = files.filter(
            (f) => remote.has(f.key) && remote.get(f.key) !== f.size,
        );

        console.log(`Missing in R2   : ${missing.length}`);
        console.log(`Size mismatches : ${mismatch.length}`);
        for (const f of missing.slice(0, 20)) console.log(`  MISSING  ${f.key}`);
        if (missing.length > 20) console.log(`  ... and ${missing.length - 20} more`);
        for (const f of mismatch.slice(0, 20)) {
            console.log(`  SIZE     ${f.key} (local ${f.size}, remote ${remote.get(f.key)})`);
        }

        console.log("");
        if (missing.length === 0 && mismatch.length === 0) {
            console.log("RESULT: PASS — every local file is in R2 at the same size.");
        } else {
            console.log("RESULT: INCOMPLETE — re-run without --verify to copy the rest.");
            process.exit(1);
        }
        return;
    }

    // ── Copy ────────────────────────────────────────────────────────────────
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let uploadedBytes = 0;
    const failures: string[] = [];
    let cursor = 0;
    let done = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const index = cursor++;
            if (index >= files.length) return;
            const file = files[index];

            // Resumable: identical size means already copied. Re-downloading
            // 330 MB to compare bytes costs more than it proves for an
            // append-only upload store.
            if (!FORCE && remote.get(file.key) === file.size) {
                skipped++;
            } else if (DRY_RUN) {
                uploaded++;
                uploadedBytes += file.size;
                if (uploaded <= 20) console.log(`  would upload  ${file.key}`);
            } else {
                try {
                    await client.send(new PutObjectCommand({
                        Bucket: BUCKET,
                        Key: file.key,
                        Body: fs.createReadStream(file.absPath),
                        ContentLength: file.size,
                        ContentType: contentTypeFor(file.absPath),
                    }));
                    uploaded++;
                    uploadedBytes += file.size;
                } catch (err) {
                    failed++;
                    failures.push(`${file.key}: ${(err as Error).message}`);
                }
            }

            done++;
            if (done % 100 === 0 || done === files.length) {
                console.log(`  progress ${done}/${files.length}  (${human(uploadedBytes)} sent)`);
            }
        }
    }

    const started = Date.now();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log("");
    console.log("=".repeat(70));
    console.log(`${DRY_RUN ? "DRY RUN" : "COPY"} complete in ${seconds}s`);
    console.log(`  uploaded : ${uploaded}  (${human(uploadedBytes)})`);
    console.log(`  skipped  : ${skipped}  (already in R2 at the same size)`);
    console.log(`  failed   : ${failed}`);
    console.log("=".repeat(70));

    for (const f of failures.slice(0, 25)) console.error(`  FAIL ${f}`);

    if (failed > 0) {
        console.error("\nRe-run the same command; completed files are skipped.");
        process.exit(1);
    }

    if (!DRY_RUN) {
        // Confirm the end state rather than trusting the counters.
        const after = await listRemote(client);
        const stillMissing = files.filter((f) => !after.has(f.key));
        console.log(`\nPost-copy check: ${after.size} object(s) in R2, ${stillMissing.length} local file(s) missing.`);
        if (stillMissing.length > 0) {
            for (const f of stillMissing.slice(0, 20)) console.error(`  MISSING ${f.key}`);
            process.exit(1);
        }
        console.log("RESULT: PASS — every local file is present in R2.");
    }
}

if (require.main === module) {
    main().catch((err: unknown) => {
        console.error("FATAL:", (err as Error).message);
        process.exit(1);
    });
}

export { walk, contentTypeFor, human, listRemote, main };
