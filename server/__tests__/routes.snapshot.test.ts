/**
 * ROUTE SNAPSHOT — the refactor safety belt (Phase B, task B1).
 *
 * WHAT THIS PROTECTS
 *   Phase C moves ~30 router mounts out of index.ts, and Phase G splits
 *   4,000-line route files into modules. The worst failure mode in that work is
 *   silently DROPPING or RENAMING an endpoint: nothing throws, unrelated tests
 *   still pass, and the break only shows up as a 404 in production.
 *
 *   This test snapshots every mounted `METHOD /path`. Any add, removal or
 *   rename fails CI with an exact diff.
 *
 * WHEN THE SNAPSHOT CHANGES
 *   Intentionally adding or removing an endpoint SHOULD change it. Review the
 *   diff carefully, confirm each line is deliberate, then update with:
 *
 *       npx jest routes.snapshot -u
 *
 *   During a pure refactor (Phase C/G) the diff MUST be empty. A non-empty
 *   diff means the move lost something.
 *
 * NOTE
 *   `instrumentExpress()` must run before index.ts is loaded — Express 5 does
 *   not retain router mount paths, so they are recorded at `use()` time.
 */
export {};

// ── Instrument Express BEFORE the app is imported ───────────────────────────
import { instrumentExpress, listRoutes, formatRoutes } from "../platform/routeInventory";
instrumentExpress(require("express"));

// ── Silence logs / stub side-effecting modules ──────────────────────────────
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(),
        fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req: any, _res: any, next: any) => {
        req.id = "test";
        req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        next();
    },
}));

jest.mock("../utils/mailer", () => ({
    getTransporter: jest.fn(() => null),
    sendMail: jest.fn(),
    notifyByEmail: jest.fn(),
    esc: (s: any) => String(s ?? ""),
    templates: {},
    TEMPLATE_KEYS: [],
    TEMPLATE_PREVIEW_ARGS: {},
    applyBranding: jest.fn(),
    invalidateBrandingCache: jest.fn(),
    loadOrgBranding: jest.fn(),
}));

jest.mock("../utils/ws", () => ({
    setupWebSocket: jest.fn(),
    sendToUser: jest.fn(),
    broadcast: jest.fn(),
    emitCallHistoryMessage: jest.fn(),
    getWsStats: jest.fn(() => ({})),
}));

jest.mock("../utils/collaboration", () => ({ createCollaborationServer: jest.fn() }));
jest.mock("../jobs", () => ({ initJobs: jest.fn(), shutdownJobs: jest.fn(), enqueueChatMediaPipelineJob: jest.fn() }));
jest.mock("../db", () => ({
    pool: { end: jest.fn(), query: jest.fn() },
    masterQuery: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    masterTransaction: jest.fn(),
    initDB: jest.fn(),
    initTenantSchema: jest.fn(),
    makePoolQuery: jest.fn(),
    makePoolTransaction: jest.fn(),
    seedAgileDefaults: jest.fn(),
}));

describe("route inventory snapshot", () => {
    let routes: ReturnType<typeof listRoutes>;

    beforeAll(() => {
        // NODE_ENV=test suppresses bootstrap(), crash handlers and listen().
        const { app } = require("../index");
        routes = listRoutes(app);
    });

    it("exposes a plausible number of endpoints", () => {
        // A guard against the inventory silently returning [] — which would
        // make the snapshot below vacuously pass forever.
        expect(routes.length).toBeGreaterThan(100);
    });

    it("resolves real mount prefixes (no leaked regex source)", () => {
        for (const r of routes) {
            expect(r.path.startsWith("/")).toBe(true);

            // index.ts registers the SPA catch-all with a genuine RegExp
            // (`/^[^.]*$/` — any path without a dot), so its stringified form
            // is expected. Everything else must be a clean literal path;
            // regex characters there would mean mountPathOf() failed to
            // recover a prefix and leaked the compiled pattern.
            if (r.path.startsWith("/^")) continue;
            expect(r.path).not.toMatch(/[()\\^$]/);
        }
    });

    it("mounts the core API surface", () => {
        const paths = routes.map((r) => r.path);
        for (const prefix of [
            "/api/auth", "/api/tasks", "/api/chat", "/api/tracker",
            "/api/leaves", "/api/admin", "/api/profile",
        ]) {
            expect(paths.some((p) => p.startsWith(prefix))).toBe(true);
        }
    });

    it("matches the committed route snapshot", () => {
        expect(formatRoutes(routes)).toMatchSnapshot();
    });
});
