/**
 * Object-key construction and validation.
 *
 * The key format is IDENTICAL to the previous on-disk layout:
 *   tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 *
 * and the public URL stays:
 *   /uploads/tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 *
 * That equivalence is deliberate — every `avatar`, `logo_url` and `file_url`
 * already stored in a tenant database keeps working with no data migration,
 * and the tenant/org authorization regexes in index.ts are unaffected.
 */
import type { UploadKind } from "./types";

/** URL prefix under which uploads are served. */
export const UPLOAD_URL_PREFIX = "/uploads";

/** Reject anything that could escape its prefix or break a key. */
function assertSafeSegment(value: string, label: string): void {
    if (!value || typeof value !== "string") {
        throw new Error(`uploadKey: ${label} is required`);
    }
    if (value.includes("/") || value.includes("\\") || value.includes("..") || value.includes("\0")) {
        throw new Error(`uploadKey: invalid ${label}`);
    }
}

/**
 * Build the storage key for an upload.
 *
 * @throws if tenantId/orgId are missing or any segment is unsafe.
 */
export function buildUploadKey(
    tenantId: number | string,
    orgId: number | string,
    kind: UploadKind | string,
    filename: string,
): string {
    if (!tenantId) throw new Error("uploadKey: tenantId is required");
    if (!orgId) throw new Error("uploadKey: orgId is required");
    assertSafeSegment(String(kind), "kind");
    assertSafeSegment(filename, "filename");
    return `tenant_${Number(tenantId)}/org_${Number(orgId)}/${kind}/${filename}`;
}

/**
 * Public URL for a stored object. This is what gets persisted in the database
 * and returned to clients.
 */
export function buildUploadUrl(
    tenantId: number | string,
    orgId: number | string,
    kind: UploadKind | string,
    filename: string,
): string {
    return `${UPLOAD_URL_PREFIX}/${buildUploadKey(tenantId, orgId, kind, filename)}`;
}

/**
 * Convert a stored URL back into a storage key.
 *
 * Handles every historical shape:
 *   /uploads/tenant_5/org_1/chat/a.png -> tenant_5/org_1/chat/a.png
 *   uploads/tenant_5/org_1/chat/a.png  -> tenant_5/org_1/chat/a.png
 *   /uploads/org_1/avatars/a.png       -> org_1/avatars/a.png   (legacy)
 *
 * Returns null when the value is empty or contains traversal.
 */
export function urlToKey(url: string | null | undefined): string | null {
    if (!url || typeof url !== "string") return null;
    if (url.includes("..") || url.includes("\0")) return null;

    let s = url.trim().replace(/^\/+/, "");
    if (s.startsWith("uploads/")) s = s.slice("uploads/".length);
    if (!s) return null;

    // Never allow an absolute path or a drive letter to survive.
    if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return null;
    return s;
}

/** All objects belonging to a tenant — used when deleting a tenant. */
export function tenantPrefix(tenantId: number | string): string {
    if (!tenantId) throw new Error("uploadKey: tenantId is required");
    return `tenant_${Number(tenantId)}/`;
}

/** All objects belonging to one org inside a tenant. */
export function orgPrefix(tenantId: number | string, orgId: number | string): string {
    if (!tenantId) throw new Error("uploadKey: tenantId is required");
    if (!orgId) throw new Error("uploadKey: orgId is required");
    return `tenant_${Number(tenantId)}/org_${Number(orgId)}/`;
}

/**
 * Extract the tenant id encoded in a key, or null for legacy keys that
 * predate the tenant prefix.
 */
export function tenantIdFromKey(key: string): number | null {
    const m = /^tenant_(\d+)\//.exec(key);
    return m ? parseInt(m[1], 10) : null;
}

/** Extract the org id encoded in a key, or null when absent. */
export function orgIdFromKey(key: string): number | null {
    const m = /(?:^|\/)org_(\d+)\//.exec(key);
    return m ? parseInt(m[1], 10) : null;
}
