"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
jest.mock("../utils/platformConfig", () => ({
    getPasswordPolicy: jest.fn().mockResolvedValue({
        minLength: 8,
        requireUppercase: true,
        requireNumber: true,
        requireSpecial: true,
    }),
    isMaintenanceMode: jest.fn().mockResolvedValue(false),
    getMaintenanceMessage: jest.fn().mockResolvedValue(""),
    getAllowedEmailDomains: jest.fn().mockResolvedValue([]),
    getPlatformConfig: jest.fn().mockResolvedValue({}),
    getSessionTimeout: jest.fn().mockResolvedValue(480),
    getRetentionPolicy: jest.fn().mockResolvedValue({
        auditLogRetentionDays: 365,
        deletedTenantCleanupDays: 90,
        sessionLogRetentionDays: 90,
    }),
    updatePlatformConfig: jest.fn().mockResolvedValue({}),
    PLATFORM_KEYS: [],
    DEFAULTS: {},
}));
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTransaction = jest.fn(async (fn) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return fn(client);
});
jest.mock("../db", () => ({
    pool: { end: jest.fn() },
    query: (...args) => mockQuery(...args),
    masterQuery: (...args) => mockQuery(...args),
    masterTransaction: (...args) => mockTransaction(...args),
    transaction: (...args) => mockTransaction(...args),
    initDB: jest.fn(),
}));
const { app } = require("../index");
const SECRET = process.env.JWT_SECRET || "test-secret";
const CSRF = { "X-Requested-With": "WorkPulse" };
function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: "testuser", tv: 0 }, SECRET, { expiresIn: "1h" });
    return `token=${token}`;
}
function setupAuth(role = "hr_admin", extra = {}) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
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
    }); // loadUserContext
}
// ─── PUT /api/admin/users/:id/assignment ──────────────────────────────────────
describe("PUT /api/admin/users/:id/assignment — circular manager detection", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 400 when assigning a user as their own manager", async () => {
        setupAuth("hr_admin");
        // target user lookup
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, org_id: 1, full_name: "User Ten" }], rowCount: 1 });
        // manager lookup
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 });
        const res = await request(app)
            .put("/api/admin/users/10/assignment")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ manager_id: 10 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/own manager/i);
    });
    test("returns 400 when assignment creates a circular chain (A->B->A)", async () => {
        setupAuth("hr_admin");
        // target user (id=10) lookup
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, org_id: 1, full_name: "User Ten" }], rowCount: 1 });
        // manager (id=20) exists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 20 }], rowCount: 1 });
        // walk up: manager 20's manager is 10 → circular!
        mockQuery.mockResolvedValueOnce({ rows: [{ manager_id: 10 }], rowCount: 1 });
        const res = await request(app)
            .put("/api/admin/users/10/assignment")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ manager_id: 20 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/circular/i);
    });
    test("returns 400 for deeper circular chain (A->B->C->A)", async () => {
        setupAuth("hr_admin");
        // target user (id=10)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, org_id: 1, full_name: "User Ten" }], rowCount: 1 });
        // manager (id=20) exists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 20 }], rowCount: 1 });
        // walk up: 20's manager is 30
        mockQuery.mockResolvedValueOnce({ rows: [{ manager_id: 30 }], rowCount: 1 });
        // walk up: 30's manager is 10 → circular!
        mockQuery.mockResolvedValueOnce({ rows: [{ manager_id: 10 }], rowCount: 1 });
        const res = await request(app)
            .put("/api/admin/users/10/assignment")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ manager_id: 20 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/circular/i);
    });
    test("allows valid manager assignment (no circular chain)", async () => {
        setupAuth("hr_admin");
        // target user (id=10)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, org_id: 1, full_name: "User Ten" }], rowCount: 1 });
        // manager (id=20) exists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 20 }], rowCount: 1 });
        // walk up: 20's manager is 30 (not 10, no cycle)
        mockQuery.mockResolvedValueOnce({ rows: [{ manager_id: 30 }], rowCount: 1 });
        // walk up: 30 has no manager → chain ends
        mockQuery.mockResolvedValueOnce({ rows: [{ manager_id: null }], rowCount: 1 });
        // UPDATE query
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const res = await request(app)
            .put("/api/admin/users/10/assignment")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ manager_id: 20 });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/assignment updated/i);
    });
    test("returns 404 when target user not found", async () => {
        setupAuth("hr_admin");
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await request(app)
            .put("/api/admin/users/999/assignment")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ manager_id: 20 });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
    test("returns 400 when manager not found", async () => {
        setupAuth("hr_admin");
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, org_id: 1, full_name: "User Ten" }], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // manager doesn't exist
        const res = await request(app)
            .put("/api/admin/users/10/assignment")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ manager_id: 999 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/manager not found/i);
    });
});
//# sourceMappingURL=admin.routes.test.js.map