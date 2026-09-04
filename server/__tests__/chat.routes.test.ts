export {};

// Tests for /api/chat — search, conversations, messages

const mockRequestLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

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
        req.log = mockRequestLog;
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

// Force loadUserContext down its deterministic DB path: with the user-context
// cache always missing, every request runs the same `SELECT … is_active FROM
// users` lookup, so the per-test mockQuery chains stay stable (otherwise the
// first group test would warm the cache and the second would skip the user
// lookup, shifting its mock sequence).
jest.mock("../redis", () => {
    const actual = jest.requireActual("../redis");
    return {
        ...actual,
        // Always miss the user-context cache so loadUserContext runs its DB
        // lookup deterministically in every request.
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
const redis = require("../redis");

const SECRET = process.env.JWT_SECRET || "test-secret";
const CSRF = { "X-Requested-With": "WorkPulse" };

function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: "testuser", tv: 0 }, SECRET, { expiresIn: "1h" });
    return `token=${token}`;
}

// chat.js uses only `auth` (not loadUserContext)
function setupAuth() {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
}

// ─── GET /uploads/.../chat/... ─────────────────────────────────────────────

describe("GET chat attachment", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("denies an authenticated non-participant before static file serving", async () => {
        setupAuth();
        // Participant-authorized attachment lookup returns no matching row.
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get("/uploads/org_1/chat/private-file.png")
            .set("Cookie", authCookie(3));

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Forbidden");
        const authorizationCall = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("JOIN conversation_participants cp") &&
                sql.includes("m.file_url = $2"),
        );
        expect(authorizationCall).toBeTruthy();
        expect(authorizationCall[1]).toEqual([
            3,
            "/uploads/org_1/chat/private-file.png",
        ]);
    });
});

// ─── GET /api/chat/search ─────────────────────────────────────────────────

describe("GET /api/chat/search", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/chat/search?q=alice");
        expect(res.status).toBe(401);
    });

    test("returns empty array for query shorter than 2 chars", async () => {
        setupAuth();

        const res = await request(app).get("/api/chat/search?q=a").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test("returns empty array when user has no org", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: null }], rowCount: 1 }); // getUserOrg

        const res = await request(app).get("/api/chat/search?q=alice").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test("returns matching users in same org", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        const users = [
            {
                id: 2,
                username: "alice",
                full_name: "Alice Smith",
                email: "alice@test.com",
                avatar: null,
                last_seen_at: null,
            },
        ];
        mockQuery.mockResolvedValueOnce({ rows: users, rowCount: 1 });

        const res = await request(app).get("/api/chat/search?q=alice").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].username).toBe("alice");
    });
});

// ─── GET /api/chat/presence ───────────────────────────────────────────────

