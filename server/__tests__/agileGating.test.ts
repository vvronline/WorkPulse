export {};

/**
 * Agile & Sprints feature-gate regression tests.
 *
 * Regression context: the sprint-related routes under /api/tasks
 * (/tasks/available-sprints, /tasks/:id/assign-sprint) were NOT gated on the
 * `agile` feature, while /api/sprints and /api/agile were. A tenant whose
 * "Agile & Sprints" was disabled via a platform-console feature override could
 * still list — and even auto-materialise — sprints through the ungated
 * endpoints, which is why the mobile app kept showing the Sprint tab after
 * the override was turned off. These tests pin the fix: with agile OFF both
 * routes return the standard 403 FEATURE_NOT_AVAILABLE gate response; with
 * agile ON they proceed past the gate.
 */

// The global jest.setup.js mocks middleware/tenant with pass-through stubs.
// This suite needs the REAL requireFeature, so unmock before requiring.
jest.unmock("../middleware/tenant");

// Mock auth/rbac so the router's downstream middlewares are inert — the gate
// runs BEFORE auth in the route chain, so a 403 from the gate proves the
// feature check fired first.
jest.mock("../middleware/auth", () =>
    (req: any, _res: any, next: any) => { req.userId = 1; next(); });
jest.mock("../middleware/rbac", () => ({
    loadUserContext: (req: any, _res: any, next: any) => {
        req.userRole = "employee";
        req.userOrgId = 1;
        req.userTeamId = null; // no team → available-sprints returns []
        next();
    },
    requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

const express = require("express");
const request = require("supertest");

function makeApp(tenant: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
        req.tenant = tenant;
        req.tenantId = tenant?.id ?? null;
        req.db = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            transaction: jest.fn(),
        };
        req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        next();
    });
    const sprintsRouter = require("../routes/tasks/sprints");
    app.use("/api/tasks", sprintsRouter);
    return app;
}

describe("Agile gate on /api/tasks sprint routes", () => {
    test("GET /tasks/available-sprints → 403 when agile is disabled by override", async () => {
        // Pro plan has agile OFF by default; explicit override keeps intent clear.
        const app = makeApp({ id: 7, plan: "pro", features: { agile: false } });
        const res = await request(app).get("/api/tasks/available-sprints");
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FEATURE_NOT_AVAILABLE");
        expect(res.body.feature).toBe("agile");
    });

    test("GET /tasks/available-sprints → 403 when the plan default disables agile", async () => {
        const app = makeApp({ id: 7, plan: "standard", features: {} });
        const res = await request(app).get("/api/tasks/available-sprints");
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FEATURE_NOT_AVAILABLE");
    });

    test("GET /tasks/available-sprints passes the gate when agile is enabled", async () => {
        const app = makeApp({ id: 7, plan: "enterprise", features: {} });
        const res = await request(app).get("/api/tasks/available-sprints");
        // Gate passed → handler ran (no team → empty list), NOT a 403.
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test("GET /tasks/available-sprints — feature override can enable agile on a lower plan", async () => {
        const app = makeApp({ id: 7, plan: "pro", features: { agile: true } });
        const res = await request(app).get("/api/tasks/available-sprints");
        expect(res.status).toBe(200);
    });

    test("PATCH /tasks/:id/assign-sprint → 403 when agile is disabled", async () => {
        const app = makeApp({ id: 7, plan: "enterprise", features: { agile: false } });
        const res = await request(app)
            .patch("/api/tasks/42/assign-sprint")
            .send({ sprint_id: 1 });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FEATURE_NOT_AVAILABLE");
        expect(res.body.feature).toBe("agile");
    });
});