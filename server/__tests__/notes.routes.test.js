// Tests for GET /api/notes, PUT /api/notes, GET /api/notes/history/:pageId

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

// notes.js only uses `auth` (token_version check), not loadUserContext
function setupAuth() {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
}

// ─── GET /api/notes ───────────────────────────────────────────────────────────

describe('GET /api/notes', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/notes');
        expect(res.status).toBe(401);
    });

    test('returns null data when no notebook exists', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no notebook row

        const res = await request(app)
            .get('/api/notes')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: null });
    });

    test('returns parsed notebook data when it exists', async () => {
        setupAuth();
        const notebook = { pages: [{ id: 'p1', title: 'Page 1', content: '<p>Hello</p>' }] };
        const updatedAt = new Date().toISOString();
        mockQuery.mockResolvedValueOnce({
            rows: [{ data: JSON.stringify(notebook), updated_at: updatedAt }],
            rowCount: 1,
        });

        const res = await request(app)
            .get('/api/notes')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(notebook);
        expect(res.body.updatedAt).toBe(updatedAt);
    });
});

// ─── PUT /api/notes ───────────────────────────────────────────────────────────

describe('PUT /api/notes', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .put('/api/notes')
            .set(CSRF)
            .send({ data: { pages: [] } });
        expect(res.status).toBe(401);
    });

    test('returns 400 when no data provided', async () => {
        setupAuth();

        const res = await request(app)
            .put('/api/notes')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no data/i);
    });

    test('saves new notebook data successfully', async () => {
        setupAuth();
        // getNotebook: no existing notebook
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const notebook = { pages: [{ id: 'p1', title: 'My Page', content: '<p>Hello</p>' }] };

        const res = await request(app)
            .put('/api/notes')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ data: notebook });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(mockTransaction).toHaveBeenCalled();
    });

    test('saves notebook and skips history for unchanged pages', async () => {
        setupAuth();
        const existingNotebook = { pages: [{ id: 'p1', title: 'Same', content: '<p>Same</p>' }] };
        mockQuery.mockResolvedValueOnce({ rows: [{ data: JSON.stringify(existingNotebook) }], rowCount: 1 });

        const sameNotebook = { pages: [{ id: 'p1', title: 'Same', content: '<p>Same</p>' }] };

        const res = await request(app)
            .put('/api/notes')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ data: sameNotebook });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

// ─── GET /api/notes/history/:pageId ──────────────────────────────────────────

describe('GET /api/notes/history/:pageId', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/notes/history/page-1');
        expect(res.status).toBe(401);
    });

    test('returns empty array when no history', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/api/notes/history/page-1')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.history ?? res.body).toEqual([]);
    });

    test('returns history entries for a page', async () => {
        setupAuth();
        const historyRows = [
            { id: 10, page_title: 'My Page', saved_at: '2024-01-01T10:00:00Z' },
            { id: 9, page_title: 'My Page', saved_at: '2024-01-01T09:00:00Z' },
        ];
        mockQuery.mockResolvedValueOnce({ rows: historyRows, rowCount: 2 });

        const res = await request(app)
            .get('/api/notes/history/page-1')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        const items = res.body.history ?? res.body;
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe(10);
    });
});

describe('GET /api/notes/history/snapshot/:id', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/notes/history/snapshot/10');
        expect(res.status).toBe(401);
    });

    test('returns 404 for snapshot not owned by requester', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/api/notes/history/snapshot/10')
            .set('Cookie', authCookie());

        expect(res.status).toBe(404);
        const snapshotCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('FROM notebook_history WHERE id = $1 AND user_id = $2'));
        expect(snapshotCall).toBeTruthy();
        expect(snapshotCall[1][1]).toBe(1);
    });

    test('returns snapshot when owned by requester', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 10, page_id: 'p1', page_title: 'My Page', content: '<p>v1</p>', saved_at: '2024-01-01T10:00:00Z' }],
            rowCount: 1,
        });

        const res = await request(app)
            .get('/api/notes/history/snapshot/10')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.snapshot.id).toBe(10);
    });
});
