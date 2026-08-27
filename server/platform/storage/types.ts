/**
 * Storage abstraction — object keys, not filesystem paths.
 *
 * WHY THIS EXISTS
 *   Uploads used to be written to `server/uploads/` on local disk. On Railway
 *   that directory is a **volume, and a volume attaches to exactly one
 *   instance** — so the app physically could not run more than one replica.
 *   Instance B also could not serve a file instance A had written.
 *
 *   Moving uploads to object storage (Cloudflare R2) is what unblocks
 *   horizontal scaling. See docs/SCALABILITY_REFACTOR_PLAN.md, task A3.
 *
 * KEY FORMAT — unchanged from the previous on-disk layout:
 *   tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 *
 *   Keeping the exact same shape means every `logo_url` / `avatar` /
 *   `file_url` value already in the database stays valid, and the tenant/org
 *   authorization checks in `index.ts` keep working verbatim.
 *
 * ISOLATION MODEL (ADR-003/004)
 *   One PRIVATE bucket, per-tenant key prefixes — not one bucket per tenant.
 *   Access is granted by short-lived presigned URLs for a single key, so a
 *   client can never enumerate or reach another tenant's prefix.
 */

/** Logical grouping inside a tenant/org prefix. */
export type UploadKind =
    | "avatars"
    | "chat"
    | "branding"
    | "task-comments"
    | "notes"
    | "exports";

export interface PutOptions {
    /** MIME type stored as object metadata and returned on download. */
    contentType?: string;
    /**
     * Cache-Control for the stored object. Uploads are immutable (filenames
     * carry a timestamp), so a long TTL is safe and keeps egress down.
     */
    cacheControl?: string;
}

export interface StoredObject {
    key: string;
    size: number;
    contentType?: string;
    lastModified?: Date;
}

/**
 * Minimal surface every backend must implement.
 *
 * Deliberately small: no streaming, no multipart. Current uploads cap at 25 MB
 * (chat), which comfortably fits a single buffered PUT.
 */
export interface StorageAdapter {
    /** Human-readable backend name, for logs and health output. */
    readonly name: string;

    /** Write an object. Overwrites silently if the key already exists. */
    put(key: string, body: Buffer, opts?: PutOptions): Promise<void>;

    /** Read an object. Returns null when the key does not exist. */
    get(key: string): Promise<Buffer | null>;

    /** Delete one object. Deleting a missing key is not an error. */
    delete(key: string): Promise<void>;

    /**
     * Delete every object under a prefix.
     * Used by `deleteTenant()` to purge `tenant_<id>/` in one call.
     */
    deletePrefix(prefix: string): Promise<number>;

    /** True when the key exists. */
    exists(key: string): Promise<boolean>;

    /**
     * Time-limited download URL.
     *
     * Returns null for backends that cannot presign (the local dev adapter),
     * signalling the caller to stream the bytes itself instead.
     */
    getSignedUrl(key: string, expiresInSeconds?: number): Promise<string | null>;

    /** Metadata without downloading the body. Null when absent. */
    stat(key: string): Promise<StoredObject | null>;
}
