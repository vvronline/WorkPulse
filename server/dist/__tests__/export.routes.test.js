"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Tests for /api/export routes — my-analytics, my-leaves, my-tasks, payroll, team exports
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
        debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req, _res, next) => {
        req.id = "test";
        req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        next();
    },
}));
jest.mock("../utils/mailer", () => ({
    getTransporter: jest.fn(() => null),
    sendMail: jest.fn(),
    notifyByEmail: jest.fn(),
    esc: (s) => String(s ?? ""),
}));
jest.mock("../utils/ws", () => ({
    setupWebSocket: jest.fn(),
    sendToUser: jest.fn(),
    broadcast: jest.fn(),
}));
jest.mock("../utils/audit", () => ({
    logAction: jest.fn(),
    queryLogs: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
}));
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock("../db", () => ({
    pool: { end: jest.fn() },
    query: (...args) => mockQuery(...args),
    masterQuery: (...args) => mockQuery(...args),
    masterTransaction: (fn) => fn({ query: (...a) => mockQuery(...a) }),
    transaction: jest.fn(async (fn) => fn({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
    initDB: jest.fn(),
}));
const { app } = require("../index");
const SECRET = process.env.JWT_SECRET || "test-secret";
const CSRF = { "X-Requested-With": "WorkPulse" };
function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: "testuser", tv: 0 }, SECRET, { expiresIn: "1h" });
    return `token=${token}`;
}
function setupAuth(role = "employee", extra = {}) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({
        rows: [
            {
                role,
                org_id: 1,
                team_id: 1,
                department_id: 1,
                manager_id: null,
                is_active: true,
                ...extra,
            },
        ],
        rowCount: 1,
    });
}
// ─── GET /api/export/my-analytics ────────────────────────────────────────
describe("GET /api/export/my-analytics", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/export/my-analytics?from=2024-01-01&to=2024-01-31");
        expect(res.status).toBe(401);
    });
    test("returns 400 when from/to params are missing", async () => {
        setupAuth();
        const res = await request(app).get("/api/export/my-analytics").set("Cookie", authCookie());
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns CSV response for analytics with data", async () => {
        setupAuth();
        const entries = [
            {
                user_id: 1,
                entry_type: "clock_in",
                timestamp: "2024-01-15T09:00:00Z",
                work_mode: "office",
                approval_status: "approved",
            },
            {
                user_id: 1,
                entry_type: "clock_out",
                timestamp: "2024-01-15T17:00:00Z",
                work_mode: "office",
                approval_status: "approved",
            },
        ];
        mockQuery.mockResolvedValueOnce({ rows: entries, rowCount: 2 });
        const res = await request(app)
            .get("/api/export/my-analytics?from=2024-01-01&to=2024-01-31")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "0");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/csv/i);
    });
    test("returns empty CSV for no data in range", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await request(app)
            .get("/api/export/my-analytics?from=2024-01-01&to=2024-01-31")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "0");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/csv/i);
    });
});
// ─── GET /api/export/my-leaves ───────────────────────────────────────────
describe("GET /api/export/my-leaves", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/export/my-leaves");
        expect(res.status).toBe(401);
    });
    test("returns CSV for personal leaves", async () => {
        setupAuth();
        const leaves = [
            {
                date: "2024-03-01",
                leave_type: "Annual",
                duration: 1,
                status: "approved",
                reason: "Vacation",
                approved_by_name: "Manager",
            },
        ];
        mockQuery.mockResolvedValueOnce({ rows: leaves, rowCount: 1 });
        const res = await request(app)
            .get("/api/export/my-leaves?year=2024")
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/csv/i);
        expect(res.text).toContain("Annual");
    });
});
// ─── GET /api/export/my-tasks ────────────────────────────────────────────
describe("GET /api/export/my-tasks", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/export/my-tasks");
        expect(res.status).toBe(401);
    });
    test("returns CSV for tasks", async () => {
        setupAuth();
        const tasks = [
            {
                date: "2024-03-01",
                title: "Fix auth bug",
                status: "done",
                priority: "high",
                due_date: null,
                assigned_to_name: null,
            },
        ];
        mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 1 });
        const res = await request(app).get("/api/export/my-tasks").set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/csv/i);
        expect(res.text).toContain("Fix auth bug");
    });
});
// ─── GET /api/export/payroll-hours ───────────────────────────────────────
describe("GET /api/export/payroll-hours", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/export/payroll-hours?from=2024-01-01&to=2024-01-31");
        expect(res.status).toBe(401);
    });
    test("returns 403 for employee role", async () => {
        setupAuth("employee");
        const res = await request(app)
            .get("/api/export/payroll-hours?from=2024-01-01&to=2024-01-31")
            .set("Cookie", authCookie());
        expect(res.status).toBe(403);
    });
    test("returns 400 when from/to params are missing", async () => {
        setupAuth("hr_admin");
        const res = await request(app).get("/api/export/payroll-hours").set("Cookie", authCookie());
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns CSV for payroll data as hr_admin", async () => {
        setupAuth("hr_admin");
        // org check
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, work_hours_per_day: 8 }], rowCount: 1 });
        // user list
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 2, full_name: "Alice", department_name: "Eng", team_name: "Dev" }],
            rowCount: 1,
        });
        // time entries for alice
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // leave days for alice
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await request(app)
            .get("/api/export/payroll-hours?from=2024-01-01&to=2024-01-31")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "0");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/csv/i);
    });
});
// ─── GET /api/export/team-analytics ──────────────────────────────────────
describe("GET /api/export/team-analytics", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/export/team-analytics?from=2024-01-01&to=2024-01-31");
        expect(res.status).toBe(401);
    });
    test("returns 403 for employee", async () => {
        setupAuth("employee");
        const res = await request(app)
            .get("/api/export/team-analytics?from=2024-01-01&to=2024-01-31")
            .set("Cookie", authCookie());
        expect(res.status).toBe(403);
    });
    test("returns 400 when from/to missing", async () => {
        setupAuth("manager");
        const res = await request(app).get("/api/export/team-analytics").set("Cookie", authCookie());
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns CSV for team analytics as manager", async () => {
        setupAuth("manager");
        // getVisibleUserIds returns [1, 2]
        mockQuery.mockResolvedValueOnce({
            rows: [
                { id: 2, full_name: "Alice", role: "employee", team_name: "Dev", department_name: "Eng" },
            ],
            rowCount: 1,
        });
        // time entries
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await request(app)
            .get("/api/export/team-analytics?from=2024-01-01&to=2024-01-31")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "0");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/csv/i);
    });
});
//# sourceMappingURL=export.routes.test.js.map