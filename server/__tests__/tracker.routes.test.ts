export {};

// Suppress pino logs during tests
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req: any, _res: any, next: any) => { req.id = "test"; req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; next(); },
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

jest.mock("../utils/audit", () => ({
    logAction: jest.fn(),
    queryLogs: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
}));

// Force loadUserContext down its deterministic DB path: with the user-context
// cache always missing, every request runs the same `SELECT ... is_active FROM
// users` lookup, so the per-test mockQuery chains stay stable (otherwise the
// first test would warm the cache and later tests would skip the user lookup,
// shifting their mock sequence).
jest.mock("../redis", () => {
    const actual = jest.requireActual("../redis");
    return {
        ...actual,
        getUserContext: jest.fn().mockResolvedValue(null),
        setUserContext: jest.fn().mockResolvedValue(undefined),
    };
});

const jwt = require("jsonwebtoken");
const request = require("supertest");

const mockQuery: jest.Mock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTxClient = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
const mockTransaction: jest.Mock = jest.fn(async (fn: any) => fn(mockTxClient));

jest.mock("../db", () => ({
    pool: { end: jest.fn() },
    query: (...args: any[]) => mockQuery(...args),

    masterQuery: (...args: any[]) => mockQuery(...args),

    masterTransaction: (...args: any[]) => mockTransaction(...args),
    transaction: (...args: any[]) => mockTransaction(...args),
    initDB: jest.fn(),
}));

const { app } = require("../index");

const SECRET = process.env.JWT_SECRET || "test-secret";
const CSRF = { "X-Requested-With": "WorkPulse" };

function authCookie(userId = 1, username = "testuser") {
    const token = jwt.sign({ id: userId, username, tv: 0 }, SECRET, { expiresIn: "1h" });
    return `token=${token}`;
}

// The auth middleware checks token_version in DB, loadUserContext loads role
function setupAuthMocks(overrides: Record<string, any> = {}) {
    const defaults = {
        id: 1, username: "testuser", role: "employee", org_id: null,
        team_id: null, department_id: null, manager_id: null, is_active: true,
        token_version: 0,
    };
    const user = { ...defaults, ...overrides };

    mockQuery
        // auth middleware: SELECT token_version
        .mockResolvedValueOnce({ rows: [{ token_version: user.token_version }], rowCount: 1 })
        // loadUserContext: SELECT role, org_id...
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 });
}

describe("GET /api/tracker/status", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/tracker/status");
        expect(res.status).toBe(401);
    });

    test("returns logged_out state when no entries", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })                      // org join (no org)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });                     // time_entries

        const res = await request(app)
            .get("/api/tracker/status")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.state).toBe("logged_out");
    });

    test("returns on_floor state after clock_in", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })                      // org join (no org)
            .mockResolvedValueOnce({
                rows: [{ entry_type: "clock_in", timestamp: new Date().toISOString(), work_mode: "office" }],
                rowCount: 1,
            });                                                                    // time_entries

        const res = await request(app)
            .get("/api/tracker/status")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.state).toBe("on_floor");
    });

    test("returns targetMinutes and dailyTargetMet in response", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })      // auth
            .mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 })              // user org_id lookup
            .mockResolvedValueOnce({ rows: [{ work_hours_per_day: 9, work_days: "1,2,3,4,5" }], rowCount: 1 }) // org config
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });                         // time_entries

        const res = await request(app)
            .get("/api/tracker/status")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.targetMinutes).toBe(540);
        expect(res.body.dailyTargetMet).toBe(false);
        expect(res.body.autoLoggedOut).toBe(false);
    });

    test("auto clocks out when daily target is met", async () => {
        const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
        const nowTs = new Date().toISOString();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })      // auth
            .mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 })              // user org_id lookup
            .mockResolvedValueOnce({ rows: [{ work_hours_per_day: 8, work_days: "1,2,3,4,5" }], rowCount: 1 }) // org config
            .mockResolvedValueOnce({
                rows: [{ entry_type: "clock_in", timestamp: nineHoursAgo, work_mode: "office" }],
                rowCount: 1,
            })                                                                          // time_entries: 9hr session active
            .mockResolvedValueOnce({
                rows: [
                    { entry_type: "clock_in", timestamp: nineHoursAgo, work_mode: "office" },
                    { entry_type: "clock_out", timestamp: nowTs },
                ],
                rowCount: 2,
            });                                                                        // refreshed entries after auto-clock-out

        // Auto-clock-out now runs inside a transaction
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 }) // SELECT FOR UPDATE latest entry
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });                          // INSERT clock_out

        const res = await request(app)
            .get("/api/tracker/status")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.state).toBe("logged_out");
        expect(res.body.autoLoggedOut).toBe(true);
        expect(res.body.dailyTargetMet).toBe(true);
    });
});

