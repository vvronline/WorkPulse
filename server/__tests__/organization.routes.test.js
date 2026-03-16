// Tests for /api/org — org CRUD, members, departments, teams

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

// ─── POST /api/org — create org ─────────────────────────────────

describe('POST /api/org', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/api/org')
            .set(CSRF)
            .send({ name: 'Acme Corp' });
        expect(res.status).toBe(401);
    });

    test('returns 403 for non-super_admin', async () => {
        setupAuth('hr_admin');

        const res = await request(app)
            .post('/api/org')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ name: 'Acme Corp' });

        expect(res.status).toBe(403);
    });

    test('returns 400 when name is missing', async () => {
        setupAuth('super_admin');

        const res = await request(app)
            .post('/api/org')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    test('returns 400 when similar org name already exists', async () => {
        setupAuth('super_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }); // slug conflict

        const res = await request(app)
            .post('/api/org')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ name: 'Existing Corp' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already exists/i);
    });

    test('creates a new organization', async () => {
        setupAuth('super_admin');
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no slug conflict
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 }); // INSERT org
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user role

        const res = await request(app)
            .post('/api/org')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ name: 'New Corp' });

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(10);
        expect(res.body.slug).toBe('new-corp');
    });
});

// ─── GET /api/org/current ──────────────────────────────────────

describe('GET /api/org/current', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 401 without auth', async () => {
        const res = await request(app).get('/api/org/current');
        expect(res.status).toBe(401);
    });

    test('returns null when user has no org', async () => {
        setupAuth('employee', { org_id: null });

        const res = await request(app)
            .get('/api/org/current')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
    });

    test('returns org data without counts for regular employee', async () => {
        setupAuth('employee');
        const org = { id: 1, name: 'Acme', slug: 'acme', memberCount: 50, deptCount: 5, teamCount: 10 };
        mockQuery.mockResolvedValueOnce({ rows: [org], rowCount: 1 });

        const res = await request(app)
            .get('/api/org/current')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        // Employee should not see member/dept/team counts
        expect(res.body.memberCount).toBeUndefined();
        expect(res.body.deptCount).toBeUndefined();
    });

    test('returns org data with counts for hr_admin', async () => {
        setupAuth('hr_admin');
        const org = { id: 1, name: 'Acme', slug: 'acme', memberCount: 50, deptCount: 5, teamCount: 10 };
        mockQuery.mockResolvedValueOnce({ rows: [org], rowCount: 1 });

        const res = await request(app)
            .get('/api/org/current')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.memberCount).toBe(50);
    });
});

// ─── GET /api/org/members ──────────────────────────────────────

describe('GET /api/org/members', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 for regular employee', async () => {
        setupAuth('employee');

        const res = await request(app)
            .get('/api/org/members')
            .set('Cookie', authCookie());

        expect(res.status).toBe(403);
    });

    test('returns members list for team_lead', async () => {
        setupAuth('team_lead');
        mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 }); // COUNT
        const members = [
            { id: 2, username: 'alice', full_name: 'Alice Smith', role: 'employee' },
            { id: 3, username: 'bob', full_name: 'Bob Jones', role: 'employee' },
        ];
        mockQuery.mockResolvedValueOnce({ rows: members, rowCount: 2 });

        const res = await request(app)
            .get('/api/org/members')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.total).toBe(3);
    });
});

// ─── POST /api/org/invite ───────────────────────────────────────

describe('POST /api/org/invite', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 for non-hr_admin', async () => {
        setupAuth('employee');

        const res = await request(app)
            .post('/api/org/invite')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ user_id: 5, role: 'employee' });

        expect(res.status).toBe(403);
    });

    test('returns 400 when user_id is missing', async () => {
        setupAuth('hr_admin');

        const res = await request(app)
            .post('/api/org/invite')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ role: 'employee' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    test('returns 404 when target user not found', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // user not found

        const res = await request(app)
            .post('/api/org/invite')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ user_id: 999, role: 'employee' });

        expect(res.status).toBe(404);
    });

    test('returns 400 when user already in an org', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, org_id: 2, role: 'employee', full_name: 'Bob' }], rowCount: 1 });

        const res = await request(app)
            .post('/api/org/invite')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ user_id: 5, role: 'employee' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already belongs/i);
    });

    test('successfully invites a user', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, org_id: null, role: 'employee', full_name: 'Alice' }], rowCount: 1 }); // target found, no org
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

        const res = await request(app)
            .post('/api/org/invite')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ user_id: 5, role: 'employee' });

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/Alice/);
    });
});

// ─── POST /api/org/remove-member ────────────────────────────────

describe('POST /api/org/remove-member', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 403 for non-hr_admin', async () => {
        setupAuth('employee');

        const res = await request(app)
            .post('/api/org/remove-member')
            .set('Cookie', authCookie())
            .set(CSRF)
            .send({ user_id: 5 });

        expect(res.status).toBe(403);
    });

    test('returns 400 when trying to remove yourself', async () => {
        setupAuth('hr_admin');
        // Target user is same as requester (id=1)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 1, role: 'employee', full_name: 'Self' }], rowCount: 1 });

        const res = await request(app)
            .post('/api/org/remove-member')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ user_id: 1 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cannot remove yourself/i);
    });

    test('successfully removes a member', async () => {
        setupAuth('hr_admin');
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, org_id: 1, role: 'employee', full_name: 'Alice' }], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

        const res = await request(app)
            .post('/api/org/remove-member')
            .set('Cookie', authCookie(1))
            .set(CSRF)
            .send({ user_id: 5 });

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/removed/i);
    });
});
