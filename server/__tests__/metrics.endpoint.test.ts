/** Phase H1/H2 — /metrics exposure, auth policy and route-label cardinality. */
export {};

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../utils/tenantManager", () => ({
    getPoolStats: () => ({
        poolCount: 2,
        maxPools: 100,
        poolSize: 3,
        metrics: { hits: 9, misses: 1, hitRate: 0.9, evictions: 0, busyEvictions: 0, totalWaiting: 0 },
        pools: {
            tenant_a: { total: 3, idle: 2, waiting: 0 },
            tenant_b: { total: 2, idle: 2, waiting: 1 },
        },
    }),
}));

jest.mock("../redis", () => ({
    getClient: () => null,
    isRedisReady: () => true,
    isSubscriberReady: () => true,
}));

const express = require("express");
const request = require("supertest");

const ORIGINAL_ENV = { ...process.env };

function buildMetricsApp() {
    jest.resetModules();
    const { mountMetricsEndpoint } = require("../platform/metrics/endpoint");
    const app = express();
    mountMetricsEndpoint(app);
    return app;
}

describe("GET /metrics", () => {
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("is open in development when no token is configured", async () => {
        process.env.NODE_ENV = "development";
        delete process.env.METRICS_TOKEN;
        const res = await request(buildMetricsApp()).get("/metrics");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/plain");
    });

    it("fails closed in production when no token is configured", async () => {
        // An unauthenticated /metrics on a public domain is an information
        // disclosure bug; a missing variable must not open it.
        process.env.NODE_ENV = "production";
        delete process.env.METRICS_TOKEN;
        const res = await request(buildMetricsApp()).get("/metrics");
        expect(res.status).toBe(404);
    });

    it("rejects a missing or wrong bearer token with 404, not 401", async () => {
        process.env.NODE_ENV = "production";
        process.env.METRICS_TOKEN = "correct-horse-battery-staple";
        const app = buildMetricsApp();

        expect((await request(app).get("/metrics")).status).toBe(404);
        expect(
            (await request(app).get("/metrics").set("Authorization", "Bearer wrong")).status,
        ).toBe(404);
        expect(
            (await request(app).get("/metrics").set("Authorization", "Basic abc")).status,
        ).toBe(404);
    });

    it("serves the exposition body for a valid token", async () => {
        process.env.NODE_ENV = "production";
        process.env.METRICS_TOKEN = "correct-horse-battery-staple";
        const res = await request(buildMetricsApp())
            .get("/metrics")
            .set("Authorization", "Bearer correct-horse-battery-staple");

        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        // Pool gauges come from the mocked tenantManager. Default labels
        // (role, instance_id) are appended to every series, so match loosely
        // on the label that matters plus the value.
        expect(res.text).toContain("aino_db_pool_connections");
        expect(res.text).toMatch(/aino_db_pool_connections\{state="waiting"[^}]*\} 1\b/);
        expect(res.text).toMatch(/aino_db_pool_connections\{state="total"[^}]*\} 5\b/);
        expect(res.text).toContain("aino_db_tenant_pools");
        expect(res.text).toContain("aino_redis_up");
        // Default process collectors must be registered exactly once.
        expect(res.text).toContain("aino_process_cpu_user_seconds_total");
    });

    it("labels every series with the process role", async () => {
        process.env.NODE_ENV = "development";
        process.env.ROLE = "worker";
        delete process.env.METRICS_TOKEN;
        const res = await request(buildMetricsApp()).get("/metrics");
        expect(res.text).toContain('role="worker"');
        delete process.env.ROLE;
    });
});