describe("GET /api/chat/presence", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/chat/presence?userIds=2,3");
        expect(res.status).toBe(401);
    });

    test("returns empty object when userIds is missing", async () => {
        setupAuth();

        const res = await request(app).get("/api/chat/presence").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });

    test("returns presence statuses for users in same org", async () => {
        // PR7: /api/chat/presence is now a thin alias over StatusService.
        // The test feeds the repository fixtures the service needs:
        //   1) getUserOrg (route)
        //   2) org-membership filter (route)
        //   3) repo.getUserPrefsBulk
        //   4) repo.getOpenSessionsBulk
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 2 }, { id: 3 }],
            rowCount: 2,
        }); // org members filter
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    id: 2,
                    manual_status: null,
                    presence_preference: "auto",
                    status_message: null,
                    status_message_expires_at: null,
                    last_activity_at: new Date(),
                },
                {
                    id: 3,
                    manual_status: null,
                    presence_preference: "auto",
                    status_message: null,
                    status_message_expires_at: null,
                    last_activity_at: new Date(),
                },
            ],
            rowCount: 2,
        }); // getUserPrefsBulk
        const recent = new Date(Date.now() - 60 * 1000); // 1 min ago = online
        mockQuery.mockResolvedValueOnce({
            rows: [
                // Only user 2 has an open session → online
                {
                    user_id: 2,
                    session_key: "s2",
                    device_label: null,
                    connected_at: recent,
                    last_seen_at: recent,
                    disconnected_at: null,
                    activity: null,
                    activity_ref_id: null,
                },
            ],
            rowCount: 1,
        }); // getOpenSessionsBulk

        const res = await request(app).get("/api/chat/presence?userIds=2,3").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body[2].presence).toBe("online");
        expect(res.body[3].presence).toBe("offline");
        expect(res.body[3].userStatus).toBe("offline");
    });

    test("returns work mode from today's clock-in (office/remote)", async () => {
        // Mirrors the presence fixture chain, then adds the 5th query the route
        // now makes for the office/remote badge: today's time_entries per user.
        //   1) getUserOrg  2) org members  3) getUserPrefsBulk
        //   4) getOpenSessionsBulk  5) time_entries (work-mode lookup)
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 2 }, { id: 3 }],
            rowCount: 2,
        }); // org members filter
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    id: 2,
                    manual_status: null,
                    presence_preference: "auto",
                    status_message: null,
                    status_message_expires_at: null,
                    last_activity_at: new Date(),
                },
                {
                    id: 3,
                    manual_status: null,
                    presence_preference: "auto",
                    status_message: null,
                    status_message_expires_at: null,
                    last_activity_at: new Date(),
                },
            ],
            rowCount: 2,
        }); // getUserPrefsBulk
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getOpenSessionsBulk
        // time_entries: user 2 clocked in (office, still on floor); user 3 clocked
        // out → logged out → no work mode.
        mockQuery.mockResolvedValueOnce({
            rows: [
                { user_id: 2, entry_type: "clock_in", work_mode: "office" },
                { user_id: 3, entry_type: "clock_in", work_mode: "remote" },
                { user_id: 3, entry_type: "clock_out", work_mode: null },
            ],
            rowCount: 3,
        }); // time_entries work-mode lookup

        const res = await request(app).get("/api/chat/presence?userIds=2,3").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        // User 2 is still clocked in from the office → "office".
        expect(res.body[2].workMode).toBe("office");
        // User 3 clocked out → logged out → no work mode surfaced.
        expect(res.body[3].workMode).toBeNull();
    });
});

// ─── GET /api/chat/conversations ───────────────────────────────────────────

describe("GET /api/chat/conversations", () => {
    let unreadCountsSpy: jest.SpyInstance;

    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        unreadCountsSpy = jest.spyOn(redis, "getUnreadCounts").mockResolvedValue(null);
    });

    afterEach(() => {
        unreadCountsSpy.mockRestore();
    });

    test("returns group_member_avatars for group conversations", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    id: 10,
                    is_group: true,
                    group_name: "Team Alpha",
                    group_avatar: null,
                    unread_count: 2,
                    group_member_avatars: ["/uploads/a.png", "/uploads/b.png", "/uploads/c.png"],
                },
            ],
            rowCount: 1,
        });
        const res = await request(app).get("/api/chat/conversations").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].is_group).toBe(true);
        expect(res.body[0].group_member_avatars).toEqual([
            "/uploads/a.png",
            "/uploads/b.png",
            "/uploads/c.png",
        ]);
        const sqls = mockQuery.mock.calls
            .map((c: any[]) => c[0])
            .filter((q: unknown): q is string => typeof q === "string");
        expect(sqls.some((q: string) => q.includes("ORDER BY cp3.user_id ASC"))).toBe(true);
        expect(sqls.some((q: string) => q.includes("ORDER BY cp3.id ASC"))).toBe(false);
    });

    test("overlays redis unread counts without altering group avatars", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    id: 11,
                    is_group: true,
                    group_name: "Ops",
                    group_avatar: null,
                    unread_count: 1,
                    group_member_avatars: ["/uploads/o1.png", "/uploads/o2.png"],
                },
            ],
            rowCount: 1,
        });
        unreadCountsSpy.mockResolvedValueOnce({ 11: 7 });

        const res = await request(app).get("/api/chat/conversations").set("Cookie", authCookie());

        expect(res.status).toBe(200);
        expect(res.body[0].unread_count).toBe(7);
        expect(res.body[0].group_member_avatars).toEqual([
            "/uploads/o1.png",
            "/uploads/o2.png",
        ]);
    });
});

// ─── POST /api/chat/conversations ────────────────────────────────────────

