/**
 * Phase H2 — the HTTP collector must label by ROUTE TEMPLATE.
 *
 * Labelling with the concrete URL would create one series per task id / user
 * id, which is the single fastest way to destroy a Prometheus server. These
 * tests exist to make that regression impossible.
 */
export {};

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (_req: any, _res: any, next: any) => next(),
}));

const express = require("express");
const request = require("supertest");
const { installHttpMetrics } = require("../platform/metrics/httpMetrics");
const { registry, __resetForTests } = require("../platform/metrics/registry");
const { __resetForTests: resetTenants } = require("../platform/metrics/tenantLabel");

function buildApp() {
    const app = express();
    installHttpMetrics(app);

    const tasks = express.Router();
    tasks.get("/:id", (_req: any, res: any) => res.json({ ok: true }));
    tasks.get("/", (_req: any, res: any) => res.json({ ok: true }));
    app.use("/api/tasks", tasks);

    app.get("/healthz", (_req: any, res: any) => res.json({ ok: true }));
    app.get("/boom", (_req: any, res: any) => res.status(500).json({ error: "x" }));
    return app;
}

async function seriesFor(name: string) {
    const metric = await registry.getSingleMetric(name).get();
    return metric.values;
}

describe("HTTP metrics collector", () => {
    beforeEach(() => {
        __resetForTests();
        resetTenants();
    });

    it("collapses distinct ids into ONE route-template series", async () => {
        const app = buildApp();
        for (const id of [1, 2, 3, 4, 5, 999]) {
            await request(app).get(`/api/tasks/${id}`);
        }

        const counts = await seriesFor("aino_http_requests_total");
        const routes = new Set(counts.map((v: any) => v.labels.route));
        expect(routes).toEqual(new Set(["/api/tasks/:id"]));

        const total = counts.reduce((sum: number, v: any) => sum + v.value, 0);
        expect(total).toBe(6);
    });

    it("records status class rather than one series per status code", async () => {
        const app = buildApp();
        await request(app).get("/boom");
        const counts = await seriesFor("aino_http_requests_total");
        const boom = counts.find((v: any) => v.labels.route === "/boom");
        expect(boom.labels.status_class).toBe("5xx");
    });

    it("folds unmatched paths into a single `unmatched` series", async () => {
        const app = buildApp();
        // Scanner traffic: every path is different and none of them match.
        for (const path of ["/wp-login.php", "/.env", "/admin.php", "/xyz"]) {
            await request(app).get(path);
        }
        const counts = await seriesFor("aino_http_requests_total");
        const unmatched = counts.filter((v: any) => v.labels.route === "unmatched");
        expect(unmatched).toHaveLength(1);
        expect(unmatched[0].value).toBe(4);
    });

    it("observes duration into the histogram with a bounded tenant label", async () => {
        const app = buildApp();
        await request(app).get("/api/tasks/1");
        const values = await seriesFor("aino_http_request_duration_seconds");
        const counted = values.filter((v: any) => v.metricName?.endsWith("_count"));
        expect(counted.length).toBeGreaterThan(0);
        // No tenant middleware ran, so the label must be the master default,
        // never `undefined` (which would render as an empty label value).
        expect(counted[0].labels.tenant).toBe("master");
    });

    it("keeps a mounted-but-unmatched request on its mount prefix", async () => {
        const app = express();
        installHttpMetrics(app);
        const router = express.Router();
        // Simulates auth rejecting before any leaf route matches.
        router.use((_req: any, res: any) => res.status(401).json({ error: "no" }));
        app.use("/api/admin", router);

        await request(app).get("/api/admin/anything/deep");
        const counts = await seriesFor("aino_http_requests_total");
        expect(counts.some((v: any) => v.labels.route === "/api/admin/*")).toBe(true);
    });
});
