"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tenant resolution & isolation tests.
 *
 * Verifies the multi-tenant middleware behaves correctly:
 *   1. Requests with no JWT and no custom domain land on master context.
 *   2. JWT with `tenant_id` attaches the matching tenant DB.
 *   3. Forged `tenant_id` claims (signed with the wrong secret) are ignored.
 *   4. Suspended tenants get HTTP 503.
 *   5. Custom-domain → tenant resolution is cached and invalidated.
 *
 * These tests use mocks so they can run without a Postgres or Redis instance.
 */
// The global jest.setup.js mocks both the tenant middleware and tenantManager
// for the rest of the test suite. This file specifically tests the *real*
// middleware, so we have to undo those mocks before requiring the modules.
jest.unmock("../middleware/tenant");
jest.unmock("../utils/tenantManager");
jest.mock("../db", () => ({
    masterQuery: jest.fn(),
    masterTransaction: jest.fn(),
    pool: {},
}));
jest.mock("../utils/tenantManager", () => ({
    getTenantById: jest.fn(),
    getTenantPool: jest.fn(),
}));
jest.mock("../redis", () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
}));
jest.mock("../utils/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() },
}));
const jwt = require("jsonwebtoken");
// Force-load the real middleware module (jest.setup.js mocked it for everyone else)
const { resolveTenant, requireTenant, invalidateTenantCache } = jest.requireActual("../middleware/tenant");
const { masterQuery } = require("../db");
const { getTenantById, getTenantPool } = require("../utils/tenantManager");
const redis = require("../redis");
const SECRET = "test-secret";
process.env.JWT_SECRET = SECRET;
function makeReqRes({ token, host = "localhost" } = {}) {
    const req = {
        headers: { host },
        cookies: token ? { token } : {},
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
        status(code) { statusCode = code; return this; },
        json(body) { jsonBody = body; return this; },
        get statusCode() { return statusCode; },
        get jsonBody() { return jsonBody; },
    };
    const next = jest.fn();
    return { req, res, next, getStatus: () => statusCode, getJson: () => jsonBody };
}
beforeEach(() => {
    jest.clearAllMocks();
    masterQuery.mockReset();
    getTenantById.mockReset();
    getTenantPool.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
});
describe("resolveTenant middleware", () => {
    test("no token, no custom domain → master context", async () => {
        // Default Railway domain: should bypass domain lookup
        const { req, res, next } = makeReqRes({ host: "workpulse.up.railway.app" });
        await resolveTenant(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.tenant).toBeNull();
        expect(req.isMasterRoute).toBe(true);
        expect(req.db).toBeDefined();
        expect(req.db.query).toBe(masterQuery);
    });
    test("valid JWT with tenant_id attaches the tenant DB", async () => {
        const tenant = {
            id: 7,
            slug: "acme",
            db_name: "wp_acme",
            db_host: null,
            status: "active",
            features: {},
        };
        const token = jwt.sign({ id: 1, tenant_id: 7, sid: "s", tv: 0 }, SECRET);
        redis.get.mockResolvedValue(null); // cache miss
        getTenantById.mockResolvedValue(tenant);
        getTenantPool.mockResolvedValue({
            query: jest.fn(),
            transaction: jest.fn(),
            pool: {},
        });
        const { req, res, next } = makeReqRes({ token });
        await resolveTenant(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.tenant).toEqual(tenant);
        expect(req.tenantId).toBe(7);
        expect(req.isMasterRoute).toBe(false);
        expect(getTenantPool).toHaveBeenCalledWith("wp_acme", null);
    });
    test("forged JWT (wrong secret) is rejected → falls back to master", async () => {
        // Token signed with a DIFFERENT secret — jwt.verify must reject it.
        const forged = jwt.sign({ id: 1, tenant_id: 7 }, "WRONG-SECRET");
        const { req, res, next } = makeReqRes({ token: forged, host: "workpulse.up.railway.app" });
        await resolveTenant(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        // The forged tenant_id must be ignored: getTenantById should NEVER be
        // called with the attacker's claim.
        expect(getTenantById).not.toHaveBeenCalled();
        expect(req.tenant).toBeNull();
        expect(req.isMasterRoute).toBe(true);
    });
    test("suspended tenant returns 503 (no DB attached)", async () => {
        const suspended = {
            id: 5,
            slug: "frozen",
            db_name: "wp_frozen",
            status: "suspended",
            suspended_reason: "unpaid invoice",
        };
        const token = jwt.sign({ id: 1, tenant_id: 5, sid: "s", tv: 0 }, SECRET);
        redis.get.mockResolvedValue(null);
        getTenantById.mockResolvedValue(suspended);
        const { req, res, next, getStatus, getJson } = makeReqRes({ token });
        await resolveTenant(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(getStatus()).toBe(503);
        expect(getJson()).toMatchObject({
            error: expect.stringMatching(/suspended/i),
            reason: "unpaid invoice",
        });
        expect(getTenantPool).not.toHaveBeenCalled();
    });
    test("deleted tenant returns 404", async () => {
        const deleted = { id: 9, slug: "gone", db_name: "wp_gone", status: "deleted" };
        const token = jwt.sign({ id: 1, tenant_id: 9, sid: "s", tv: 0 }, SECRET);
        redis.get.mockResolvedValue(null);
        getTenantById.mockResolvedValue(deleted);
        const { req, res, next, getStatus } = makeReqRes({ token });
        await resolveTenant(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(getStatus()).toBe(404);
    });
    test("custom-domain resolution caches the result", async () => {
        const tenant = {
            id: 12,
            slug: "mycorp",
            db_name: "wp_mycorp",
            db_host: null,
            status: "active",
            features: {},
            max_users: null,
            max_storage_mb: null,
        };
        redis.get.mockResolvedValueOnce(null); // first call: cache miss
        masterQuery.mockResolvedValueOnce({ rows: [tenant] });
        getTenantPool.mockResolvedValue({ query: jest.fn(), transaction: jest.fn(), pool: {} });
        const { req, res, next } = makeReqRes({ host: "mycorp.example.com" });
        await resolveTenant(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.tenant).toEqual(tenant);
        // Cache write must have happened
        expect(redis.set).toHaveBeenCalledWith("tenant:domain:mycorp.example.com", tenant, expect.any(Number));
    });
    test("localhost is excluded from custom-domain lookup", async () => {
        const { req, res, next } = makeReqRes({ host: "localhost" });
        await resolveTenant(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(masterQuery).not.toHaveBeenCalled();
        expect(req.isMasterRoute).toBe(true);
    });
    test("invalidateTenantCache clears both id and domain cache keys", async () => {
        await invalidateTenantCache(7, "mycorp.example.com");
        expect(redis.del).toHaveBeenCalledWith("tenant:id:7");
        expect(redis.del).toHaveBeenCalledWith("tenant:domain:mycorp.example.com");
    });
    test("invalidateTenantCache without domain only clears id key", async () => {
        await invalidateTenantCache(7);
        expect(redis.del).toHaveBeenCalledWith("tenant:id:7");
        expect(redis.del).toHaveBeenCalledTimes(1);
    });
});
describe("requireTenant middleware", () => {
    test("passes when req.tenant is set", () => {
        const req = { tenant: { id: 1 } };
        const next = jest.fn();
        const res = { status: jest.fn(), json: jest.fn() };
        requireTenant(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });
    test("rejects with 400 when no tenant resolved", () => {
        const req = { tenant: null };
        const next = jest.fn();
        const statusFn = jest.fn(() => ({ json: jest.fn() }));
        const res = { status: statusFn };
        requireTenant(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(statusFn).toHaveBeenCalledWith(400);
    });
});
//# sourceMappingURL=tenant.middleware.test.js.map