describe("POST /api/chat/conversations", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    test("returns 401 without auth", async () => {
        const res = await request(app).post("/api/chat/conversations").set(CSRF).send({ userId: 2 });
        expect(res.status).toBe(401);
    });

    test("creates self-chat conversation when userId is self", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }], rowCount: 1 }); // self user lookup
        // Existence check now inside transaction
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no existing self-conversation (FOR UPDATE)
            .mockResolvedValueOnce({ rows: [{ id: 50 }], rowCount: 1 }) // INSERT conversation
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT participant

        const res = await request(app)
            .post("/api/chat/conversations")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ userId: 1 });

        expect(res.status).toBe(201);
        expect(res.body.conversationId).toBe(50);
    });

    test("returns existing self-chat if already exists", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }], rowCount: 1 }); // self user lookup
        // Existence check now inside transaction
        mockTxClient.query.mockResolvedValueOnce({ rows: [{ conversation_id: 99 }], rowCount: 1 }); // existing self-conv (FOR UPDATE)

        const res = await request(app)
            .post("/api/chat/conversations")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ userId: 1 });

        expect(res.status).toBe(200);
        expect(res.body.conversationId).toBe(99);
    });

    test("returns 400 when one user not found", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }], rowCount: 1 }); // only 1 user found

        const res = await request(app)
            .post("/api/chat/conversations")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ userId: 999 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not found/i);
    });

    test("returns 403 when users are in different orgs", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [
                { id: 1, org_id: 1 },
                { id: 2, org_id: 2 }, // different org
            ],
            rowCount: 2,
        });

        const res = await request(app)
            .post("/api/chat/conversations")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ userId: 2 });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/same organization/i);
    });

    test("returns existing conversation id when direct chat already exists", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }, { id: 2, org_id: 1 }], rowCount: 2 }); // users found
        // Existence check now inside transaction
        mockTxClient.query.mockResolvedValueOnce({ rows: [{ conversation_id: 42 }], rowCount: 1 }); // existing conv (FOR UPDATE)

        const res = await request(app)
            .post("/api/chat/conversations")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ userId: 2 });

        expect(res.status).toBe(200);
        expect(res.body.conversationId).toBe(42);
    });

    test("creates a new conversation when none exists", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }, { id: 2, org_id: 1 }], rowCount: 2 }); // users found
        // Existence check now inside transaction
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no existing conv (FOR UPDATE)
            .mockResolvedValueOnce({ rows: [{ id: 55 }], rowCount: 1 }) // INSERT conversation
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT participants

        const res = await request(app)
            .post("/api/chat/conversations")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ userId: 2 });

        expect(res.status).toBe(201);
        expect(res.body.conversationId).toBe(55);
    });
});

// ─── POST /api/chat/conversations/group ──────────────────────────────────

describe("POST /api/chat/conversations/group", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
    });

    test("returns 401 without auth", async () => {
        const res = await request(app)
            .post("/api/chat/conversations/group")
            .set(CSRF)
            .send({ name: "Dev Team", userIds: [2, 3] });
        expect(res.status).toBe(401);
    });

    test("returns 400 when group name is missing", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg

        const res = await request(app)
            .post("/api/chat/conversations/group")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ userIds: [2, 3] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name is required/i);
    });

    test("returns 400 when no additional users provided", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg

        const res = await request(app)
            .post("/api/chat/conversations/group")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ name: "Team", userIds: [] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at least one/i);
    });

    test("creates a group conversation successfully", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        // all users in same org
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3 });
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }) // INSERT conversation
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT participants

        const res = await request(app)
            .post("/api/chat/conversations/group")
            .set("Cookie", authCookie())
            .set(CSRF)
            .send({ name: "Dev Team", userIds: [2, 3] });

        expect(res.status).toBe(201);
        expect(res.body.conversationId).toBe(99);
    });
});

