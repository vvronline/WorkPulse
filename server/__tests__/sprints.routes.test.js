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

    masterQuery: (...args) => mockQuery(...args),

    masterTransaction: (...args) => mockTransaction ? mockTransaction(...args) : (async (fn) => fn({ query: (...a) => mockQuery(...a) }))(...args),
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

function setupAuth(role = 'team_lead', extra = {}) {
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

describe('POST /api/sprints', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/api/sprints')
            .set(CSRF)
            .send({ name: 'Sprint 1', start_date: '2025-01-01', end_date: '2025-01-14' });
        expect(res.status).toBe(401);
    });

    test('returns 403 for non-team_lead role', async () => {
        setupAuth('employee');
        const res = await request(app)
            .post('/api/sprints')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ name: 'Sprint 1', start_date: '2025-01-01', end_date: '2025-01-14' });
        expect(res.status).toBe(403);
    });

    test('returns 400 when name is missing', async () => {
        setupAuth('team_lead');
        const res = await request(app)
            .post('/api/sprints')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ start_date: '2025-01-01', end_date: '2025-01-14' });
        expect(res.status).toBe(400);
    });

    test('returns 400 for invalid date format', async () => {
        setupAuth('team_lead');
        const res = await request(app)
            .post('/api/sprints')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ name: 'Sprint 1', start_date: '2025/01/01', end_date: '2025-01-14' });
        expect(res.status).toBe(400);
    });

    test('returns 400 for duplicate sprint name in team', async () => {
        setupAuth('team_lead');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }); // dup check
        const res = await request(app)
            .post('/api/sprints')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ name: 'Sprint 1', start_date: '2025-01-01', end_date: '2025-01-14' });
        expect(res.status).toBe(400);
    });

    test('creates sprint with valid data', async () => {
        setupAuth('team_lead');
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // dup check — no dup
            .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 }) // INSERT
            .mockResolvedValueOnce({
                rows: [{ id: 10, name: 'Sprint 1', status: 'planned', start_date: '2025-01-01', end_date: '2025-01-14', team_id: 1 }],
                rowCount: 1,
            }); // SELECT by id

        const res = await request(app)
            .post('/api/sprints')
            .set(CSRF)
            .set('Cookie', authCookie())
            .send({ name: 'Sprint 1', start_date: '2025-01-01', end_date: '2025-01-14' });
        expect(res.status).toBe(200);
    });
});

describe('GET /api/sprints', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/sprints');
        expect(res.status).toBe(401);
    });

    test('returns empty array when no team', async () => {
        // Auth passes but no team_id
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })
            .mockResolvedValueOnce({
                rows: [{ role: 'employee', org_id: 1, team_id: null, department_id: null, manager_id: null, is_active: true }],
                rowCount: 1,
            });
        const res = await request(app)
            .get('/api/sprints')
            .set('Cookie', authCookie());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ sprints: [] });
    });
});

describe('DELETE /api/sprints/:id', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('returns 403 for non-team_lead', async () => {
        setupAuth('employee');
        const res = await request(app)
            .delete('/api/sprints/1')
            .set(CSRF)
            .set('Cookie', authCookie());
        expect(res.status).toBe(403);
    });
});
