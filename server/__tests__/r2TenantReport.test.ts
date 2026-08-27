/**
 * R2 usage grouping by tenant prefix.
 *
 * This report is the reason keys stay `tenant_<id>/` rather than `<slug>/`:
 * it supplies the human readability without making the key depend on a mutable,
 * reissuable value. The grouping must therefore be exact — a prefix attributed
 * to the wrong tenant would misreport quota usage and, worse, mislead anyone
 * reasoning about which customer owns which objects.
 */
export {};

const { summarise, humanBytes } = require("../scripts/r2-tenant-report");

const obj = (key: string, size = 100, at?: string) => ({
    key, size, at: at ? new Date(at) : undefined,
});

describe("summarise", () => {
    it("groups objects under their tenant prefix", () => {
        const out = summarise([
            obj("tenant_1/org_1/avatars/a.png", 500),
            obj("tenant_1/org_1/chat/b.mp4", 1500),
            obj("tenant_4/org_9/avatars/c.jpg", 300),
        ]);

        expect(out.get("tenant_1/").objects).toBe(2);
        expect(out.get("tenant_1/").bytes).toBe(2000);
        expect(out.get("tenant_1/").tenantId).toBe(1);
        expect(out.get("tenant_4/").objects).toBe(1);
        expect(out.get("tenant_4/").tenantId).toBe(4);
    });

    it("separates legacy keys instead of guessing a tenant", () => {
        // Misattributing these would make one tenant's usage look larger and
        // imply ownership the key does not actually establish.
        const out = summarise([
            obj("tenant_1/org_1/avatars/a.png"),
            obj("avatars/user_1_1775078052613.png"),
            obj("org_1/avatars/user_1_1777270695696.jpg"),
        ]);

        expect(out.get("tenant_1/").objects).toBe(1);
        expect(out.get("(legacy)").objects).toBe(2);
        expect(out.get("(legacy)").tenantId).toBeNull();
    });

    it("breaks usage down by upload kind", () => {
        const out = summarise([
            obj("tenant_1/org_1/chat/a.mp4", 1000),
            obj("tenant_1/org_1/chat/b.mp4", 2000),
            obj("tenant_1/org_1/avatars/c.png", 50),
        ]);

        const kinds = out.get("tenant_1/").byKind;
        expect(kinds.chat).toEqual({ objects: 2, bytes: 3000 });
        expect(kinds.avatars).toEqual({ objects: 1, bytes: 50 });
    });

    it("tracks the newest object per tenant", () => {
        const out = summarise([
            obj("tenant_1/org_1/chat/old.mp4", 1, "2026-01-01T00:00:00Z"),
            obj("tenant_1/org_1/chat/new.mp4", 1, "2026-08-27T00:00:00Z"),
        ]);
        expect(out.get("tenant_1/").newest.toISOString()).toBe("2026-08-27T00:00:00.000Z");
    });

    it("does not confuse tenant_1 with tenant_10", () => {
        // A prefix match on `tenant_1` would swallow tenant_10, tenant_100, ...
        const out = summarise([
            obj("tenant_1/org_1/avatars/a.png"),
            obj("tenant_10/org_1/avatars/b.png"),
            obj("tenant_100/org_1/avatars/c.png"),
        ]);
        expect([...out.keys()].sort()).toEqual(["tenant_1/", "tenant_10/", "tenant_100/"]);
        expect(out.get("tenant_1/").objects).toBe(1);
    });

    it("handles an empty bucket", () => {
        expect(summarise([]).size).toBe(0);
    });

    it("reproduces the live bucket shape (2026-08-27)", () => {
        // 148 canonical + 5 legacy = the 153 objects actually present.
        const objects = [
            ...Array.from({ length: 148 }, (_, i) => obj(`tenant_1/org_1/chat/f${i}.jpg`, 1000)),
            obj("avatars/user_1_1775078052613.png"),
            obj("avatars/user_1_1775307715819.png"),
            obj("avatars/user_2_1775282562303.jpg"),
            obj("org_1/avatars/user_1_1777270695696.jpg"),
            obj("org_1/avatars/user_1_1777974937033.jpg"),
        ];
        const out = summarise(objects);
        expect(out.get("tenant_1/").objects).toBe(148);
        expect(out.get("(legacy)").objects).toBe(5);
    });
});

describe("humanBytes", () => {
    it("scales units", () => {
        expect(humanBytes(512)).toBe("512 B");
        expect(humanBytes(2048)).toBe("2.0 KB");
        expect(humanBytes(268 * 1024 * 1024)).toBe("268.0 MB");
        expect(humanBytes(2 * 1024 ** 3)).toBe("2.00 GB");
    });
});