describe("PUT /api/chat/conversations/:id/group", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 403 when requester is not a participant", async () => {
        setupAuth();
        mockQuery
            // loadUserContext: active user (role employee → level 1, no extra
            // tenant_roles query).
            .mockResolvedValueOnce({
                rows: [{ role: "employee", org_id: 1, is_active: true }],
                rowCount: 1,
            })
            // route conversation lookup
            .mockResolvedValueOnce({ rows: [{ id: 10, is_group: true, org_id: 1 }], rowCount: 1 })
            // loadGroupContext: conversation policy row
            .mockResolvedValueOnce({
                rows: [{ is_group: true, created_by: 1, post_policy: "all", add_policy: "admins" }],
                rowCount: 1,
            })
            // loadGroupContext: caller's role — none (not a participant)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .put("/api/chat/conversations/10/group")
            .set(CSRF)
            .set("Cookie", authCookie(1))
            .send({ removeUserIds: [2] });

        expect(res.status).toBe(403);
    });

    test("removes only users validated in the same org", async () => {
        setupAuth();
        mockQuery
            // 1) loadUserContext: active user (employee → level 1)
            .mockResolvedValueOnce({
                rows: [{ role: "employee", org_id: 1, is_active: true }],
                rowCount: 1,
            })
            // 2) route conversation lookup (SELECT * FROM conversations …)
            .mockResolvedValueOnce({ rows: [{ id: 10, is_group: true, org_id: 1 }], rowCount: 1 })
            // 3) loadGroupContext: conversation policy row
            .mockResolvedValueOnce({
                rows: [{ is_group: true, created_by: 1, post_policy: "all", add_policy: "admins" }],
                rowCount: 1,
            })
            // 4) loadGroupContext: caller's role. Phase 1 RBAC — removing
            //    members is admin-class, so the caller must be owner/admin.
            .mockResolvedValueOnce({ rows: [{ role: "owner" }], rowCount: 1 })
            // 5) actor full_name lookup (for the activity system message)
            .mockResolvedValueOnce({ rows: [{ full_name: "Owner" }], rowCount: 1 })
            // 6) validate removable users in the same org (returns row + role)
            .mockResolvedValueOnce({ rows: [{ id: 2, full_name: "Bob", role: "member" }], rowCount: 1 })
            // 7) DELETE participant
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const res = await request(app)
            .put("/api/chat/conversations/10/group")
            .set(CSRF)
            .set("Cookie", authCookie(1))
            .send({ removeUserIds: [2, 999] });

        expect(res.status).toBe(200);

        // The remove-validation query selects the member's role too so the
        // route can refuse to let an admin remove the owner (Phase 1 RBAC).
        const validateCall = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("SELECT u.id, u.full_name, cp.role FROM users u")
        );
        expect(validateCall).toBeTruthy();
        expect(validateCall[1][0]).toEqual([2, 999]);
        expect(validateCall[1][1]).toBe(1);
        expect(validateCall[1][2]).toBe(10);

        const deleteCalls = mockQuery.mock.calls.filter(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes(
                    "DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2"
                )
        );
        expect(deleteCalls).toHaveLength(1);
        expect(deleteCalls[0][1]).toEqual([10, 2]);
    });
});

describe("POST /api/chat/conversations/:id/messages", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("rejects a reply target from another conversation before insertion", async () => {
        setupAuth();
        mockQuery
            // Sender participates in destination conversation.
            .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 })
            // Group avoids unrelated direct-chat block enforcement.
            .mockResolvedValueOnce({
                rows: [{ is_group: true, group_name: "Team" }],
                rowCount: 1,
            })
            // Reply message is not in the destination conversation.
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post("/api/chat/conversations/10/messages")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ content: "Reply attempt", replyToId: 999 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/reply target/i);
        expect(
            mockQuery.mock.calls.some(
                ([sql]: any[]) =>
                    typeof sql === "string" &&
                    sql.includes("INSERT INTO messages (conversation_id, sender_id, content, reply_to_id)"),
            ),
        ).toBe(false);
    });
});

describe("POST /api/chat/messages/:id/reactions", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("rejects reactions on deleted messages", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [{ conversation_id: 10, deleted_at: new Date().toISOString() }],
            rowCount: 1,
        });

        const res = await request(app)
            .post("/api/chat/messages/12/reactions")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ emoji: "👍" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deleted/i);
    });
});

describe("DELETE /api/chat/messages/:id", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("clears reactions when deleting a message", async () => {
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({
                rows: [{ id: 12, sender_id: 1, conversation_id: 10, deleted_at: null, file_url: null }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 2 })
            .mockResolvedValueOnce({ rows: [{ user_id: 1 }, { user_id: 2 }], rowCount: 2 });

        const res = await request(app)
            .delete("/api/chat/messages/12")
            .set("Cookie", authCookie(1))
            .set(CSRF);

        expect(res.status).toBe(200);
        const reactionDeleteCall = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("DELETE FROM message_reactions WHERE message_id = $1"),
        );
        expect(reactionDeleteCall).toBeTruthy();
        expect(reactionDeleteCall[1]).toEqual([12]);
    });
});

