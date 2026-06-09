export {};

// Tests for /api/notifications — GET, POST /read-all, POST /:id/read, DELETE /:id

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
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

jest.mock("../utils/audit", () => ({
    logAction: jest.fn(),
    queryLogs: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");

const mockQuery: jest.Mock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock("../db", () => ({
    pool: { end: jest.fn() },
    query: (...args: any[]) => mockQuery(...args),

    masterQuery: (...args: any[]) => mockQuery(...args),

    masterTransaction: (fn: any) => fn({ query: (...a: any[]) => mockQuery(...a) }),
    transaction: jest.fn(async (fn: any) => fn({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
    initDB: jest.fn(),
}));

const { app } = require("../index");

const SECRET = process.env.JWT_SECRET || "test-secret";
const CSRF = { "X-Requested-With": "WorkPulse" };

function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: "testuser", tv: 0 }, SECRET, { expiresIn: "1h" });
    return `token=${token}`;
}

// notifications.js uses auth + loadUserContext
function setupAuth(role = "employee") {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ role, org_id: 1, team_id: 1, department_id: 1, manager_id: null, is_active: true }], rowCount: 1 });
}

// ─── GET /api/notifications ────────────────────────────────────────────────

describe("GET /api/notifications", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/notifications");
        expect(res.status).toBe(401);
    });

    test("returns empty notifications list", async () => {
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }) // total count
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // notifications query
            .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }); // unread count

        const res = await request(app)
            .get("/api/notifications")
            .set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body.notifications).toEqual([]);
        expect(res.body.unread).toBe(0);
    });

    test("returns notifications with correct unread count", async () => {
        setupAuth();
        const rows = [
            { id: 1, message: "Task assigned", is_read: false, created_at: "2024-01-01T10:00:00Z", task_title: "Fix bug" },
            { id: 2, message: "Leave approved", is_read: true, created_at: "2024-01-01T09:00:00Z", task_title: null },
            { id: 3, message: "Sprint started", is_read: false, created_at: "2024-01-01T08:00:00Z", task_title: null },
        ];
        mockQuery
            .mockResolvedValueOnce({ rows: [{ count: "3" }], rowCount: 1 }) // total count
            .mockResolvedValueOnce({ rows, rowCount: 3 }) // notifications query
            .mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1 }); // unread count

        const res = await request(app)
            .get("/api/notifications")
            .set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body.notifications).toHaveLength(3);
        expect(res.body.unread).toBe(2);
    });
});

// ─── POST /api/notifications/read-all ─────────────────────────────────────

describe("POST /api/notifications/read-all", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app)
            .post("/api/notifications/read-all")
            .set(CSRF);
        expect(res.status).toBe(401);
    });

    test("marks all notifications as read", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 }); // UPDATE

        const res = await request(app)
            .post("/api/notifications/read-all")
            .set("Cookie", authCookie())
            .set(CSRF);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

// ─── POST /api/notifications/:id/read ────────────────────────────────────

describe("POST /api/notifications/:id/read", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app)
            .post("/api/notifications/5/read")
            .set(CSRF);
        expect(res.status).toBe(401);
    });

    test("marks a single notification as read", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

        const res = await request(app)
            .post("/api/notifications/5/read")
            .set("Cookie", authCookie())
            .set(CSRF);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        // Verify the query was called with the correct notification id and user id
        const updateCall = mockQuery.mock.calls.find((c: any[]) => c[0] && typeof c[0] === "string" && c[0].includes("UPDATE notifications"));
        expect(updateCall).toBeDefined();
        // ID from URL params is parsed to integer
        expect(updateCall[1][0]).toBe(5);
        expect(updateCall[1][1]).toBe(1); // userId
    });
});

// ─── DELETE /api/notifications/:id ────────────────────────────────────────

describe("DELETE /api/notifications/:id", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app)
            .delete("/api/notifications/5")
            .set(CSRF);
        expect(res.status).toBe(401);
    });

    test("deletes a notification", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE

        const res = await request(app)
            .delete("/api/notifications/5")
            .set("Cookie", authCookie())
            .set(CSRF);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        const deleteCall = mockQuery.mock.calls.find((c: any[]) => c[0] && typeof c[0] === "string" && c[0].includes("DELETE FROM notifications"));
        expect(deleteCall).toBeDefined();
        expect(deleteCall[1][0]).toBe(5);
        expect(deleteCall[1][1]).toBe(1); // userId
    });
});