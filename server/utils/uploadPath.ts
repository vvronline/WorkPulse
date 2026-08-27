/**
 * Per-tenant upload path helper.
 *
 * ── A3 (2026-08): uploads moved from local disk to object storage ───────────
 *
 * Uploads now live in Cloudflare R2, not `server/uploads/`. The Railway volume
 * that backed the old directory could only attach to ONE instance, which made
 * running multiple replicas impossible. See docs/SCALABILITY_REFACTOR_PLAN.md A3.
 *
 * The key format is unchanged:
 *   tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 * and so is the stored URL:
 *   /uploads/tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 *
 * Because both are identical to the previous layout, every `avatar`,
 * `logo_url` and `file_url` already in a tenant database keeps working with no
 * data migration, and the tenant/org checks in index.ts are untouched.
 *
 * This module is now a thin compatibility layer over
 * `platform/storage/keys.ts`. Prefer importing from there in new code.
 */
import { buildUploadKey, buildUploadUrl, urlToKey } from "../platform/storage/keys";

/**
 * Storage key for an upload (no leading slash, no `/uploads` prefix).
 *
 * Replaces the old `getUploadDir()`, which created a directory on disk and
 * returned its absolute path. There is no directory to create any more —
 * object storage has no real directories, only key prefixes.
 *
 * @param tenantId Required. From req.tenantId.
 * @param orgId    Required. From req.userOrgId.
 * @param kind     Logical bucket: 'chat' | 'avatars' | 'branding' | ...
 * @param filename Server-generated filename (never the user's original).
 */
function getUploadKey(
    tenantId: number | string,
    orgId: number | string,
    kind: string,
    filename: string,
): string {
    return buildUploadKey(tenantId, orgId, kind, filename);
}

/**
 * Canonical URL stored in the database and returned to clients.
 * e.g. /uploads/tenant_5/org_42/chat/foo.png
 */
function getUploadUrl(
    tenantId: number | string,
    orgId: number | string,
    kind: string,
    filename: string,
): string {
    if (!filename) throw new Error("uploadPath: filename is required");
    return buildUploadUrl(tenantId, orgId, kind, filename);
}

/**
 * Convert a stored URL back into a storage key, or null when unusable.
 * Handles legacy non-tenant-prefixed URLs too.
 */
function getKeyFromUrl(url: string | null | undefined): string | null {
    return urlToKey(url);
}

export {
    getUploadKey,
    getUploadUrl,
    getKeyFromUrl,
};