// ─── Call-history selection and deletion ───────────────────────────────────

describe("GET /api/chat/calls", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns 401 without auth", async () => {
        const res = await request(app).get("/api/chat/calls");
        expect(res.status).toBe(401);
    });

    test("reports the complete selectable count without leaking it into rows", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    id: 500,
                    conversation_id: 10,
                    caller_id: 1,
                    call_type: "audio",
                    status: "ended",
                    created_at: new Date().toISOString(),
                    total_count: 237,
                },
            ],
            rowCount: 1,
        });

        const res = await request(app)
            .get("/api/chat/calls")
            .set("Cookie", authCookie(1));

        expect(res.status).toBe(200);
        expect(res.headers["x-total-count"]).toBe("237");
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe(500);
        expect(res.body[0]).not.toHaveProperty("total_count");

        const historyQuery = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("COUNT(*) OVER()") &&
                sql.includes("LIMIT 100"),
        );
        expect(historyQuery).toBeTruthy();
        expect(historyQuery[1]).toEqual([1]);
    });
});

describe("POST /api/chat/calls/delete", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("rejects an empty selection", async () => {
        setupAuth();

        const res = await request(app)
            .post("/api/chat/calls/delete")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ ids: [] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/No call ids/i);
    });

    test("deletes only terminal rows from an explicit normalized id subset", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });

        const res = await request(app)
            .post("/api/chat/calls/delete")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ ids: [10, "11", 10, -1, "invalid"] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, deleted: 2 });
        const deleteQuery = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("DELETE FROM call_logs") &&
                sql.includes("cl.id = ANY"),
        );
        expect(deleteQuery).toBeTruthy();
        expect(deleteQuery[1]).toEqual([[10, 11], 1]);
        expect(deleteQuery[0]).toContain("cp.user_id = $2");
        expect(deleteQuery[0]).toContain(
            "cl.status IN ('ended', 'missed', 'declined')",
        );
    });

    test("server-side select-all deletes only terminal rows beyond the loaded 100", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 237 });

        const res = await request(app)
            .post("/api/chat/calls/delete")
            .set("Cookie", authCookie(1))
            .set(CSRF)
            .send({ all: true });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, deleted: 237 });
        const deleteQuery = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("DELETE FROM call_logs") &&
                !sql.includes("cl.id = ANY"),
        );
        expect(deleteQuery).toBeTruthy();
        expect(deleteQuery[0]).toContain("conversation_participants");
        expect(deleteQuery[0]).toContain("cp.user_id = $1");
        expect(deleteQuery[0]).toContain(
            "cl.status IN ('ended', 'missed', 'declined')",
        );
        expect(deleteQuery[1]).toEqual([1]);
    });
});

describe("DELETE /api/chat/conversations/:id", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn: any) => fn(mockTxClient));
        require("../utils/ws").sendToUser.mockClear();
    });

    test("atomically rejects deletion while a call is ringing or answered", async () => {
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 })
            .mockResolvedValueOnce({
                rows: [{ is_group: false, created_by: 1 }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ user_id: 2 }], rowCount: 1 });
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

        const res = await request(app)
            .delete("/api/chat/conversations/10")
            .set("Cookie", authCookie(1))
            .set(CSRF);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/End the active call/i);
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        const lockQuery = mockTxClient.query.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("FROM conversations") &&
                sql.includes("FOR UPDATE"),
        );
        const activeQuery = mockTxClient.query.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("FROM call_logs"),
        );
        expect(lockQuery).toBeTruthy();
        expect(activeQuery?.[0]).toContain(
            "cl.status IN ('ringing', 'answered')",
        );
        expect(
            mockTxClient.query.mock.calls.some(
                ([sql]: any[]) =>
                    typeof sql === "string" &&
                    sql.includes("DELETE FROM conversations"),
            ),
        ).toBe(false);
        expect(require("../utils/ws").sendToUser).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            "chat_conv_deleted",
            expect.anything(),
        );
    });

    test("deletes and notifies when the conversation has no active call", async () => {
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 })
            .mockResolvedValueOnce({
                rows: [{ is_group: false, created_by: 1 }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ user_id: 2 }], rowCount: 1 });
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 });

        const res = await request(app)
            .delete("/api/chat/conversations/10")
            .set("Cookie", authCookie(1))
            .set(CSRF);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(
            mockTxClient.query.mock.calls.some(
                ([sql]: any[]) =>
                    typeof sql === "string" &&
                    sql.includes("DELETE FROM conversations"),
            ),
        ).toBe(true);
        expect(
            require("../utils/ws").sendToUser.mock.calls.some(
                ([, , event]: any[]) => event === "chat_conv_deleted",
            ),
        ).toBe(true);
    });
});

