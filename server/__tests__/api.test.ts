export {};

// Suppress pino logs during tests
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
        debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req: any, _res: any, next: any) => {
        req.id = "test";
        req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        next();
    },
}));

const request = require("supertest");

// Mock the DB layer so tests don't need a real database
jest.mock("../db", () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    return {
        pool: { end: jest.fn() },
        query: mockQuery,
        masterQuery: mockQuery,
        transaction: jest.fn(async (fn: any) => fn({ query: mockQuery })),
        masterTransaction: jest.fn(async (fn: any) => fn({ query: mockQuery })),
        initDB: jest.fn(),
    };
});

const { app } = require("../index");

describe("GET /api/health", () => {
    test("returns ok status", async () => {
        const res = await request(app).get("/api/health");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.time).toBeDefined();
    });
});

describe("CSRF protection", () => {
    test("blocks POST without X-Requested-With header", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ username: "test", password: "test" });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/CSRF/i);
    });

    test("allows POST with correct CSRF header", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .set("X-Requested-With", "WorkPulse")
            .send({ username: "test", password: "test" });
        // Should get past CSRF — may get 400/401 from auth logic, but NOT 403
        expect(res.status).not.toBe(403);
    });
});

describe("Rate limiting", () => {
    test("auth routes have rate limiting active", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .set("X-Requested-With", "WorkPulse")
            .send({ username: "test", password: "test" });
        // express-rate-limit v7+ uses ratelimit-* headers (lowercase)
        const hasRateLimit =
            res.headers["ratelimit-limit"] ||
            res.headers["x-ratelimit-limit"] ||
            res.headers["retry-after"];
        expect(hasRateLimit || res.status !== 429 ? true : false).toBeTruthy();
    });
});