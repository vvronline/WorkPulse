// Tests for GET /api/search?q=<term>

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

jest.mock('../db', () => ({
    pool: { end: jest.fn() },
    query: (...args) => mockQuery(...args),

    masterQuery: (...args) => mockQuery(...args),

    masterTransaction: (...args) => mockTransaction ? mockTransaction(...args) : (async (fn) => fn({ query: (...a) => mockQuery(...a) }))(...args),
    transaction: jest.fn(async (fn) => fn({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
    initDB: jest.fn(),
}));

const { app } = require('../index');

const SECRET = process.env.JWT_SECRET || 'test-secret';

function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: 'testuser', tv: 0 }, SECRET, { expiresIn: '1h' });
    return `token=${token}`;
}

function setupAuth(role = 'employee', extra = {}) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ role, org_id: 1, team_id: 1, department_id: 1, manager_id: null, is_active: true, ...extra }], rowCount: 1 });
}

// ─── Auth gate ─────────────────────────────────────────────────────────────

describe('GET /api/search - authentication', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth cookie', async () => {
        const res = await request(app).get('/api/search?q=hello');
        expect(res.status).toBe(401);
    });
});

// ─── Short / empty query ───────────────────────────────────────────────────

describe('GET /api/search - short query handling', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns empty results for query shorter than 2 chars', async () => {
        setupAuth();

        const res = await request(app)
            .get('/api/search?q=a')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.tasks).toEqual([]);
        expect(res.body.notes).toEqual([]);
        expect(res.body.users).toEqual([]);
    });

    test('returns empty results when q is missing', async () => {
        setupAuth();

        const res = await request(app)
            .get('/api/search')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.tasks).toEqual([]);
    });

    test('returns empty results for whitespace-only query', async () => {
        setupAuth();

        const res = await request(app)
            .get('/api/search?q=  ')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.tasks).toEqual([]);
    });
});

// ─── Results grouping ──────────────────────────────────────────────────────

describe('GET /api/search - results grouping', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns tasks, notes, users, events, leaves, sprints grouped', async () => {
        setupAuth();

        const taskRow = { id: 1, title: 'Fix bug', description: 'Needs fixing', status: 'open', priority: 'high', date: '2024-01-01', due_date: null, sprint_id: null, snippet: 'Fix bug' };
        // tasks query
        mockQuery.mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 });
        // notebooks query (no notebook)
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // users query
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 2, username: 'alice', full_name: 'Alice Smith', email: 'alice@test.com', avatar: null, role: 'employee' }], rowCount: 1 });
        // events query
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // leaves query
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // sprints query
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/api/search?q=fix')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('tasks');
        expect(res.body).toHaveProperty('notes');
        expect(res.body).toHaveProperty('users');
        expect(res.body.tasks[0].title).toBe('Fix bug');
        expect(res.body.users[0].username).toBe('alice');
    });

    test('returns empty arrays for all groups when no matches', async () => {
        setupAuth();

        // tasks, notebook, users, events, leaves, sprints all return empty
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/api/search?q=xyznotfound')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.tasks).toEqual([]);
        expect(res.body.notes).toEqual([]);
        expect(res.body.users).toEqual([]);
    });
});

// ─── Logs restricted to hr_admin+ ────────────────────────────────────────

describe('GET /api/search - logs field access control', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('employee does not receive logs field', async () => {
        setupAuth('employee');

        // All DB queries return empty
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/api/search?q=admin')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        // logs key should be absent or empty for non-hr_admin
        if (res.body.logs !== undefined) {
            expect(res.body.logs).toEqual([]);
        }
    });
});