describe("POST /api/tracker/clock-in", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    test("returns 401 without auth", async () => {
        const res = await request(app)
            .post("/api/tracker/clock-in")
            .set(CSRF);
        expect(res.status).toBe(401);
    });

    test("succeeds when not clocked in", async () => {
        setupAuthMocks({ org_id: 1 });
        // org work_days query â€” include all days so test passes regardless of day-of-week
        mockQuery.mockResolvedValueOnce({ rows: [{ work_days: "0,1,2,3,4,5,6" }], rowCount: 1 });

        // transaction: last entry = clock_out (or empty) â†’ allow
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no last entry
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT

        // update timezone
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post("/api/tracker/clock-in")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ work_mode: "office" });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged in/i);
    });

    test("returns 400 when already clocked in", async () => {
        setupAuthMocks({ org_id: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [{ work_days: "0,1,2,3,4,5,6" }], rowCount: 1 }); // org work_days

        mockTransaction.mockReset().mockImplementation(async () => ({ error: "Already logged in. Logout first." }));

        const res = await request(app)
            .post("/api/tracker/clock-in")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ work_mode: "office" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already/i);
    });

    test("returns 403 when daily target met and no approved overtime", async () => {
        setupAuthMocks({ org_id: 1 });
        const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
        const nowTs = new Date().toISOString();

        mockQuery
            .mockResolvedValueOnce({ rows: [{ work_days: "0,1,2,3,4,5,6" }], rowCount: 1 }) // work_days
            .mockResolvedValueOnce({ rows: [{ work_hours_per_day: 8 }], rowCount: 1 })       // work_hours_per_day
            .mockResolvedValueOnce({                                                          // today entries: met target
                rows: [
                    { entry_type: "clock_in", timestamp: nineHoursAgo, work_mode: "office" },
                    { entry_type: "clock_out", timestamp: nowTs },
                ],
                rowCount: 2,
            })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });                               // no approved OT found

        const res = await request(app)
            .post("/api/tracker/clock-in")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ work_mode: "office" });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("DAILY_TARGET_MET");
        expect(res.body.error).toMatch(/daily target/i);
    });

    test("allows login when daily target met and approved overtime exists", async () => {
        setupAuthMocks({ org_id: 1 });
        const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
        const nowTs = new Date().toISOString();

        mockQuery
            .mockResolvedValueOnce({ rows: [{ work_days: "0,1,2,3,4,5,6" }], rowCount: 1 }) // work_days
            .mockResolvedValueOnce({ rows: [{ work_hours_per_day: 8 }], rowCount: 1 })       // work_hours_per_day
            .mockResolvedValueOnce({                                                          // today entries: met target
                rows: [
                    { entry_type: "clock_in", timestamp: nineHoursAgo, work_mode: "office" },
                    { entry_type: "clock_out", timestamp: nowTs },
                ],
                rowCount: 2,
            })
            .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });                    // approved OT exists

        // transaction: last entry = clock_out â†’ allow login
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "clock_out" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT clock_in

        const res = await request(app)
            .post("/api/tracker/clock-in")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ work_mode: "office" });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged in/i);
    });
});

