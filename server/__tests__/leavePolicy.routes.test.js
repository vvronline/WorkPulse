// Tests for /api/leave-policy — policies CRUD, holidays CRUD, balances

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

function setupAuth(role = 'employee', extra = {}) {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ role, org_id: 1, team_id: 1, department_id: 1, manager_id: null, is_active: true, ...extra }], rowCount: 1 });
}

// ─── GET /api/leave-policy/policies ──────────────────────────────────────

describe('GET /api/leave-policy/policies', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/leave-policy/policies');
        expect(res.status).toBe(401);
    });

    test('returns 403 when user has no org', async () => {
        setupAuth('employee', { org_id: null });

        const res = await request(app)
            .get('/api/leave-policy/policies')
            .set('Cookie', authCookie());

        expect(res.status).toBe(403);
    });

    test('returns leave policies list for org member', async () => {
        setupAuth('employee');
        const policies = [
            { id: 1, leave_type: 'Annual', annual_quota: 20, accrual_type: 'annual' },
            { id: 2, leave_type: 'Sick', annual_quota: 10, accrual_type: 'monthly' },
        ];
        mockQuery.mockResolvedValueOnce({ rows: policies, rowCount: 2 });

        const res = await request(app)
            .get('/api/leave-policy/policies')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(res.body[0].leave_type).toBe('Annual');
    });
});

// ─── POST /api/leave-policy/policies ─────────────────────────────────────

describe('POST /api/leave-policy/policies', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 for non-hr_admin', async () => {
        setupAuth('employee');

        const res = await request(app)
            .post('/api/leave-policy/policies')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ leave_type: 'Paternity', annual_quota: 7 });

        expect(res.status).toBe(403);
    });

    test('returns 400 when leave_type is missing', async () => {
        setupAuth('hr_admin');

        const res = await request(app)
            .post('/api/leave-policy/policies')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ annual_quota: 20 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    test('creates a new leave policy', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no existing policy
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 }); // INSERT RETURNING

        const res = await request(app)
            .post('/api/leave-policy/policies')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ leave_type: 'Annual', annual_quota: 20, accrual_type: 'annual' });

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(10);
    });

    test('updates existing leave policy when leave_type already exists', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }); // existing policy found
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

        const res = await request(app)
            .post('/api/leave-policy/policies')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ leave_type: 'Annual', annual_quota: 25 });

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/updated/i);
    });

    test('returns 400 when annual_quota exceeds 365', async () => {
        setupAuth('hr_admin');

        const res = await request(app)
            .post('/api/leave-policy/policies')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ leave_type: 'Unlimited', annual_quota: 400 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/between 0 and 365/i);
    });
});

// ─── DELETE /api/leave-policy/policies/:id ────────────────────────────────

describe('DELETE /api/leave-policy/policies/:id', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 for non-hr_admin', async () => {
        setupAuth('employee');

        const res = await request(app)
            .delete('/api/leave-policy/policies/1')
            .set('Cookie', authCookie())
            .set(CSRF);

        expect(res.status).toBe(403);
    });

    test('returns 404 when policy not found in org', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // policy not found

        const res = await request(app)
            .delete('/api/leave-policy/policies/99')
            .set('Cookie', authCookie())
            .set(CSRF);

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    test('deletes a leave policy', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 3, leave_type: 'Annual' }], rowCount: 1 }); // found
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE

        const res = await request(app)
            .delete('/api/leave-policy/policies/3')
            .set('Cookie', authCookie())
            .set(CSRF);

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/deleted/i);
    });
});

// ─── GET /api/leave-policy/holidays ──────────────────────────────────────

describe('GET /api/leave-policy/holidays', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 when user has no org', async () => {
        setupAuth('employee', { org_id: null });

        const res = await request(app)
            .get('/api/leave-policy/holidays')
            .set('Cookie', authCookie());

        expect(res.status).toBe(403);
    });

    test('returns holidays for the org', async () => {
        setupAuth('employee');
        const holidays = [
            { id: 1, date: '2024-12-25', name: 'Christmas', is_optional: false },
            { id: 2, date: '2024-01-01', name: 'New Year', is_optional: false },
        ];
        mockQuery.mockResolvedValueOnce({ rows: holidays, rowCount: 2 });

        const res = await request(app)
            .get('/api/leave-policy/holidays')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
    });
});

// ─── POST /api/leave-policy/holidays ─────────────────────────────────────

describe('POST /api/leave-policy/holidays', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 for non-hr_admin', async () => {
        setupAuth('employee');

        const res = await request(app)
            .post('/api/leave-policy/holidays')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ date: '2024-12-25', name: 'Christmas' });

        expect(res.status).toBe(403);
    });

    test('returns 400 when date or name is missing', async () => {
        setupAuth('hr_admin');

        const res = await request(app)
            .post('/api/leave-policy/holidays')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ date: '2024-12-25' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    test('creates a holiday', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 }); // INSERT RETURNING

        const res = await request(app)
            .post('/api/leave-policy/holidays')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ date: '2024-12-25', name: 'Christmas', is_optional: false });

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(7);
    });
});
