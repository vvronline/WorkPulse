"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Suppress pino logs during tests
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req, _res, next) => { req.id = "test"; req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; next(); },
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
function setupAuthAndRbac(role = "employee", orgId = 1) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
        .mockResolvedValueOnce({
        rows: [{
                role, org_id: orgId, team_id: 1, department_id: 1,
                manager_id: null, is_active: true,
            }],
        rowCount: 1,
    }); // loadUserContext
}
describe("POST /api/leaves", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).post("/api/leaves").set(CSRF);
        expect(res.status).toBe(401);
    });
    test("returns 400 when required fields are missing", async () => {
        setupAuthAndRbac();
        const res = await request(app)
            .post("/api/leaves")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({});
        expect(res.status).toBe(400);
    });
});
describe("GET /api/leaves", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/leaves");
        expect(res.status).toBe(401);
    });
    test("returns empty array for user with no leaves", async () => {
        setupAuthAndRbac();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // leave query
        const res = await request(app)
            .get("/api/leaves")
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBe(0);
    });
});
describe("GET /api/leaves/balance", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });
    test("returns balance data", async () => {
        setupAuthAndRbac();
        // initializeBalances and balance query
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // balances query (initializeBalances check)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // final balance
        const res = await request(app)
            .get("/api/leaves/balance")
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
    });
});
//# sourceMappingURL=leaves.routes.test.js.map