describe("POST /api/tracker/clock-out", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    test("succeeds when clocked in (last entry is clock_in)", async () => {
        // auth + loadUserContext (org_id null -> office-verify block skipped)
        setupAuthMocks();

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 }) // last entry
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT clock_out

        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged out/i);
    });

    test("returns 400 when not clocked in", async () => {
        setupAuthMocks();

        mockTransaction.mockReset().mockImplementation(async () => ({ error: "You are not logged in" }));

        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not logged in/i);
    });

    test("returns 400 when still on break", async () => {
        setupAuthMocks();

        mockTransaction.mockReset().mockImplementation(async () => ({ error: "You are still on break. End your break before clocking out." }));

        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/break/i);
    });

    test("rejects office clock-out when outside the geofence", async () => {
        setupAuthMocks({ org_id: 1 });
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    attendance_verification_enabled: true,
                    office_latitude: 10, office_longitude: 20, office_radius_m: 150,
                    office_wifi_bssids: [], office_wifi_verification_enabled: false,
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ work_mode: "office" }], rowCount: 1 });

        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ latitude: 20, longitude: 20, accuracy: 10 });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("OUTSIDE_GEOFENCE");
    });

    test("allows office clock-out when inside the geofence (fingerprint fallback)", async () => {
        setupAuthMocks({ org_id: 1 });
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    attendance_verification_enabled: true,
                    office_latitude: 10, office_longitude: 20, office_radius_m: 150,
                    office_wifi_bssids: [], office_wifi_verification_enabled: false,
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ work_mode: "office" }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ latitude: 10, longitude: 20, accuracy: 10, fingerprint_verified: true });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged out/i);
    });

    test("office clock-out inside the geofence still requires identity (face not enrolled)", async () => {
        setupAuthMocks({ org_id: 1 });
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    attendance_verification_enabled: true,
                    office_latitude: 10, office_longitude: 20, office_radius_m: 150,
                    office_wifi_bssids: [], office_wifi_verification_enabled: false,
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ work_mode: "office" }], rowCount: 1 })
            // SELECT face_descriptor -> not enrolled
            .mockResolvedValueOnce({ rows: [{ face_descriptor: null }], rowCount: 1 });

        // Inside the geofence but no face descriptor and no fingerprint fallback:
        // the identity gate must reject before any clock_out row is written.
        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330")
            .send({ latitude: 10, longitude: 20, accuracy: 10 });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FACE_NOT_ENROLLED");
    });

    test("remote session clock-out skips office location + identity verification", async () => {
        setupAuthMocks({ org_id: 1 });
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    attendance_verification_enabled: true,
                    office_latitude: 10, office_longitude: 20, office_radius_m: 150,
                    office_wifi_bssids: [], office_wifi_verification_enabled: false,
                }],
                rowCount: 1,
            })
            // open session was REMOTE -> whole office/identity gate is skipped
            .mockResolvedValueOnce({ rows: [{ work_mode: "remote" }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // No location, no face, no fingerprint - a remote clock-out must succeed.
        const res = await request(app)
            .post("/api/tracker/clock-out")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged out/i);
    });
});

describe("POST /api/tracker/break-start", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    test("succeeds when on_floor", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "clock_in" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post("/api/tracker/break-start")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/break started/i);
    });

    test("returns 400 when not logged in", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
        mockTransaction.mockReset().mockImplementation(async () => ({ error: "You must login first" }));

        const res = await request(app)
            .post("/api/tracker/break-start")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(400);
    });
});

describe("POST /api/tracker/break-end", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    test("succeeds when on break", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: "break_start" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post("/api/tracker/break-end")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/break ended/i);
    });

    test("returns 400 when not on break", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
        mockTransaction.mockReset().mockImplementation(async () => ({ error: "You are not on break" }));

        const res = await request(app)
            .post("/api/tracker/break-end")
            .set(CSRF)
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "-330");
        expect(res.status).toBe(400);
    });
});

