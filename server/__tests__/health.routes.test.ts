/** Phase D liveness/readiness behavior. */
export {};

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (_req: any, _res: any, next: any) => next(),
}));

const masterQuery = jest.fn(async (_sql?: string, _params?: unknown[]) => ({
    rows: [{ "?column?": 1 }], rowCount: 1,
}));
jest.mock("../db", () => ({
    masterQuery: (sql: string, params?: unknown[]) => masterQuery(sql, params),
    masterTransaction: jest.fn(), pool: { end: jest.fn(), query: jest.fn() },
    initDB: jest.fn(), initTenantSchema: jest.fn(), makePoolQuery: jest.fn(),
    makePoolTransaction: jest.fn(), seedAgileDefaults: jest.fn(),
}));

const redisPing = jest.fn(async () => true);
let subscriberReady = true;
jest.mock("../redis", () => ({
    ping: () => redisPing(),
    isRedisReady: () => true,
    isSubscriberReady: () => subscriberReady,
}));

const express = require("express");
const request = require("supertest");
const { mountHealthRoutes } = require("../http/health");

describe("health routes", () => {
    let app: any;
    beforeEach(() => {
        masterQuery.mockClear();
        redisPing.mockClear();
        subscriberReady = true;
        app = express();
        mountHealthRoutes(app);
    });

    it("/healthz is dependency-free", async () => {
        const res = await request(app).get("/healthz");
        expect(res.status).toBe(200);
        expect(masterQuery).not.toHaveBeenCalled();
        expect(redisPing).not.toHaveBeenCalled();
    });

    it("/readyz is ready only when DB, Redis and subscriber are ready", async () => {
        const res = await request(app).get("/readyz");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ready");
    });

    it("/readyz fails when the subscriber is not ready", async () => {
        subscriberReady = false;
        const res = await request(app).get("/readyz");
        expect(res.status).toBe(503);
        expect(res.body.redisSubscriber).toBe("unavailable");
    });

    it("/api/health ignores detail and never sweeps tenants", async () => {
        const res = await request(app).get("/api/health?detail=true");
        expect(res.status).toBe(200);
        expect(res.body.migrations).toBeUndefined();
        expect(masterQuery).toHaveBeenCalledTimes(1);
    });
});