describe("GET /api/chat/calls/:callId/media-session", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("returns the persisted p2p backend for an authorized joinable call", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 500,
                conversation_id: 10,
                call_type: "voice",
                status: "ringing",
                media_backend: "p2p",
            }],
            rowCount: 1,
        });

        const res = await request(app)
            .get("/api/chat/calls/500/media-session?conversationId=10")
            .set("Cookie", authCookie(1));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            backend: "p2p",
            callId: 500,
            conversationId: 10,
        });
        const mediaQuery = mockQuery.mock.calls.find(
            ([sql]: any[]) =>
                typeof sql === "string" &&
                sql.includes("JOIN conversation_participants") &&
                sql.includes("cl.media_backend"),
        );
        expect(mediaQuery?.[1]).toEqual([500, 10, 1]);
    });

    test("idempotently ensures a LiveKit room before returning its join token", async () => {
        const { RoomServiceClient } = require("livekit-server-sdk");
        const createRoom = jest
            .spyOn(RoomServiceClient.prototype, "createRoom")
            .mockResolvedValue({ name: "existing-or-created" });
        const secret = "test-secret-at-least-32-characters";
        process.env.LIVEKIT_URL = "wss://calls.example.test";
        process.env.LIVEKIT_API_KEY = "test-key";
        process.env.LIVEKIT_API_SECRET = secret;
        setupAuth();
        const callRow = {
            id: 501,
            conversation_id: 10,
            call_type: "video",
            status: "answered",
            media_backend: "livekit",
        };
        mockQuery.mockResolvedValueOnce({
            rows: [callRow],
            rowCount: 1,
        });
        mockQuery.mockResolvedValueOnce({
            rows: [{
                ...callRow,
            }],
            rowCount: 1,
        });

        try {
            const res = await request(app)
                .get("/api/chat/calls/501/media-session?conversationId=10")
                .set("Cookie", authCookie(1));

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                backend: "livekit",
                callId: 501,
                conversationId: 10,
                livekit: {
                    serverUrl: "wss://calls.example.test",
                    token: expect.any(String),
                    roomName: expect.stringMatching(/^call_/),
                },
            });
            expect(createRoom).toHaveBeenCalledWith({
                name: res.body.livekit.roomName,
                maxParticipants: 2,
            });
            expect(JSON.stringify(res.body)).not.toContain(secret);
        } finally {
            createRoom.mockRestore();
            delete process.env.LIVEKIT_URL;
            delete process.env.LIVEKIT_API_KEY;
            delete process.env.LIVEKIT_API_SECRET;
        }
    });

    test("maps a terminal transition during room creation to a logged conflict", async () => {
        const { RoomServiceClient } = require("livekit-server-sdk");
        const createRoom = jest
            .spyOn(RoomServiceClient.prototype, "createRoom")
            .mockResolvedValue({ name: "created" });
        const deleteRoom = jest
            .spyOn(RoomServiceClient.prototype, "deleteRoom")
            .mockResolvedValue(undefined);
        process.env.LIVEKIT_URL = "wss://calls.example.test";
        process.env.LIVEKIT_API_KEY = "test-key";
        process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
        mockRequestLog.info.mockClear();
        mockRequestLog.error.mockClear();
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 502,
                    conversation_id: 10,
                    call_type: "voice",
                    status: "ringing",
                    media_backend: "livekit",
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 502,
                    conversation_id: 10,
                    call_type: "voice",
                    status: "ended",
                    media_backend: "livekit",
                }],
                rowCount: 1,
            });

        try {
            const res = await request(app)
                .get("/api/chat/calls/502/media-session?conversationId=10")
                .set("Cookie", authCookie(1));

            expect(res.status).toBe(409);
            expect(res.body).toEqual({ error: "Call is not joinable" });
            expect(deleteRoom).toHaveBeenCalledWith(expect.stringMatching(/^call_/));
            expect(mockRequestLog.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    callId: 502,
                    status: "ended",
                    phase: "after_create",
                }),
                "Call media-session rejected: call is not joinable",
            );
            expect(mockRequestLog.error).not.toHaveBeenCalled();
        } finally {
            createRoom.mockRestore();
            deleteRoom.mockRestore();
            delete process.env.LIVEKIT_URL;
            delete process.env.LIVEKIT_API_KEY;
            delete process.env.LIVEKIT_API_SECRET;
        }
    });

    test("maps a call removed during room creation to gone", async () => {
        const { RoomServiceClient } = require("livekit-server-sdk");
        const createRoom = jest
            .spyOn(RoomServiceClient.prototype, "createRoom")
            .mockResolvedValue({ name: "created" });
        const deleteRoom = jest
            .spyOn(RoomServiceClient.prototype, "deleteRoom")
            .mockResolvedValue(undefined);
        process.env.LIVEKIT_URL = "wss://calls.example.test";
        process.env.LIVEKIT_API_KEY = "test-key";
        process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
        mockRequestLog.info.mockClear();
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 503,
                    conversation_id: 10,
                    call_type: "voice",
                    status: "ringing",
                    media_backend: "livekit",
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        try {
            const res = await request(app)
                .get("/api/chat/calls/503/media-session?conversationId=10")
                .set("Cookie", authCookie(1));

            expect(res.status).toBe(410);
            expect(res.body).toEqual({ error: "Call is no longer available" });
            expect(deleteRoom).toHaveBeenCalledWith(expect.stringMatching(/^call_/));
            expect(mockRequestLog.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    callId: 503,
                    phase: "after_create",
                }),
                "Call media-session rejected: call is gone",
            );
        } finally {
            createRoom.mockRestore();
            deleteRoom.mockRestore();
            delete process.env.LIVEKIT_URL;
            delete process.env.LIVEKIT_API_KEY;
            delete process.env.LIVEKIT_API_SECRET;
        }
    });

    test("conceals calls outside the authenticated participant scope", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get("/api/chat/calls/500/media-session?conversationId=10")
            .set("Cookie", authCookie(1));

        expect(res.status).toBe(404);
    });

    test("rejects media sessions for terminal calls", async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 500,
                conversation_id: 10,
                call_type: "voice",
                status: "ended",
                media_backend: "p2p",
            }],
            rowCount: 1,
        });

        const res = await request(app)
            .get("/api/chat/calls/500/media-session?conversationId=10")
            .set("Cookie", authCookie(1));

        expect(res.status).toBe(409);
    });
});

