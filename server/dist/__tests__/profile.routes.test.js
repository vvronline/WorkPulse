"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Tests for /api/profile — GET, PUT, PUT /password, PUT /email
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
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
        minLength: 8, requireUppercase: true, requireNumber: true, requireSpecial: true,
    }),
    isMaintenanceMode: jest.fn().mockResolvedValue(false),
    getMaintenanceMessage: jest.fn().mockResolvedValue(""),
    getAllowedEmailDomains: jest.fn().mockResolvedValue([]),
    getPlatformConfig: jest.fn().mockResolvedValue({}),
    getSessionTimeout: jest.fn().mockResolvedValue(480),
    getRetentionPolicy: jest.fn().mockResolvedValue({ auditLogRetentionDays: 365, deletedTenantCleanupDays: 90, sessionLogRetentionDays: 90 }),
    updatePlatformConfig: jest.fn().mockResolvedValue({}),
    PLATFORM_KEYS: [],
    DEFAULTS: {},
}));
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTxClient = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
const mockTransaction = jest.fn(async (fn) => fn(mockTxClient));
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
// profile.js GET/PUT/email use only `auth` (token_version check)
// profile.js PUT /password also uses loadUserContext
function setupAuth(role = "employee", extra = {}) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ role, org_id: 1, team_id: 1, department_id: 1, manager_id: null, is_active: true, ...extra }], rowCount: 1 });
}
function setupAuthOnly() {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
}
// ─── GET /api/profile ──────────────────────────────────────────────────────
describe("GET /api/profile", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/profile");
        expect(res.status).toBe(401);
    });
    test("returns 404 when user not found in DB", async () => {
        setupAuthOnly();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // user query returns nothing
        const res = await request(app)
            .get("/api/profile")
            .set("Cookie", authCookie());
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
    test("returns user profile with has_reports flag", async () => {
        setupAuthOnly();
        const userRow = {
            id: 1, username: "testuser", full_name: "Test User", email: "test@test.com",
            avatar: null, role: "employee", org_id: 1, team_id: 1, department_id: 1,
            must_change_password: false, team_name: "Dev",
        };
        mockQuery.mockResolvedValueOnce({ rows: [userRow], rowCount: 1 }); // user with JOIN
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no reports
        const res = await request(app)
            .get("/api/profile")
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(res.body.username).toBe("testuser");
        expect(res.body.has_reports).toBe(false);
        expect(res.body.must_change_password).toBe(false);
    });
    test("sets has_reports true when user has direct reports", async () => {
        setupAuthOnly();
        const userRow = { id: 1, username: "mgr", full_name: "Manager", email: "m@test.com", avatar: null, role: "manager", org_id: 1, team_id: 1, department_id: 1, must_change_password: false, team_name: "Dev" };
        mockQuery.mockResolvedValueOnce({ rows: [userRow], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }); // has reports
        const res = await request(app)
            .get("/api/profile")
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(res.body.has_reports).toBe(true);
    });
});
// ─── PUT /api/profile ──────────────────────────────────────────────────────
describe("PUT /api/profile", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app)
            .put("/api/profile")
            .set(CSRF)
            .send({ full_name: "Test", username: "test" });
        expect(res.status).toBe(401);
    });
    test("returns 400 when full_name is missing", async () => {
        setupAuthOnly();
        const res = await request(app)
            .put("/api/profile")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ username: "testuser" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns 400 when username is missing", async () => {
        setupAuthOnly();
        const res = await request(app)
            .put("/api/profile")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ full_name: "Test User" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns 400 when username is already taken", async () => {
        setupAuthOnly();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }); // username conflict
        const res = await request(app)
            .put("/api/profile")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ full_name: "Test User", username: "existinguser" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already taken/i);
    });
    test("updates profile successfully", async () => {
        setupAuthOnly();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no username conflict
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE
        const updatedUser = { id: 1, username: "newname", full_name: "New Name", email: "test@test.com", avatar: null };
        mockQuery.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 }); // SELECT after update
        const res = await request(app)
            .put("/api/profile")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ full_name: "New Name", username: "newname" });
        expect(res.status).toBe(200);
        expect(res.body.username).toBe("newname");
    });
});
// ─── PUT /api/profile/email ────────────────────────────────────────────────
describe("PUT /api/profile/email", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 400 when email is missing", async () => {
        setupAuthOnly();
        const res = await request(app)
            .put("/api/profile/email")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns 400 for invalid email format", async () => {
        setupAuthOnly();
        const res = await request(app)
            .put("/api/profile/email")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ email: "not-an-email" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid email/i);
    });
    test("returns 400 when email is already in use by another user", async () => {
        setupAuthOnly();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }); // conflict
        const res = await request(app)
            .put("/api/profile/email")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ email: "taken@test.com" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already in use/i);
    });
    test("updates email successfully", async () => {
        setupAuthOnly();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no conflict
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE
        const res = await request(app)
            .put("/api/profile/email")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ email: "new@test.com" });
        expect(res.status).toBe(200);
        expect(res.body.email).toBe("new@test.com");
    });
});
// ─── PUT /api/profile/password ────────────────────────────────────────────
describe("PUT /api/profile/password", () => {
    const bcrypt = require("bcryptjs");
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app)
            .put("/api/profile/password")
            .set(CSRF)
            .send({ current_password: "old", new_password: "NewPass1!" });
        expect(res.status).toBe(401);
    });
    test("returns 400 when passwords are missing", async () => {
        setupAuth();
        const res = await request(app)
            .put("/api/profile/password")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ current_password: "old" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });
    test("returns 400 when new password is too short", async () => {
        setupAuth();
        const res = await request(app)
            .put("/api/profile/password")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ current_password: "OldPass1!", new_password: "short" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at least 8/i);
    });
    test("returns 400 when current password is incorrect", async () => {
        setupAuth();
        const hash = await bcrypt.hash("correct-password", 10);
        mockQuery.mockResolvedValueOnce({ rows: [{ password: hash }], rowCount: 1 });
        const res = await request(app)
            .put("/api/profile/password")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ current_password: "wrong-password", new_password: "NewPass123!" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/incorrect/i);
    });
    test("changes password successfully with valid credentials", async () => {
        setupAuth();
        const hash = await bcrypt.hash("OldPass1!", 10);
        mockQuery.mockResolvedValueOnce({ rows: [{ password: hash }], rowCount: 1 }); // fetch pw
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE other sessions
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }], rowCount: 1 }); // fetch new token_version
        const res = await request(app)
            .put("/api/profile/password")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ current_password: "OldPass1!", new_password: "NewPass123!" });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/updated/i);
    });
});
//# sourceMappingURL=profile.routes.test.js.map