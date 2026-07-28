export {};

// Suppress pino logs during tests
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
}));

const mockQuery: jest.Mock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock("../db", () => ({
    query: (...args: any[]) => mockQuery(...args),
    masterQuery: (...args: any[]) => mockQuery(...args),
    masterTransaction: (fn: any) => fn({ query: (...a: any[]) => mockQuery(...a) }),
}));

const { hasTenantDataConsent } = require("../utils/impersonationApproval");

const DEFAULT_TENANT = { id: 1, is_default: true };
const OTHER_TENANT = { id: 7, is_default: false };

describe("hasTenantDataConsent", () => {
    beforeEach(() => {
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    it("always allows the default tenant without hitting the database", async () => {
        await expect(hasTenantDataConsent(DEFAULT_TENANT, { userId: 42 })).resolves.toBe(true);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it("denies a non-default tenant when there is no live session", async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        await expect(hasTenantDataConsent(OTHER_TENANT, { userId: 42 })).resolves.toBe(false);
    });

    it("allows a non-default tenant when the caller owns the live session", async () => {
        mockQuery.mockResolvedValue({ rows: [{ id: 5, tenant_id: 7, requested_by: 42 }], rowCount: 1 });
        await expect(hasTenantDataConsent(OTHER_TENANT, { userId: 42 })).resolves.toBe(true);
    });

    it("denies when the live session belongs to a DIFFERENT platform admin", async () => {
        // Another inspector's approved session must never widen this admin's
        // visibility - this is the core isolation guarantee of the guard.
        mockQuery.mockResolvedValue({ rows: [{ id: 5, tenant_id: 7, requested_by: 99 }], rowCount: 1 });
        await expect(hasTenantDataConsent(OTHER_TENANT, { userId: 42 })).resolves.toBe(false);
    });

    it("attributes the session to the impersonating actor, not the inspector row", async () => {
        mockQuery.mockResolvedValue({ rows: [{ id: 5, tenant_id: 7, requested_by: 42 }], rowCount: 1 });
        await expect(
            hasTenantDataConsent(OTHER_TENANT, { userId: 1234, impersonatedBy: 42 }),
        ).resolves.toBe(true);
    });

    it("only counts sessions that are consumed, unrevoked and unexpired", async () => {
        mockQuery.mockResolvedValue({ rows: [{ requested_by: 42 }], rowCount: 1 });
        await hasTenantDataConsent(OTHER_TENANT, { userId: 42 });
        const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, " ");
        expect(sql).toContain("status = 'consumed'");
        expect(sql).toContain("revoked_at IS NULL");
        expect(sql).toContain("session_ends_at > NOW()");
        expect(mockQuery.mock.calls[0][1]).toEqual([7]);
    });

    it("fails closed when the consent lookup throws", async () => {
        mockQuery.mockRejectedValue(new Error("db down"));
        await expect(hasTenantDataConsent(OTHER_TENANT, { userId: 42 })).resolves.toBe(false);
    });

    it("denies when the tenant is missing", async () => {
        await expect(hasTenantDataConsent(null, { userId: 42 })).resolves.toBe(false);
        await expect(hasTenantDataConsent(undefined, { userId: 42 })).resolves.toBe(false);
    });
});
