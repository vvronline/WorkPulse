/**
 * Storage key helpers — A3 regression tests.
 *
 * The key format MUST remain identical to the pre-A3 on-disk layout:
 *   tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 *
 * Every `avatar`, `logo_url` and `file_url` already persisted in a tenant
 * database depends on that equivalence, as do the tenant/org authorization
 * regexes in index.ts. A change here is a silent data-loss bug.
 */
import {
    buildUploadKey,
    buildUploadUrl,
    urlToKey,
    tenantPrefix,
    orgPrefix,
    tenantIdFromKey,
    orgIdFromKey,
} from "../platform/storage/keys";

describe("buildUploadKey", () => {
    it("produces the canonical tenant/org/kind/file layout", () => {
        expect(buildUploadKey(5, 42, "chat", "a.png")).toBe("tenant_5/org_42/chat/a.png");
    });

    it("coerces numeric-looking strings", () => {
        expect(buildUploadKey("5", "42", "avatars", "u.jpg")).toBe("tenant_5/org_42/avatars/u.jpg");
    });

    it.each([
        [0, 1],
        [1, 0],
        [null, 1],
        [1, undefined],
    ])("rejects missing ids (%s, %s)", (t, o) => {
        expect(() => buildUploadKey(t as any, o as any, "chat", "a.png")).toThrow();
    });

    it.each(["../etc", "a/b", "a\\b", "a\0b"])("rejects unsafe filename %j", (name) => {
        expect(() => buildUploadKey(1, 1, "chat", name)).toThrow();
    });

    it.each(["../x", "a/b", "a\\b"])("rejects unsafe kind %j", (kind) => {
        expect(() => buildUploadKey(1, 1, kind, "a.png")).toThrow();
    });
});

describe("buildUploadUrl", () => {
    it("prefixes the key with /uploads", () => {
        expect(buildUploadUrl(5, 42, "chat", "a.png")).toBe("/uploads/tenant_5/org_42/chat/a.png");
    });
});

describe("urlToKey", () => {
    it.each([
        ["/uploads/tenant_5/org_42/chat/a.png", "tenant_5/org_42/chat/a.png"],
        ["uploads/tenant_5/org_42/chat/a.png", "tenant_5/org_42/chat/a.png"],
        ["/tenant_5/org_42/chat/a.png", "tenant_5/org_42/chat/a.png"],
        // Legacy shape, pre-dating the tenant prefix.
        ["/uploads/org_42/avatars/a.png", "org_42/avatars/a.png"],
    ])("maps %j -> %j", (url, key) => {
        expect(urlToKey(url)).toBe(key);
    });

    it.each([null, undefined, "", "   /../etc/passwd", "/uploads/../../secret"])(
        "rejects %j",
        (bad) => {
            expect(urlToKey(bad as any)).toBeNull();
        },
    );

    it("round-trips with buildUploadUrl", () => {
        const key = buildUploadKey(7, 3, "branding", "logo-1.png");
        expect(urlToKey(buildUploadUrl(7, 3, "branding", "logo-1.png"))).toBe(key);
    });
});

describe("prefixes", () => {
    it("builds a tenant prefix with a trailing slash", () => {
        // The trailing slash matters: without it, tenant_1/ would also match
        // tenant_10/ and delete another tenant's objects.
        expect(tenantPrefix(1)).toBe("tenant_1/");
    });

    it("builds an org prefix", () => {
        expect(orgPrefix(1, 2)).toBe("tenant_1/org_2/");
    });

    it("does not let tenant_1 prefix-match tenant_10", () => {
        expect("tenant_10/org_1/chat/a.png".startsWith(tenantPrefix(1))).toBe(false);
    });
});

describe("id extraction", () => {
    it("reads the tenant id", () => {
        expect(tenantIdFromKey("tenant_5/org_42/chat/a.png")).toBe(5);
    });

    it("returns null for legacy keys with no tenant prefix", () => {
        expect(tenantIdFromKey("org_42/avatars/a.png")).toBeNull();
    });

    it("reads the org id in both layouts", () => {
        expect(orgIdFromKey("tenant_5/org_42/chat/a.png")).toBe(42);
        expect(orgIdFromKey("org_42/avatars/a.png")).toBe(42);
    });
});
