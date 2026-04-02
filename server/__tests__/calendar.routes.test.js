// Suppress pino logs during tests
jest.mock('../utils/logger', () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (req, res, next) => { req.id = 'test'; req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; next(); },
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

function setupAuth(role = 'employee', extra = {}) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
        .mockResolvedValueOnce({
            rows: [{
                role, org_id: 1, team_id: 1, department_id: 1,
                manager_id: null, is_active: true, ...extra,
            }],
            rowCount: 1,
        }); // loadUserContext
}

// ─── GET /api/calendar ────────────────────────────────────────────────────────
describe('GET /api/calendar', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .get('/api/calendar')
            .set(CSRF)
            .query({ from: '2026-03-01T00:00:00Z', to: '2026-03-08T00:00:00Z' });
        expect(res.status).toBe(401);
    });

    test('returns 400 when from/to params are missing', async () => {
        setupAuth();
        const res = await request(app)
            .get('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie());
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/from and to/i);
    });

    test('returns 400 when only from param is supplied', async () => {
        setupAuth();
        const res = await request(app)
            .get('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .query({ from: '2026-03-01T00:00:00Z' });
        expect(res.status).toBe(400);
    });

    test('returns events array for valid range', async () => {
        setupAuth();
        const fakeEvent = { id: 1, title: 'Team sync', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z', color: '#6366f1' };
        mockQuery.mockResolvedValueOnce({ rows: [fakeEvent], rowCount: 1 });

        const res = await request(app)
            .get('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .query({ from: '2026-03-01T00:00:00Z', to: '2026-03-08T00:00:00Z' });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].title).toBe('Team sync');
    });

    test('returns empty array when no events in range', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .query({ from: '2026-03-01T00:00:00Z', to: '2026-03-08T00:00:00Z' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

// ─── POST /api/calendar ───────────────────────────────────────────────────────
describe('POST /api/calendar', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .send({ title: 'Meeting', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z' });
        expect(res.status).toBe(401);
    });

    test('returns 400 when title is missing', async () => {
        setupAuth();
        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/title/i);
    });

    test('returns 400 when start_time is missing', async () => {
        setupAuth();
        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Meeting', end_time: '2026-03-04T10:00:00Z' });
        expect(res.status).toBe(400);
    });

    test('returns 400 when end_time is missing', async () => {
        setupAuth();
        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Meeting', start_time: '2026-03-04T09:00:00Z' });
        expect(res.status).toBe(400);
    });

    test('returns 400 when end_time is not after start_time', async () => {
        setupAuth();
        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Meeting', start_time: '2026-03-04T10:00:00Z', end_time: '2026-03-04T09:00:00Z' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/end_time must be after/i);
    });

    test('returns 400 when end_time equals start_time', async () => {
        setupAuth();
        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Meeting', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T09:00:00Z' });
        expect(res.status).toBe(400);
    });

    test('creates event with valid data', async () => {
        setupAuth();
        const created = { id: 42, title: 'Team sync', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z', color: '#6366f1', user_id: 1 };
        // First mock: event count check; second mock: INSERT
        mockQuery.mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [created], rowCount: 1 });

        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Team sync', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z' });
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(42);
        expect(res.body.title).toBe('Team sync');
    });

    test('creates event with optional fields (color, description, task_id)', async () => {
        setupAuth();
        const created = { id: 7, title: 'Review', description: 'PR review', color: '#10b981', task_id: 5, start_time: '2026-03-04T14:00:00Z', end_time: '2026-03-04T15:00:00Z' };
        // First mock: event count check; second mock: INSERT
        mockQuery.mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [created], rowCount: 1 });

        const res = await request(app)
            .post('/api/calendar')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Review', description: 'PR review', color: '#10b981', task_id: 5, start_time: '2026-03-04T14:00:00Z', end_time: '2026-03-04T15:00:00Z' });
        expect(res.status).toBe(200);
        expect(res.body.color).toBe('#10b981');
    });
});

// ─── PUT /api/calendar/:id ────────────────────────────────────────────────────
describe('PUT /api/calendar/:id', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .put('/api/calendar/1')
            .set(CSRF)
            .send({ title: 'Updated' });
        expect(res.status).toBe(401);
    });

    test('returns 404 when event does not exist or belongs to another user', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // event not found

        const res = await request(app)
            .put('/api/calendar/999')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Updated', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z' });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    test('returns 400 when end_time is before start_time on update', async () => {
        setupAuth();
        const existing = { id: 1, title: 'Old', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z', task_id: null };
        mockQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

        const res = await request(app)
            .put('/api/calendar/1')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ start_time: '2026-03-04T11:00:00Z', end_time: '2026-03-04T09:00:00Z' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/end_time must be after/i);
    });

    test('updates event with valid data', async () => {
        setupAuth();
        const existing = { id: 1, title: 'Old', start_time: '2026-03-04T09:00:00Z', end_time: '2026-03-04T10:00:00Z', task_id: null };
        const updated = { ...existing, title: 'Updated title' };
        mockQuery
            .mockResolvedValueOnce({ rows: [existing], rowCount: 1 }) // SELECT existing
            .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // UPDATE RETURNING

        const res = await request(app)
            .put('/api/calendar/1')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ title: 'Updated title' });
        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Updated title');
    });
});

// ─── DELETE /api/calendar/:id ─────────────────────────────────────────────────
describe('DELETE /api/calendar/:id', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .delete('/api/calendar/1')
            .set(CSRF);
        expect(res.status).toBe(401);
    });

    test('returns 404 when event does not exist or belongs to another user', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // nothing deleted

        const res = await request(app)
            .delete('/api/calendar/999')
            .set(CSRF)
            .set('Cookie', authCookie());
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    test('deletes event successfully', async () => {
        setupAuth();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

        const res = await request(app)
            .delete('/api/calendar/1')
            .set(CSRF)
            .set('Cookie', authCookie());
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/deleted/i);
    });
});