describe("GET /api/tracker/widgets", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("does not count below-threshold work day as present when min_hours_present is set", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const clockIn = `${today}T09:00:00.000Z`;
        const clockOut = `${today}T13:34:00.000Z`; // 4h34m (274 minutes)

        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth token check
            .mockResolvedValueOnce({
                rows: [
                    { entry_type: "clock_in", timestamp: clockIn, work_mode: "office", approval_status: null },
                    { entry_type: "clock_out", timestamp: clockOut, approval_status: null },
                ],
                rowCount: 2,
            }) // entries
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // leaves
            .mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }) // user org lookup
            .mockResolvedValueOnce({
                rows: [{ work_hours_per_day: 9, work_days: "1,2,3,4,5", min_hours_present: 7 }],
                rowCount: 1,
            }); // org config

        const res = await request(app)
            .get("/api/tracker/widgets")
            .set("Cookie", authCookie())
            .set("X-Timezone-Offset", "0");

        expect(res.status).toBe(200);
        expect(res.body.attendancePercent).toBe(0);
    });
});

describe("PUT /api/tracker/manual-entry/:date (non-destructive edit)", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    test("keeps existing entries and queues a pending approval when the day holds protected data", async () => {
        setupAuthMocks({ id: 1, role: "employee", org_id: null });
        mockQuery
            // leave conflict check
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            // protected-data probe: an approved / live-tracked row exists
            .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

        const res = await request(app)
            .put(`/api/tracker/manual-entry/${yesterday}`)
            .set("Cookie", authCookie())
            .set(CSRF)
            .set("X-Timezone-Offset", "0")
            .send({ clock_in: "09:00", clock_out: "17:00", work_mode: "office" });

        if (res.status !== 200) { console.log("DBG body", JSON.stringify(res.body)); console.log("DBG mockQuery n", mockQuery.mock.calls.length); }
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("pending");
        expect(res.body.needsApproval).toBe(true);
        expect(res.body.message).toMatch(/manager approval/i);

        // The verified time_entries rows must NOT be deleted on this path.
        const txSql = mockTxClient.query.mock.calls.map((c: any[]) => String(c[0]));
        expect(txSql.some((s: string) => /DELETE FROM time_entries/i.test(s))).toBe(false);
        // A fresh pending approval_requests row is inserted with the proposal.
        expect(txSql.some((s: string) => /INSERT INTO approval_requests/i.test(s))).toBe(true);
        // The stored metadata marks this as an edit request.
        const insertCall = mockTxClient.query.mock.calls.find(
            (c: any[]) => /INSERT INTO approval_requests/i.test(String(c[0])),
        );
        const metadata = JSON.parse(insertCall[1][insertCall[1].length - 1]);
        expect(metadata.edit).toBe(true);
        expect(metadata.date).toBe(yesterday);
        expect(metadata.clock_in).toBe("09:00");
        expect(metadata.clock_out).toBe("17:00");
    });

    test("applies delete-and-reinsert directly when only pending/no data exists", async () => {
        setupAuthMocks({ id: 1, role: "employee", org_id: null });
        mockQuery
            // leave conflict check
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            // protected-data probe: nothing verified on this day
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .put(`/api/tracker/manual-entry/${yesterday}`)
            .set("Cookie", authCookie())
            .set(CSRF)
            .set("X-Timezone-Offset", "0")
            .send({ clock_in: "09:00", clock_out: "17:00", work_mode: "office" });

        expect(res.status).toBe(200);
        // Non-super-admin edit still needs approval, but rows are re-inserted
        // as pending (no verified data is lost).
        expect(res.body.needsApproval).toBe(true);
        const txSql = mockTxClient.query.mock.calls.map((c: any[]) => String(c[0]));
        expect(txSql.some((s: string) => /DELETE FROM time_entries/i.test(s))).toBe(true);
        expect(txSql.some((s: string) => /INSERT INTO time_entries/i.test(s))).toBe(true);
    });

    test("rejects a future date", async () => {
        setupAuthMocks({ id: 1, role: "employee", org_id: null });
        const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const res = await request(app)
            .put(`/api/tracker/manual-entry/${future}`)
            .set("Cookie", authCookie())
            .set(CSRF)
            .set("X-Timezone-Offset", "0")
            .send({ clock_in: "09:00", clock_out: "17:00" });
        expect(res.status).toBe(400);
    });
});
