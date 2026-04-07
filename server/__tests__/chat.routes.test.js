// Tests for /api/chat — search, conversations, messages

jest.mock('../utils/logger', () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req, res, next) => {
        req.id = 'test';
        req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        next();
    },
}));

jest.mock('../utils/mailer', () => ({
    getTransporter: jest.fn(() => null),
    sendMail: jest.fn(),
    notifyByEmail: jest.fn(),
    esc: (s) => String(s ?? ''),
}));

jest.mock('../utils/ws', () => ({
    setupWebSocket: jest.fn(),
    sendToUser: jest.fn(),
    broadcast: jest.fn(),
}));

jest.mock('../utils/audit', () => ({
    logAction: jest.fn(),
    queryLogs: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTxClient = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
const mockTransaction = jest.fn(async (fn) => fn(mockTxClient));

jest.mock('../db', () => ({
    pool: { end: jest.fn() },
    query: (...args) => mockQuery(...args),
    transaction: (...args) => mockTransaction(...args),
    initDB: jest.fn(),
}));

const { app } = require('../index');

const SECRET = process.env.JWT_SECRET || 'test-secret';
const CSRF = { 'X-Requested-With': 'WorkPulse' };

function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: 'testuser', tv: 0 }, SECRET, { expiresIn: '1h' });
    return `token=${token}`;
}

// chat.js uses only `auth` (not loadUserContext)
function setupAuth() {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
}

// ─── GET /api/chat/search ─────────────────────────────────────────────────

describe('GET /api/chat/search', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/chat/search?q=alice');
        expect(res.status).toBe(401);
    });

    test('returns empty array for query shorter than 2 chars', async () => {
        setupAuth();

        const res = await request(app)
            .get('/api/chat/search?q=a')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test('returns empty array when user has no org', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: null }], rowCount: 1 }); // getUserOrg

        const res = await request(app)
            .get('/api/chat/search?q=alice')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test('returns matching users in same org', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        const users = [
            { id: 2, username: 'alice', full_name: 'Alice Smith', email: 'alice@test.com', avatar: null, last_seen_at: null },
        ];
        mockQuery.mockResolvedValueOnce({ rows: users, rowCount: 1 });

        const res = await request(app)
            .get('/api/chat/search?q=alice')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].username).toBe('alice');
    });
});

// ─── GET /api/chat/presence ───────────────────────────────────────────────

describe('GET /api/chat/presence', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/chat/presence?userIds=2,3');
        expect(res.status).toBe(401);
    });

    test('returns empty object when userIds is missing', async () => {
        setupAuth();

        const res = await request(app)
            .get('/api/chat/presence')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });

    test('returns presence statuses for users in same org', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        const recentDate = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago = online
        mockQuery.mockResolvedValueOnce({
            rows: [
                { id: 2, last_seen_at: recentDate },
                { id: 3, last_seen_at: null },
            ], rowCount: 2
        });

        const res = await request(app)
            .get('/api/chat/presence?userIds=2,3')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body[2].presence).toBe('online');
        expect(res.body[3].presence).toBe('offline');
    });
});

// ─── POST /api/chat/conversations ────────────────────────────────────────

describe('POST /api/chat/conversations', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/api/chat/conversations')
            .set(CSRF)
            .send({ userId: 2 });
        expect(res.status).toBe(401);
    });

    test('creates self-chat conversation when userId is self', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }], rowCount: 1 }); // self user lookup
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no existing self-conversation
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ id: 50 }], rowCount: 1 }) // INSERT conversation
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT participant

        const res = await request(app)
            .post('/api/chat/conversations')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ userId: 1 });

        expect(res.status).toBe(201);
        expect(res.body.conversationId).toBe(50);
    });

    test('returns existing self-chat if already exists', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }], rowCount: 1 }); // self user lookup
        mockQuery.mockResolvedValueOnce({ rows: [{ conversation_id: 99 }], rowCount: 1 }); // existing self-conv

        const res = await request(app)
            .post('/api/chat/conversations')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ userId: 1 });

        expect(res.status).toBe(200);
        expect(res.body.conversationId).toBe(99);
    });

    test('returns 400 when one user not found', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }], rowCount: 1 }); // only 1 user found

        const res = await request(app)
            .post('/api/chat/conversations')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ userId: 999 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not found/i);
    });

    test('returns 403 when users are in different orgs', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [
                { id: 1, org_id: 1 },
                { id: 2, org_id: 2 }, // different org
            ], rowCount: 2
        });

        const res = await request(app)
            .post('/api/chat/conversations')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ userId: 2 });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/same organization/i);
    });

    test('returns existing conversation id when direct chat already exists', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }, { id: 2, org_id: 1 }], rowCount: 2 }); // users found
        mockQuery.mockResolvedValueOnce({ rows: [{ conversation_id: 42 }], rowCount: 1 }); // existing conv

        const res = await request(app)
            .post('/api/chat/conversations')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ userId: 2 });

        expect(res.status).toBe(200);
        expect(res.body.conversationId).toBe(42);
    });

    test('creates a new conversation when none exists', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1 }, { id: 2, org_id: 1 }], rowCount: 2 }); // users found
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no existing conv
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ id: 55 }], rowCount: 1 }) // INSERT conversation
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT participants

        const res = await request(app)
            .post('/api/chat/conversations')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ userId: 2 });

        expect(res.status).toBe(201);
        expect(res.body.conversationId).toBe(55);
    });
});

// ─── POST /api/chat/conversations/group ──────────────────────────────────

describe('POST /api/chat/conversations/group', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/api/chat/conversations/group')
            .set(CSRF)
            .send({ name: 'Dev Team', userIds: [2, 3] });
        expect(res.status).toBe(401);
    });

    test('returns 400 when group name is missing', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg

        const res = await request(app)
            .post('/api/chat/conversations/group')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ userIds: [2, 3] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name is required/i);
    });

    test('returns 400 when no additional users provided', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg

        const res = await request(app)
            .post('/api/chat/conversations/group')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ name: 'Team', userIds: [] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at least one/i);
    });

    test('creates a group conversation successfully', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ org_id: 1 }], rowCount: 1 }); // getUserOrg
        // all users in same org
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3 });
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }) // INSERT conversation
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT participants

        const res = await request(app)
            .post('/api/chat/conversations/group')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ name: 'Dev Team', userIds: [2, 3] });

        expect(res.status).toBe(201);
        expect(res.body.conversationId).toBe(99);
    });
});

describe('PUT /api/chat/conversations/:id/group', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 when requester is not a participant', async () => {
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 10, is_group: true, org_id: 1 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .put('/api/chat/conversations/10/group')
            .set(CSRF)
            .set('Cookie', authCookie(1))
            .send({ removeUserIds: [2] });

        expect(res.status).toBe(403);
    });

    test('removes only users validated in the same org', async () => {
        setupAuth();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 10, is_group: true, org_id: 1 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const res = await request(app)
            .put('/api/chat/conversations/10/group')
            .set(CSRF)
            .set('Cookie', authCookie(1))
            .send({ removeUserIds: [2, 999] });

        expect(res.status).toBe(200);

        const validateCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('SELECT u.id FROM users u'));
        expect(validateCall).toBeTruthy();
        expect(validateCall[1][0]).toEqual([2, 999]);
        expect(validateCall[1][1]).toBe(1);

        const deleteCalls = mockQuery.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2'));
        expect(deleteCalls).toHaveLength(1);
        expect(deleteCalls[0][1]).toEqual([10, 2]);
    });
});
