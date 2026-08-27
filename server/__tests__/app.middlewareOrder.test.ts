/**
 * Phase C regression tests for ordering-sensitive middleware.
 *
 * The route snapshot protects endpoint paths, not registration order. These
 * requests cover the two most dangerous ordering contracts:
 * - webhook routes are mounted before browser CSRF enforcement;
 * - ordinary mutating API routes remain behind CSRF enforcement.
 */
export {};

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req: any, _res: any, next: any) => {
        req.id = "test";
        req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        next();
    },
}));

jest.mock("../db", () => ({
    masterQuery: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    masterTransaction: jest.fn(),
    pool: { end: jest.fn(), query: jest.fn() },
    initDB: jest.fn(), initTenantSchema: jest.fn(),
    makePoolQuery: jest.fn(), makePoolTransaction: jest.fn(), seedAgileDefaults: jest.fn(),
}));
jest.mock("../utils/ws", () => ({
    setupWebSocket: jest.fn(), sendToUser: jest.fn(), broadcast: jest.fn(),
    emitCallHistoryMessage: jest.fn(), getWsStats: jest.fn(() => ({})),
}));
jest.mock("../jobs", () => ({
    initJobs: jest.fn(), shutdownJobs: jest.fn(), enqueueChatMediaPipelineJob: jest.fn(),
}));

const request = require("supertest");
const { app } = require("../index");

describe("application middleware order", () => {
    it("lets a webhook request reach its router without the browser CSRF header", async () => {
        // An unknown provider may 404/400 inside the webhook router; the key
        // invariant is that the global CSRF middleware did NOT return 403.
        const res = await request(app)
            // This is the real router shape. A non-numeric id is rejected by
            // webhooks.ts itself with 400 before any DB access.
            .post("/api/webhooks/github/not-a-number")
            .send({ ping: true });
        // The webhook router may itself return 403 for an invalid provider or
        // signature. What must not happen is the GLOBAL browser-CSRF response.
        expect(res.body?.error).not.toBe("Missing CSRF header");
    });

    it("blocks an ordinary mutating API request without the CSRF header", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ username: "nobody", password: "nope" });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Missing CSRF header" });
    });

    it("accepts the AINO CSRF header and passes beyond the guard", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .set("X-Requested-With", "AINO")
            .send({ username: "nobody", password: "nope" });
        expect(res.body?.error).not.toBe("Missing CSRF header");
    });
});