describe("POST /api/chat/calls/:callId/end LiveKit cleanup", () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test("keeps the DB transition authoritative when room deletion fails", async () => {
        const { RoomServiceClient } = require("livekit-server-sdk");
        const deleteRoom = jest
            .spyOn(RoomServiceClient.prototype, "deleteRoom")
            .mockRejectedValueOnce(new Error("LiveKit unavailable"));
        process.env.LIVEKIT_URL = "wss://calls.example.test";
        process.env.LIVEKIT_API_KEY = "test-key";
        process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 })
            .mockResolvedValueOnce({
                rows: [{
                    id: 500,
                    conversation_id: 10,
                    caller_id: 2,
                    call_type: "voice",
                    status: "answered",
                    media_backend: "livekit",
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ status: "ended" }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        try {
            const res = await request(app)
                .post("/api/chat/calls/500/end")
                .set("Cookie", authCookie(1))
                .set(CSRF)
                .send({ conversationId: 10 });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true, status: "ended" });
            expect(deleteRoom).toHaveBeenCalledWith(expect.stringMatching(/^call_/));
            expect(
                mockQuery.mock.calls.some(
                    ([sql]: any[]) =>
                        typeof sql === "string" &&
                        sql.includes("status NOT IN ('ended', 'missed', 'declined')"),
                ),
            ).toBe(true);
        } finally {
            deleteRoom.mockRestore();
            delete process.env.LIVEKIT_URL;
            delete process.env.LIVEKIT_API_KEY;
            delete process.env.LIVEKIT_API_SECRET;
        }
    });
});
