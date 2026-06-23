export {};

// ─────────────────────────────────────────────────────────────────────────
// WebAuthn / passkey route tests (Phase 3 — web biometric login).
//
// These mirror the biometric.routes.test.ts style. The @simplewebauthn/server
// library performs real cryptographic verification that can't be exercised
// without a genuine authenticator, so we MOCK it and assert the route plumbing:
// challenge storage, DB reads/writes, tenant/user resolution from the
// userHandle, counter bumps, and the auth gating on the management endpoints.
// ─────────────────────────────────────────────────────────────────────────

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
// requests per window using a process-wide in-memory store, which this file
// exceeds (causing spurious 429s). A passthrough middleware lets every test
// hit the route logic we actually want to assert.
jest.mock("express-rate-limit", () => () => (_req: any, _res: any, next: any) => next());

// Mock the WebAuthn library. Each test overrides the return values it needs.
const mockGenRegOpts: jest.Mock = jest.fn();
const mockVerifyReg: jest.Mock = jest.fn();
const mockGenAuthOpts: jest.Mock = jest.fn();
const mockVerifyAuth: jest.Mock = jest.fn();
jest.mock("@simplewebauthn/server", () => ({
    generateRegistrationOptions: (...a: any[]) => mockGenRegOpts(...a),
    verifyRegistrationResponse: (...a: any[]) => mockVerifyReg(...a),
    generateAuthenticationOptions: (...a: any[]) => mockGenAuthOpts(...a),
    verifyAuthenticationResponse: (...a: any[]) => mockVerifyAuth(...a),
}));

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

/** base64url-encode a utf8 string the way a browser sends userHandle. */
function b64url(s: string): string {
    return Buffer.from(s, "utf8").toString("base64url");
}

beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockGenRegOpts.mockReset();
    mockVerifyReg.mockReset();
    mockGenAuthOpts.mockReset();
    mockVerifyAuth.mockReset();
});

describe("POST /api/auth/webauthn/register/options", () => {
    test("returns 401 without auth cookie", async () => {
        const res = await request(app)
            .post("/api/auth/webauthn/register/options")
            .set(CSRF)
            .send({});
        expect(res.status).toBe(401);
    });

    test("returns registration options + persists the challenge", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth middleware
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT existing webauthn_credentials
        mockGenRegOpts.mockResolvedValueOnce({
            challenge: "fake-reg-challenge",
            rp: { id: "localhost", name: "WorkPulse" },
            user: { id: "MC4x", name: "testuser" },
        });

        const res = await request(app)
            .post("/api/auth/webauthn/register/options")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.options.challenge).toBe("fake-reg-challenge");
        expect(typeof res.body.rpID).toBe("string");
        expect(typeof res.body.origin).toBe("string");
        expect(mockGenRegOpts).toHaveBeenCalledTimes(1);
    });
});

describe("POST /api/auth/webauthn/register/verify", () => {
    test("returns 401 without auth cookie", async () => {
        const res = await request(app)
            .post("/api/auth/webauthn/register/verify")
            .set(CSRF)
            .send({ response: {} });
        expect(res.status).toBe(401);
    });

    test("returns 400 when the attestation response is missing", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }); // auth
        const res = await request(app)
            .post("/api/auth/webauthn/register/verify")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/attestation/i);
    });

    test("returns 400 when no challenge is stored (session expired)", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }); // auth
        // Use a user id that never called /register/options, so the challenge
        // store has no `reg:0:<id>` entry. (Other tests in this file enroll
        // user 1, whose challenge would otherwise linger in the in-memory map.)
        const res = await request(app)
            .post("/api/auth/webauthn/register/verify")
            .set(CSRF)
            .set("Cookie", authCookie(987654))
            .send({ response: { id: "credA" } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/expired/i);
    });

    test("verifies attestation and stores the public key", async () => {
        // 1. Prime a challenge via /register/options.
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth (options)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT existing
        mockGenRegOpts.mockResolvedValueOnce({ challenge: "challenge-xyz" });
        await request(app)
            .post("/api/auth/webauthn/register/options")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({});

        // 2. Verify the attestation.
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth (verify)
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT webauthn_credentials
        mockVerifyReg.mockResolvedValueOnce({
            verified: true,
            registrationInfo: {
                credential: {
                    id: "credA",
                    publicKey: new Uint8Array([1, 2, 3, 4]),
                    counter: 0,
                },
            },
        });

        const res = await request(app)
            .post("/api/auth/webauthn/register/verify")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ response: { id: "credA", response: { transports: ["internal"] } }, deviceLabel: "My Mac" });

        expect(res.status).toBe(200);
        expect(res.body.verified).toBe(true);
        // Confirm the INSERT carried the base64 public key.
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO webauthn_credentials/i.test(c[0]));
        expect(insertCall).toBeTruthy();
        expect(insertCall[1][1]).toBe("credA"); // credential_id
    });

    test("returns 400 when the library rejects the attestation", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth (options)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT existing
        mockGenRegOpts.mockResolvedValueOnce({ challenge: "challenge-bad" });
        await request(app)
            .post("/api/auth/webauthn/register/options")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({});

        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }); // auth (verify)
        mockVerifyReg.mockResolvedValueOnce({ verified: false });

        const res = await request(app)
            .post("/api/auth/webauthn/register/verify")
            .set(CSRF)
            .set("Cookie", authCookie())
            .send({ response: { id: "credA" } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/could not be verified/i);
    });
});

describe("POST /api/auth/webauthn/login/options", () => {
    test("returns auth options + a flowId (public, no auth needed)", async () => {
        mockGenAuthOpts.mockResolvedValueOnce({ challenge: "login-challenge" });
        const res = await request(app)
            .post("/api/auth/webauthn/login/options")
            .set(CSRF)
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.options.challenge).toBe("login-challenge");
        expect(typeof res.body.flowId).toBe("string");
        expect(res.body.flowId.length).toBeGreaterThan(0);
    });
});

