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

const bcrypt = require('bcryptjs');
const request = require('supertest');

// Mock DB
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTransaction = jest.fn(async (fn) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return fn(client);
});

jest.mock('../db', () => ({
    pool: { end: jest.fn() },
    query: (...args) => mockQuery(...args),
    transaction: (...args) => mockTransaction(...args),
    initDB: jest.fn(),
}));

const { app } = require('../index');

const CSRF = { 'X-Requested-With': 'WorkPulse' };

describe('POST /api/auth/register', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mockTransaction.mockReset().mockImplementation(async (fn) => {
            const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 42 }], rowCount: 1 }) };
            return fn(client);
        });
    });

    test('returns 400 when required fields are missing', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .set(CSRF)
            .send({ username: 'test' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    test('returns 400 for invalid email', async () => {
        // registration mode = open
        mockQuery.mockResolvedValueOnce({ rows: [{ value: 'open' }], rowCount: 1 });
        const res = await request(app)
            .post('/api/auth/register')
            .set(CSRF)
            .send({ username: 'testuser', password: 'Password1!', full_name: 'Test User', email: 'bad-email' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/email/i);
    });

    test('returns 400 for duplicate username', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ value: 'open' }], rowCount: 1 }) // registration mode
            .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existing user
        const res = await request(app)
            .post('/api/auth/register')
            .set(CSRF)
            .send({ username: 'taken', password: 'Password1!', full_name: 'Test', email: 'test@example.com' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/username/i);
    });

    test('returns 403 when registration is closed', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ value: 'closed' }], rowCount: 1 });
        const res = await request(app)
            .post('/api/auth/register')
            .set(CSRF)
            .send({ username: 'newuser', password: 'Password1!', full_name: 'New User', email: 'new@example.com' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/closed/i);
    });

    test('succeeds with valid data and sets cookie', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ value: 'open' }], rowCount: 1 }) // registration mode
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no existing user
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no existing email

        const res = await request(app)
            .post('/api/auth/register')
            .set(CSRF)
            .send({ username: 'newuser', password: 'Password1!', full_name: 'New User', email: 'new@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.user).toBeDefined();
        expect(res.body.user.username).toBe('newuser');
        expect(res.headers['set-cookie']).toBeDefined();
        expect(res.headers['set-cookie'][0]).toMatch(/token=/);
    });
});

describe('POST /api/auth/login', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    });

    test('returns 400 when username or password is missing', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .set(CSRF)
            .send({ username: 'test' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    test('returns 401 for non-existent user', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await request(app)
            .post('/api/auth/login')
            .set(CSRF)
            .send({ username: 'noone', password: 'Password1!' });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid/i);
    });

    test('returns 401 for wrong password', async () => {
        const hash = await bcrypt.hash('CorrectPass1!', 10);
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 1, username: 'john', password: hash, full_name: 'John',
                is_active: true, failed_login_attempts: 0, role: 'employee',
            }],
            rowCount: 1,
        });
        const res = await request(app)
            .post('/api/auth/login')
            .set(CSRF)
            .send({ username: 'john', password: 'WrongPass1!' });
        expect(res.status).toBe(401);
    });

    test('returns 200 with user data and cookie on valid login', async () => {
        const hash = await bcrypt.hash('CorrectPass1!', 10);
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 1, username: 'john', password: hash, full_name: 'John Doe',
                    email: 'john@example.com', avatar: null, is_active: true,
                    failed_login_attempts: 0, role: 'employee', org_id: null,
                    token_version: 0,
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no reports

        const res = await request(app)
            .post('/api/auth/login')
            .set(CSRF)
            .send({ username: 'john', password: 'CorrectPass1!' });
        expect(res.status).toBe(200);
        expect(res.body.user.username).toBe('john');
        expect(res.body.user.full_name).toBe('John Doe');
        expect(res.headers['set-cookie']).toBeDefined();
    });

    test('returns 403 for deactivated user', async () => {
        const hash = await bcrypt.hash('Password1!', 10);
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 1, username: 'disabled', password: hash, full_name: 'Disabled',
                is_active: false, failed_login_attempts: 0,
            }],
            rowCount: 1,
        });
        const res = await request(app)
            .post('/api/auth/login')
            .set(CSRF)
            .send({ username: 'disabled', password: 'Password1!' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/deactivated/i);
    });

    test('returns 423 for locked account', async () => {
        const hash = await bcrypt.hash('Password1!', 10);
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 1, username: 'locked', password: hash, full_name: 'Locked',
                is_active: true, failed_login_attempts: 5,
                locked_until: new Date(Date.now() + 600000).toISOString(),
            }],
            rowCount: 1,
        });
        const res = await request(app)
            .post('/api/auth/login')
            .set(CSRF)
            .send({ username: 'locked', password: 'Password1!' });
        expect(res.status).toBe(423);
        expect(res.body.error).toMatch(/locked/i);
    });
});

describe('POST /api/auth/logout', () => {
    test('clears the token cookie', async () => {
        const res = await request(app)
            .post('/api/auth/logout')
            .set(CSRF);
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/logged out/i);
        const cookies = res.headers['set-cookie'];
        expect(cookies).toBeDefined();
        // Cookie should be expired/cleared
        expect(cookies[0]).toMatch(/token=/);
    });
});
