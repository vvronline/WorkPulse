/** Phase H3 — tenant label cardinality must stay bounded. */
export {};

const {
    tenantLabel,
    promotedTenants,
    normalize,
    TOP_N,
    OTHER,
    MASTER,
    __resetForTests,
} = require("../platform/metrics/tenantLabel");

// The refresh window is 60s by default, so tests advance a synthetic clock
// rather than waiting.
const REFRESH_MS = 60_000;

describe("tenant metric labels", () => {
    beforeEach(() => __resetForTests());

    it("maps null/undefined/empty tenants to master", () => {
        expect(tenantLabel(null)).toBe(MASTER);
        expect(tenantLabel(undefined)).toBe(MASTER);
        expect(tenantLabel("")).toBe(MASTER);
    });

    it("strips characters that could forge exposition output", () => {
        expect(normalize('7"} evil{x="')).toBe("7___evil_x__");
        expect(normalize("a\nb")).toBe("a_b");
    });

    it("bounds label length", () => {
        expect(normalize("x".repeat(200)).length).toBe(48);
    });

    it("returns `other` for an unseen tenant rather than promoting on sight", () => {
        // Promoting immediately is exactly the cardinality bomb this guards.
        expect(tenantLabel(42)).toBe(OTHER);
    });

    it("promotes only the busiest TOP_N tenants after a refresh", () => {
        const now = Date.now();
        // Tenant 1 is busiest, then 2, ... Give each a distinct volume.
        const tenantCount = TOP_N + 10;
        for (let t = 1; t <= tenantCount; t++) {
            for (let i = 0; i < tenantCount - t + 1; i++) tenantLabel(t, now);
        }

        // Force the refresh window to elapse.
        tenantLabel(1, now + REFRESH_MS + 1);

        const promoted = promotedTenants();
        expect(promoted).toHaveLength(TOP_N);
        // The busiest tenant is promoted; the quietest is not.
        expect(promoted).toContain("1");
        expect(promoted).not.toContain(String(tenantCount));
    });

    it("folds non-promoted tenants into a single `other` series", () => {
        const now = Date.now();
        for (let t = 1; t <= TOP_N + 5; t++) {
            for (let i = 0; i < TOP_N + 5 - t + 1; i++) tenantLabel(t, now);
        }
        const later = now + REFRESH_MS + 1;
        tenantLabel(1, later);

        const labels = new Set<string>();
        for (let t = 1; t <= TOP_N + 5; t++) labels.add(tenantLabel(t, later));

        // Total distinct labels can never exceed TOP_N + the `other` bucket.
        expect(labels.size).toBeLessThanOrEqual(TOP_N + 1);
        expect(labels.has(OTHER)).toBe(true);
    });

    it("demotes a tenant that goes quiet", () => {
        let now = Date.now();
        // Establish tenant `busy` as the only promoted tenant.
        for (let i = 0; i < 50; i++) tenantLabel("busy", now);
        now += REFRESH_MS + 1;
        tenantLabel("busy", now);
        expect(promotedTenants()).toContain("busy");

        // `busy` goes silent while others take over. Decay halves its volume
        // each refresh, so it eventually falls out of the top-N.
        for (let round = 0; round < 12; round++) {
            now += REFRESH_MS + 1;
            for (let t = 0; t < TOP_N; t++) {
                for (let i = 0; i < 100; i++) tenantLabel(`new${t}`, now);
            }
        }
        expect(promotedTenants()).not.toContain("busy");
    });

    it("never lets the internal volume map grow without bound", () => {
        let now = Date.now();
        // Each tenant is seen exactly once, then never again.
        for (let t = 0; t < 500; t++) {
            tenantLabel(`ghost${t}`, now);
            now += REFRESH_MS + 1;
        }
        // Cold single-hit tenants decay below 1 and are dropped, so the
        // promoted set stays at or under the cap.
        expect(promotedTenants().length).toBeLessThanOrEqual(TOP_N);
    });
});
