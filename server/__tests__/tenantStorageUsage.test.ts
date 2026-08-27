/**
 * Per-tenant R2 usage, surfaced on the Platform Console tenant page.
 *
 * The contract that matters is NULL vs 0. `tenants.max_storage_mb` is a quota
 * on uploads, so an operator reading this card is deciding whether a customer
 * is near their limit. Rendering 0 MB when usage is merely *unmeasured* (local
 * dev, R2 unreachable) would read as "no uploads" and hide a real overage.
 */
export {};

const mockList = jest.fn();
const mockStorage: any = { name: "r2", list: mockList };

jest.mock("../platform/storage", () => ({
    getStorage: () => mockStorage,
    tenantPrefix: (id: number) => `tenant_${id}/`,
}));

jest.mock("../utils/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
    getTenantStorageUsage,
    tenantStorageStatsFields,
    __clearStorageUsageCache,
} = require("../services/tenantStorageUsage");

const obj = (key: string, size: number) => ({ key, size });

beforeEach(() => {
    __clearStorageUsageCache();
    mockList.mockReset();
    mockStorage.name = "r2";
    mockStorage.list = mockList;
});

describe("getTenantStorageUsage", () => {
    it("sums bytes and counts objects under the tenant prefix", async () => {
        mockList.mockResolvedValue([
            obj("tenant_1/org_1/avatars/a.png", 1000),
            obj("tenant_1/org_1/chat/b.mp4", 2500),
        ]);

        const usage = await getTenantStorageUsage(1);
        expect(usage.bytes).toBe(3500);
        expect(usage.objects).toBe(2);
        expect(mockList).toHaveBeenCalledWith("tenant_1/");
    });

    it("breaks usage down by upload kind", async () => {
        mockList.mockResolvedValue([
            obj("tenant_1/org_1/chat/a.mp4", 100),
            obj("tenant_1/org_1/chat/b.mp4", 200),
            obj("tenant_1/org_1/avatars/c.png", 50),
        ]);

        const { byKind } = await getTenantStorageUsage(1);
        expect(byKind.chat).toEqual({ objects: 2, bytes: 300 });
        expect(byKind.avatars).toEqual({ objects: 1, bytes: 50 });
    });

    it("returns zero — not null — for a tenant with no uploads", async () => {
        // A real, measured zero is meaningful and must be distinguishable from
        // "could not measure".
        mockList.mockResolvedValue([]);
        const usage = await getTenantStorageUsage(9);
        expect(usage).not.toBeNull();
        expect(usage.bytes).toBe(0);
        expect(usage.objects).toBe(0);
    });

    it("returns NULL when the backend cannot list (local dev)", async () => {
        mockStorage.name = "local";
        delete mockStorage.list;
        expect(await getTenantStorageUsage(1)).toBeNull();
    });

    it("returns NULL rather than throwing when R2 is unreachable", async () => {
        // The tenant page must still render if object storage is down.
        mockList.mockRejectedValue(new Error("network unreachable"));
        expect(await getTenantStorageUsage(1)).toBeNull();
    });

    it("caches so opening the page repeatedly does not re-list the bucket", async () => {
        // ListObjectsV2 is a billed Class A operation.
        mockList.mockResolvedValue([obj("tenant_1/org_1/chat/a.mp4", 10)]);

        const first = await getTenantStorageUsage(1);
        const second = await getTenantStorageUsage(1);

        expect(mockList).toHaveBeenCalledTimes(1);
        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.bytes).toBe(10);
    });

    it("re-lists when forced", async () => {
        mockList.mockResolvedValue([obj("tenant_1/org_1/chat/a.mp4", 10)]);
        await getTenantStorageUsage(1);
        await getTenantStorageUsage(1, { force: true });
        expect(mockList).toHaveBeenCalledTimes(2);
    });

    it("caches per tenant, never sharing across tenants", async () => {
        mockList.mockResolvedValueOnce([obj("tenant_1/org_1/chat/a.mp4", 10)]);
        mockList.mockResolvedValueOnce([obj("tenant_2/org_1/chat/b.mp4", 999)]);

        expect((await getTenantStorageUsage(1)).bytes).toBe(10);
        expect((await getTenantStorageUsage(2)).bytes).toBe(999);
    });
});

describe("tenantStorageStatsFields", () => {
    it("shapes the API response when usage is known", async () => {
        mockList.mockResolvedValue([obj("tenant_1/org_1/avatars/a.png", 2048)]);
        const fields = await tenantStorageStatsFields(1);
        expect(fields).toEqual({
            storage_bytes: 2048,
            storage_objects: 1,
            storage_by_kind: { avatars: { objects: 1, bytes: 2048 } },
        });
    });

    it("emits NULL — never 0 — when usage is unknown", async () => {
        // 🔴 A 0 here would render as "0 MB" and read as "no uploads".
        mockStorage.name = "local";
        delete mockStorage.list;
        expect(await tenantStorageStatsFields(1)).toEqual({
            storage_bytes: null,
            storage_objects: null,
            storage_by_kind: null,
        });
    });
});
