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

function authCookie(userId = 1, username = 'testuser') {
    const token = jwt.sign({ id: userId, username, tv: 0 }, SECRET, { expiresIn: '1h' });
    return `token=${token}`;
}

// The auth middleware checks token_version in DB, loadUserContext loads role
function setupAuthMocks(overrides = {}) {
    const defaults = {
        id: 1, username: 'testuser', role: 'employee', org_id: null,
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

describe('GET /api/tracker/status', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/tracker/status');
        expect(res.status).toBe(401);
    });

    test('returns logged_out state when no entries', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // time_entries query

        const res = await request(app)
            .get('/api/tracker/status')
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(200);
        expect(res.body.state).toBe('logged_out');
    });

    test('returns on_floor state after clock_in', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 }) // auth
            .mockResolvedValueOnce({
                rows: [{ entry_type: 'clock_in', timestamp: new Date().toISOString(), work_mode: 'office' }],
                rowCount: 1,
            });

        const res = await request(app)
            .get('/api/tracker/status')
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(200);
        expect(res.body.state).toBe('on_floor');
    });
});

describe('POST /api/tracker/clock-in', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/api/tracker/clock-in')
            .set(CSRF);
        expect(res.status).toBe(401);
    });

    test('succeeds when not clocked in', async () => {
        setupAuthMocks({ org_id: 1 });
        // org work_days query — include all days so test passes regardless of day-of-week
        mockQuery.mockResolvedValueOnce({ rows: [{ work_days: '0,1,2,3,4,5,6' }], rowCount: 1 });

        // transaction: last entry = clock_out (or empty) → allow
        mockTxClient.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no last entry
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT

        // update timezone
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/tracker/clock-in')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330')
            .send({ work_mode: 'office' });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged in/i);
    });

    test('returns 400 when already clocked in', async () => {
        setupAuthMocks({ org_id: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [{ work_days: '0,1,2,3,4,5,6' }], rowCount: 1 }); // org work_days

        mockTransaction.mockReset().mockImplementation(async () => ({ error: 'Already logged in. Logout first.' }));

        const res = await request(app)
            .post('/api/tracker/clock-in')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330')
            .send({ work_mode: 'office' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already/i);
    });
});

describe('POST /api/tracker/clock-out', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('succeeds when clocked in (last entry is clock_in)', async () => {
        // auth
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: 'clock_in' }], rowCount: 1 }) // last entry
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT clock_out

        const res = await request(app)
            .post('/api/tracker/clock-out')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/clocked out/i);
    });

    test('returns 400 when not clocked in', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTransaction.mockReset().mockImplementation(async () => ({ error: 'You are not logged in' }));

        const res = await request(app)
            .post('/api/tracker/clock-out')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not logged in/i);
    });

    test('returns 400 when still on break', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTransaction.mockReset().mockImplementation(async () => ({ error: 'You are still on break. End your break before clocking out.' }));

        const res = await request(app)
            .post('/api/tracker/clock-out')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/break/i);
    });
});

describe('POST /api/tracker/break-start', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('succeeds when on_floor', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: 'clock_in' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/tracker/break-start')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/break started/i);
    });

    test('returns 400 when not logged in', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
        mockTransaction.mockReset().mockImplementation(async () => ({ error: 'You must login first' }));

        const res = await request(app)
            .post('/api/tracker/break-start')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(400);
    });
});

describe('POST /api/tracker/break-end', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTxClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => fn(mockTxClient));
    });

    test('succeeds when on break', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });

        mockTxClient.query
            .mockResolvedValueOnce({ rows: [{ entry_type: 'break_start' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/tracker/break-end')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/break ended/i);
    });

    test('returns 400 when not on break', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
        mockTransaction.mockReset().mockImplementation(async () => ({ error: 'You are not on break' }));

        const res = await request(app)
            .post('/api/tracker/break-end')
            .set(CSRF)
            .set('Cookie', authCookie())
            .set('X-Timezone-Offset', '-330');
        expect(res.status).toBe(400);
    });
});
