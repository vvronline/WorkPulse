/**
 * Phase H3 — bounded tenant labels.
 *
 * A `tenant` label on an HTTP histogram multiplies series by the tenant count.
 * At 100 tenants × ~450 routes × 14 buckets that is millions of series and it
 * will take down the scrape target long before it takes down the app.
 *
 * Policy: track request volume per tenant, expose only the busiest
 * `METRICS_TENANT_TOP_N` (default 20) under their own label, and fold every
 * other tenant into a single `other` bucket. The top-N set is recomputed on a
 * fixed interval from a decaying counter, so a tenant that goes quiet is
 * eventually demoted and its series stops growing.
 */
const OTHER = "other";
const MASTER = "master";

const TOP_N = Math.max(1, parseInt(process.env.METRICS_TENANT_TOP_N || "", 10) || 20);
// How often the promoted set is recomputed. Frequent enough to follow real
// traffic shifts, rare enough that sorting is irrelevant to request latency.
const REFRESH_MS = Math.max(
    10_000,
    parseInt(process.env.METRICS_TENANT_REFRESH_MS || "", 10) || 60_000,
);
// Each refresh halves historical volume so a burst cannot pin a tenant in the
// top-N forever.
const DECAY = 0.5;

const volume = new Map<string, number>();
let promoted = new Set<string>();
// `null` rather than 0: a zero epoch would make the FIRST observation look
// like the refresh window had already elapsed, promoting a brand-new tenant on
// sight — precisely the unbounded behaviour this module exists to prevent.
let lastRefresh: number | null = null;

/** Normalize any tenant identifier into a safe, bounded label value. */
function normalize(tenantId: number | string | null | undefined): string {
    if (tenantId === null || tenantId === undefined || tenantId === "") return MASTER;
    const raw = String(tenantId);
    // Defensive: a label value is attacker-influenced if a header ever reaches
    // here. Bound the length and character set so it cannot forge exposition.
    const safe = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48);
    return safe.length > 0 ? safe : MASTER;
}

/** Recompute the promoted set when the refresh window has elapsed. */
function refresh(now: number): void {
    if (lastRefresh === null) {
        // Start the clock on first use; do not promote anything yet.
        lastRefresh = now;
        return;
    }
    if (now - lastRefresh < REFRESH_MS) return;
    lastRefresh = now;

    const ranked = [...volume.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_N);
    promoted = new Set(ranked.map(([key]) => key));

    for (const [key, count] of volume) {
        const decayed = count * DECAY;
        // Drop cold tenants entirely; otherwise the bookkeeping map itself
        // becomes the unbounded structure we were trying to avoid.
        if (decayed < 1 && !promoted.has(key)) volume.delete(key);
        else volume.set(key, decayed);
    }
}

/**
 * Record one observation for `tenantId` and return the label to use.
 *
 * `master` is always its own label — it is a single well-known identity and is
 * the one series an operator looks at first during an incident.
 */
function tenantLabel(tenantId: number | string | null | undefined, now = Date.now()): string {
    const key = normalize(tenantId);
    if (key === MASTER) return MASTER;

    volume.set(key, (volume.get(key) || 0) + 1);
    refresh(now);

    // A brand-new tenant is `other` until the next refresh promotes it. That
    // is the correct default: unbounded promotion on first sight is exactly
    // the cardinality bomb this module exists to prevent.
    return promoted.has(key) ? key : OTHER;
}

/** Current promoted labels — used by tests and the internal stats endpoint. */
function promotedTenants(): string[] {
    return [...promoted].sort();
}

/** Test-only: forget all volume history. */
function __resetForTests(): void {
    volume.clear();
    promoted = new Set();
    lastRefresh = null;
}

export { tenantLabel, promotedTenants, normalize, TOP_N, OTHER, MASTER, __resetForTests };
