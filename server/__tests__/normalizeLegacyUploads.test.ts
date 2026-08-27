/**
 * Legacy upload-key classification.
 *
 * The normalize script MOVES objects and REWRITES database URLs, so a
 * misclassification either corrupts a working key or silently skips a broken
 * one. The classifier is therefore the part worth pinning down.
 *
 * Real keys observed in aino-uploads on 2026-08-27 are used as fixtures.
 */
export {};

const { classifyLegacyKey } = require("../scripts/normalize-legacy-uploads");

describe("classifyLegacyKey", () => {
    it("ignores canonical keys", () => {
        // These are already correct — touching them would be a regression.
        for (const key of [
            "tenant_1/org_1/avatars/user_1_1787837968191.jpg",
            "tenant_1/org_1/chat/3_1784374535316.mp4",
            "tenant_1/org_1/task-comments/3_1781463587115.pdf",
            "tenant_12/org_345/branding/logo_abc.svg",
        ]) {
            expect(classifyLegacyKey(key)).toBeNull();
        }
    });

    it("classifies org-scoped legacy keys", () => {
        // Real fixture: org_1/avatars/user_1_1777270695696.jpg
        expect(classifyLegacyKey("org_1/avatars/user_1_1777270695696.jpg")).toEqual({
            key: "org_1/avatars/user_1_1777270695696.jpg",
            orgId: 1,
            kind: "avatars",
            filename: "user_1_1777270695696.jpg",
        });
    });

    it("classifies the oldest bare keys (no org, no tenant)", () => {
        // Real fixture: avatars/user_1_1775078052613.png
        expect(classifyLegacyKey("avatars/user_1_1775078052613.png")).toEqual({
            key: "avatars/user_1_1775078052613.png",
            orgId: null,
            kind: "avatars",
            filename: "user_1_1775078052613.png",
        });
    });

    it("skips verification probe objects", () => {
        // Left behind by scripts/verify-r2-credentials.mjs; not user content.
        expect(classifyLegacyKey("_probe-1756301234567.txt")).toBeNull();
    });

    it("ignores a bare filename at the bucket root", () => {
        // No kind segment means there is nowhere sensible to move it.
        expect(classifyLegacyKey("stray.png")).toBeNull();
    });

    it("preserves multi-word kinds", () => {
        const out = classifyLegacyKey("org_2/task-comments/5_1781463587115.pdf");
        expect(out.kind).toBe("task-comments");
        expect(out.orgId).toBe(2);
    });

    it("treats a deeper unknown shape as unclassifiable rather than guessing", () => {
        // 4+ segments that are not tenant_/org_ prefixed: moving these would be
        // a guess, and a wrong guess breaks a working URL.
        expect(classifyLegacyKey("a/b/c/d.png")).toBeNull();
    });
});

describe("the 5 legacy objects actually in the bucket", () => {
    // Captured from a live listing on 2026-08-27. If the classifier stops
    // recognising these, the cleanup would silently skip them.
    const observed = [
        "avatars/user_1_1775078052613.png",
        "avatars/user_1_1775307715819.png",
        "avatars/user_2_1775282562303.jpg",
        "org_1/avatars/user_1_1777270695696.jpg",
        "org_1/avatars/user_1_1777974937033.jpg",
    ];

    it("recognises every one of them as legacy", () => {
        for (const key of observed) {
            const out = classifyLegacyKey(key);
            expect(out).not.toBeNull();
            expect(out.kind).toBe("avatars");
        }
    });

    it("extracts the org id only where the key carries one", () => {
        expect(classifyLegacyKey(observed[0]).orgId).toBeNull();
        expect(classifyLegacyKey(observed[3]).orgId).toBe(1);
    });
});
