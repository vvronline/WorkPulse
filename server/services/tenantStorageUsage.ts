/**
 * Live R2 storage usage for one tenant.
 *
 * WHY A SERVICE
 *   The Platform Console shows `DB Size` but nothing for uploads, even though
 *   `tenants.max_storage_mb` exists as a quota column. Postgres size is the
 *   smaller half of the story: on the default tenant the database is ~50 MB
 *   while uploads are ~265 MB.
 *
 * WHY IT SUMS A PREFIX RATHER THAN READING A COUNTER
 *   No counter exists, and maintaining one means every upload/delete path stays
 *   in sync forever — including the "orphaned object" cases the copier and the
 *   attachment-reference check deliberately tolerate. Listing is authoritative
 *   by construction.
 *
 * COST
 *   ListObjectsV2 is a Class A operation billed per 1,000 objects listed. This
 *   is cached (see CACHE_TTL_MS) so opening the tenant page repeatedly does not
 *   re-list the bucket. Skipped entirely when storage is not R2.
 */
const { getStorage, tenantPrefix } = require("../platform/storage");
const { logger } = require("../utils/logger");

/** Usage changes slowly; a stale-by-minutes number is fine for an admin page. */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface TenantStorageUsage {
    bytes: number;
    objects: number;
    /** Per upload kind (avatars / chat / branding / task-comments). */
    byKind: Record<string, { objects: number; bytes: number }>;
    /** True when served from cache rather than a fresh listing. */
    cached: boolean;
    computedAt: string;
}

const cache = new Map<number, { at: number; value: TenantStorageUsage }>();

/** Test seam: drop memoised results. */
export function __clearStorageUsageCache(): void {
    cache.clear();
}

/**
 * The storage fields the tenant-stats API returns.
 *
 * Shaped here rather than inline in the route so the null-means-unknown
 * contract lives next to the code that decides it. `null` must reach the
 * client untouched: a `0` would read as "no uploads" when the real answer is
 * "not measured".
 */
export async function tenantStorageStatsFields(tenantId: number): Promise<{
    storage_bytes: number | null;
    storage_objects: number | null;
    storage_by_kind: Record<string, { objects: number; bytes: number }> | null;
}> {
    const usage = await getTenantStorageUsage(tenantId);
    return {
        storage_bytes: usage?.bytes ?? null,
        storage_objects: usage?.objects ?? null,
        storage_by_kind: usage?.byKind ?? null,
    };
}

/**
 * Sum every object under `tenant_<id>/`.
 *
 * Returns null when usage cannot be determined — no R2 driver, or a listing
 * failure. The caller renders nothing rather than a misleading `0 MB`, which
 * would look like "this tenant has no uploads".
 */
export async function getTenantStorageUsage(
    tenantId: number,
    opts: { force?: boolean } = {},
): Promise<TenantStorageUsage | null> {
    const cached = cache.get(tenantId);
    if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return { ...cached.value, cached: true };
    }

    const storage = getStorage();
    // LocalAdapter has no list(); only R2 can answer this.
    if (storage.name !== "r2" || typeof storage.list !== "function") return null;

    try {
        const prefix = tenantPrefix(tenantId);
        const objects: { key: string; size: number }[] = await storage.list(prefix);

        let bytes = 0;
        const byKind: Record<string, { objects: number; bytes: number }> = {};

        for (const obj of objects) {
            bytes += obj.size;
            // tenant_<id>/org_<id>/<kind>/<file> -> kind is segment 2.
            const parts = obj.key.split("/");
            const kind = parts.length >= 4 ? parts[2] : "other";
            const bucket = byKind[kind] || (byKind[kind] = { objects: 0, bytes: 0 });
            bucket.objects++;
            bucket.bytes += obj.size;
        }

        const value: TenantStorageUsage = {
            bytes,
            objects: objects.length,
            byKind,
            cached: false,
            computedAt: new Date().toISOString(),
        };
        cache.set(tenantId, { at: Date.now(), value });
        return value;
    } catch (err) {
        // Never fail the tenant page because object storage is unreachable.
        logger.warn({ err, tenantId }, "Tenant storage usage unavailable");
        return null;
    }
}
