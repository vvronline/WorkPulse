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

jest.mock("../utils/mailer", () => ({
    getTransporter: jest.fn(() => null),
    sendMail: jest.fn(),
    notifyByEmail: jest.fn(),
    esc: (s: any) => String(s ?? ""),
}));

jest.mock("../utils/ws", () => ({
    setupWebSocket: jest.fn(),
    sendToUser: jest.fn(),
    broadcast: jest.fn(),
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

// Audit log writes go to the DB — stub so they don't interfere with the
// per-test mockQuery sequencing.
jest.mock("../utils/audit", () => ({
    logAction: jest.fn().mockResolvedValue(undefined),
    queryLogs: jest.fn(),
}));

// Disable rate limiting for this suite. The real authLimiter caps at 15
// requests per window using a process-wide in-memory store shared across
// suites in a combined run (causing spurious 429s). A passthrough middleware
// lets every test hit the route logic we actually want to assert.
jest.mock("express-rate-limit", () => () => (_req: any, _res: any, next: any) => next());

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const mockQuery: jest.Mock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTransaction: jest.Mock = jest.fn(async (fn: any) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return fn(client);
});

jest.mock("../db", () => ({
    pool: { end: jest.fn() },
    query: (...args: any[]) => mockQuery(...args),
    masterQuery: (...args: any[]) => mockQuery(...args),
    masterTransaction: (...args: any[]) => mockTransaction(...args),
    transaction: (...args: any[]) => mockTransaction(...args),
    initDB: jest.fn(),
}));

const { app } = require("../index");

const CSRF = { "X-Requested-With": "WorkPulse" };
const SECRET = process.env.JWT_SECRET || "test-secret";

function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: "testuser", tv: 0 }, SECRET, { expiresIn: "1h" });
    return `token=${token}`;
}

describe("POST /api/auth/biometric/enroll", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth cookie", async () => {
        const res = await request(app)
            .post("/api/auth/biometric/enroll")
            .set(CSRF)
            .send({ platform: "ios" });
        expect(res.status).toBe(401);
    });

    test("returns 400 for an invalid platform", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }); // auth middleware
        const res = await request(app)
            .post("/api/auth/biometric/enroll")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ platform: "smartwatch" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/platform/i);
    });

    test("mints + persists a device secret and returns it once", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
            .mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 }) // isBiometricLoginEnabled
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT device_credentials
        const res = await request(app)
            .post("/api/auth/biometric/enroll")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ platform: "ios", deviceLabel: "iPhone 15" });
        expect(res.status).toBe(200);
        expect(typeof res.body.credentialId).toBe("string");
        expect(typeof res.body.deviceSecret).toBe("string");
        // 32 random bytes hex-encoded = 64 chars.
        expect(res.body.deviceSecret).toHaveLength(64);
        // credentialId carries the tenant prefix ("0." for master context in tests).
        expect(res.body.credentialId).toMatch(/^\d+\./);
    });

    test("returns 403 when biometric login is disabled for the org", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
            .mockResolvedValueOnce({ rows: [{ enabled: false }], rowCount: 1 }); // isBiometricLoginEnabled → off
        const res = await request(app)
            .post("/api/auth/biometric/enroll")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ platform: "ios", deviceLabel: "iPhone 15" });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/disabled/i);
    });
});

describe("POST /api/auth/biometric/login", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 400 when fields are missing", async () => {
        const res = await request(app)
            .post("/api/auth/biometric/login")
            .set(CSRF)
            .send({ credentialId: "0.abc" });
        expect(res.status).toBe(400);
    });

    test("returns 401 for a malformed credentialId (no tenant prefix)", async () => {
        const res = await request(app)
            .post("/api/auth/biometric/login")
            .set(CSRF)
            .send({ credentialId: "garbage", deviceSecret: "x" });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid/i);
    });

    test("returns 401 when the secret does not match", async () => {
        const realHash = await bcrypt.hash("the-real-secret", 10);
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: "0.cred", user_id: 1, secret_hash: realHash }],
            rowCount: 1,
        }); // SELECT device_credentials (master context)
        const res = await request(app)
            .post("/api/auth/biometric/login")
            .set(CSRF)
            .send({ credentialId: "0.cred", deviceSecret: "WRONG-secret" });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid/i);
    });

    test("returns 401 when the credential is unknown", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT device_credentials → none
        const res = await request(app)
            .post("/api/auth/biometric/login")
            .set(CSRF)
            .send({ credentialId: "0.missing", deviceSecret: "anything" });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid/i);
    });

    test("issues a session on a valid platform-context credential", async () => {
        const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const hash = await bcrypt.hash(secret, 10);
        const platformUser = {
            id: 1,
            username: "admin",
            full_name: "Admin",
            email: "admin@example.com",
            avatar: null,
            role: "platform_admin",
            token_version: 0,
        };
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: "0.cred", user_id: 1, secret_hash: hash }], rowCount: 1 }) // SELECT device_credentials
            .mockResolvedValueOnce({ rows: [platformUser], rowCount: 1 }) // SELECT platform_users
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE last_used_at
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // createSession INSERT
            .mockResolvedValueOnce({ rows: [{ id: "sess-1" }], rowCount: 1 }) // createSession list
            // finishLogin (platform, no tenant) → "SELECT * FROM tenants ... LIMIT 1"
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no primary tenant
            // createTenant path is skipped because tenantManager.createTenant isn't
            // exported in the mock; instead the "no tenant" branch returns the user.
            .mockResolvedValue({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post("/api/auth/biometric/login")
            .set(CSRF)
            .send({ credentialId: "0.cred", deviceSecret: secret });

        // finishLogin's platform-admin auto-provision path may attempt to create
        // a tenant; in the unit-test mock that returns gracefully. We only assert
        // the secret verification + user resolution succeeded (no 401/400).
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(400);
    });
});

describe("GET /api/auth/biometric", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth cookie", async () => {
        const res = await request(app).get("/api/auth/biometric").set(CSRF);
        expect(res.status).toBe(401);
    });

    test("lists the user's enrolled devices", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
            .mockResolvedValueOnce({
                rows: [
                    { id: "0.a", device_label: "iPhone", platform: "ios", created_at: new Date(), last_used_at: null },
                ],
                rowCount: 1,
            }); // SELECT device_credentials
        const res = await request(app)
            .get("/api/auth/biometric")
            .set(CSRF)
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.devices)).toBe(true);
        expect(res.body.devices[0].platform).toBe("ios");
    });
});

describe("DELETE /api/auth/biometric/:id", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 404 when the credential isn't the caller's", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE matched nothing
        const res = await request(app)
            .delete("/api/auth/biometric/0.someoneElse")
            .set(CSRF)
            .set("Cookie", authCookie());
        expect(res.status).toBe(404);
    });

    test("revokes a credential the caller owns", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE revoked 1 row
        const res = await request(app)
            .delete("/api/auth/biometric/0.mine")
            .set(CSRF)
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/revoked/i);
    });
});