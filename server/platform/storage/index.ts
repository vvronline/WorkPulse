/**
 * Storage entry point — picks the backend and exposes a single instance.
 *
 *   STORAGE_DRIVER=r2     -> Cloudflare R2 (production; stateless, replica-safe)
 *   STORAGE_DRIVER=local  -> server/uploads on disk (development only)
 *
 * Default: `r2` in production, `local` otherwise.
 *
 * PRODUCTION GUARD
 *   Running `local` in production silently reintroduces the single-replica
 *   constraint A3 exists to remove, and any file written by one instance would
 *   be invisible to the others. `assertProductionStorage()` turns that into a
 *   startup failure instead of a subtle runtime bug.
 *
 * See docs/SCALABILITY_REFACTOR_PLAN.md task A3.
 */
import { logger } from "../../utils/logger";
import { LocalAdapter } from "./localAdapter";
import { R2Adapter } from "./r2Adapter";
import type { StorageAdapter } from "./types";

export * from "./types";
export * from "./keys";
export * from "./filenames";

let _adapter: StorageAdapter | null = null;

function resolveDriver(): "r2" | "local" {
    const explicit = (process.env.STORAGE_DRIVER || "").trim().toLowerCase();
    if (explicit === "r2" || explicit === "local") return explicit;
    if (explicit) {
        logger.warn({ STORAGE_DRIVER: explicit }, "Unknown STORAGE_DRIVER — falling back to default");
    }
    return process.env.NODE_ENV === "production" ? "r2" : "local";
}

function buildR2(): StorageAdapter {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_UPLOADS_BUCKET || "aino-uploads";

    const missing = [
        !accountId && "R2_ACCOUNT_ID",
        !accessKeyId && "R2_ACCESS_KEY_ID",
        !secretAccessKey && "R2_SECRET_ACCESS_KEY",
    ].filter(Boolean);

    if (missing.length) {
        throw new Error(
            `Storage driver "r2" selected but missing env: ${missing.join(", ")}. `
            + `Set them, or use STORAGE_DRIVER=local for development.`,
        );
    }

    logger.info({ bucket, driver: "r2" }, "Storage: using Cloudflare R2");
    return new R2Adapter({
        accountId: accountId!,
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        bucket,
    });
}

/** The process-wide storage adapter (lazily constructed, then cached). */
export function getStorage(): StorageAdapter {
    if (_adapter) return _adapter;

    if (resolveDriver() === "r2") {
        _adapter = buildR2();
    } else {
        logger.info({ driver: "local" }, "Storage: using local filesystem (development)");
        _adapter = new LocalAdapter();
    }
    return _adapter;
}

/**
 * Fail fast when production is configured with local disk.
 *
 * Called from the server entry point BEFORE listening, so a misconfigured
 * deploy dies at boot rather than corrupting state across replicas.
 */
export function assertProductionStorage(): void {
    if (process.env.NODE_ENV !== "production") return;
    if (resolveDriver() === "local") {
        throw new Error(
            "STORAGE_DRIVER=local is not supported in production: a local directory "
            + "cannot be shared between replicas, so uploads written by one instance "
            + "would be invisible to the others. Set STORAGE_DRIVER=r2 with "
            + "R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.",
        );
    }
    // Surface credential problems at boot, not on the first upload.
    getStorage();
}

/** Test-only: drop the cached adapter so env changes take effect. */
export function __resetStorageForTests(): void {
    _adapter = null;
}