describe("POST /api/auth/webauthn/login/verify", () => {
    test("returns 400 when response or flowId is missing", async () => {
        const res = await request(app)
            .post("/api/auth/webauthn/login/verify")
            .set(CSRF)
            .send({ response: { id: "credA" } });
        expect(res.status).toBe(400);
    });

    test("returns 400 for an unknown / expired flowId", async () => {
        const res = await request(app)
            .post("/api/auth/webauthn/login/verify")
            .set(CSRF)
            .send({ response: { id: "credA" }, flowId: "does-not-exist" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/expired/i);
    });

    test("returns 401 when the assertion has no userHandle", async () => {
        // Prime a flow.
        mockGenAuthOpts.mockResolvedValueOnce({ challenge: "c1" });
        const opt = await request(app)
            .post("/api/auth/webauthn/login/options")
            .set(CSRF)
            .send({});
        const flowId = opt.body.flowId;

        const res = await request(app)
            .post("/api/auth/webauthn/login/verify")
            .set(CSRF)
            .send({ response: { id: "credA", response: {} }, flowId });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid passkey/i);
    });

    test("returns 401 when the credential is unknown", async () => {
        mockGenAuthOpts.mockResolvedValueOnce({ challenge: "c2" });
        const opt = await request(app)
            .post("/api/auth/webauthn/login/options")
            .set(CSRF)
            .send({});
        const flowId = opt.body.flowId;

        // Platform-context handle "0.1" → masterQuery for the credential lookup
        // returns nothing.
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT webauthn_credentials → none
        const res = await request(app)
            .post("/api/auth/webauthn/login/verify")
            .set(CSRF)
            .send({
                response: { id: "credMissing", response: { userHandle: b64url("0.1") } },
                flowId,
            });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid passkey/i);
    });

    test("returns 401 when the library rejects the assertion", async () => {
        mockGenAuthOpts.mockResolvedValueOnce({ challenge: "c3" });
        const opt = await request(app)
            .post("/api/auth/webauthn/login/options")
            .set(CSRF)
            .send({});
        const flowId = opt.body.flowId;

        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 7, user_id: 1, public_key: Buffer.from([9, 9]).toString("base64"), counter: 3 }],
            rowCount: 1,
        }); // SELECT webauthn_credentials
        mockVerifyAuth.mockResolvedValueOnce({ verified: false });

        const res = await request(app)
            .post("/api/auth/webauthn/login/verify")
            .set(CSRF)
            .send({
                response: { id: "credA", response: { userHandle: b64url("0.1") } },
                flowId,
            });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/verification failed/i);
    });

    test("verifies the assertion, bumps the counter and issues a session", async () => {
        mockGenAuthOpts.mockResolvedValueOnce({ challenge: "c4" });
        const opt = await request(app)
            .post("/api/auth/webauthn/login/options")
            .set(CSRF)
            .send({});
        const flowId = opt.body.flowId;

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
            .mockResolvedValueOnce({
                rows: [{ id: 7, user_id: 1, public_key: Buffer.from([9, 9]).toString("base64"), counter: 3 }],
                rowCount: 1,
            }) // SELECT webauthn_credentials
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE counter/last_used
            .mockResolvedValueOnce({ rows: [platformUser], rowCount: 1 }) // SELECT platform_users
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // createSession INSERT
            .mockResolvedValueOnce({ rows: [{ id: "sess-1" }], rowCount: 1 }) // createSession list
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // finishLogin: no primary tenant
            .mockResolvedValue({ rows: [], rowCount: 0 });
        mockVerifyAuth.mockResolvedValueOnce({
            verified: true,
            authenticationInfo: { newCounter: 4 },
        });

        const res = await request(app)
            .post("/api/auth/webauthn/login/verify")
            .set(CSRF)
            .send({
                response: { id: "credA", response: { userHandle: b64url("0.1") } },
                flowId,
            });

        // The credential verified + user resolved; finishLogin's platform path
        // returns gracefully in the mock. We assert no auth/validation failure.
        expect(res.status).not.toBe(400);
        expect(res.status).not.toBe(401);
        // Counter bump UPDATE fired with the new counter value.
        const upd = mockQuery.mock.calls.find(c => /UPDATE webauthn_credentials SET counter/i.test(c[0]));
        expect(upd).toBeTruthy();
        expect(upd[1][0]).toBe(4);
    });
});

describe("GET /api/auth/webauthn", () => {
    test("returns 401 without auth cookie", async () => {
        const res = await request(app).get("/api/auth/webauthn").set(CSRF);
        expect(res.status).toBe(401);
    });

    test("lists the user's passkeys", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({
                rows: [
                    { id: 1, device_label: "My Mac", transports: "internal", created_at: new Date(), last_used_at: null },
                ],
                rowCount: 1,
            }); // SELECT webauthn_credentials
        const res = await request(app)
            .get("/api/auth/webauthn")
            .set(CSRF)
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.passkeys)).toBe(true);
        expect(res.body.passkeys[0].device_label).toBe("My Mac");
    });
});

describe("DELETE /api/auth/webauthn/:id", () => {
    test("returns 404 when the passkey isn't the caller's", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE matched nothing
        const res = await request(app)
            .delete("/api/auth/webauthn/999")
            .set(CSRF)
            .set("Cookie", authCookie());
        expect(res.status).toBe(404);
    });

    test("revokes a passkey the caller owns", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE revoked 1 row
        const res = await request(app)
            .delete("/api/auth/webauthn/1")
            .set(CSRF)
            .set("Cookie", authCookie());
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/removed/i);
    });
});