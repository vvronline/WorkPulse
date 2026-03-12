const jwt = require('jsonwebtoken');

// Ensure JWT_SECRET is set before middleware is loaded
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';

// Test auth middleware in isolation
jest.mock('../utils/logger', () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
}));

const mockQuery = jest.fn();
jest.mock('../db', () => ({
    query: (...args) => mockQuery(...args),
}));

const authMiddleware = require('../middleware/auth');
const { canManageUser } = require('../middleware/rbac');

const SECRET = process.env.JWT_SECRET || 'test-secret';

function mockReqRes(cookie) {
    const req = { cookies: { token: cookie } };
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    return { req, res, next };
}

describe('authMiddleware', () => {
    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('returns 401 when no token cookie', async () => {
        const { req, res, next } = mockReqRes(undefined);
        await authMiddleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/no token/i) }));
        expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for malformed token', async () => {
        const { req, res, next } = mockReqRes('not-a-jwt');
        await authMiddleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for expired token', async () => {
        const expired = jwt.sign({ id: 1, username: 'test', tv: 0 }, SECRET, { expiresIn: '-1s' });
        const { req, res, next } = mockReqRes(expired);
        await authMiddleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/expired/i) }));
    });

    test('returns 401 when user no longer exists', async () => {
        const token = jwt.sign({ id: 999, username: 'ghost', tv: 0 }, SECRET, { expiresIn: '1h' });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const { req, res, next } = mockReqRes(token);
        await authMiddleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/no longer exists/i) }));
    });

    test('returns 401 when token_version mismatch (password was changed)', async () => {
        const token = jwt.sign({ id: 1, username: 'test', tv: 0 }, SECRET, { expiresIn: '1h' });
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }], rowCount: 1 }); // version bumped
        const { req, res, next } = mockReqRes(token);
        await authMiddleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/session expired/i) }));
    });

    test('calls next() and sets req.userId on valid token', async () => {
        const token = jwt.sign({ id: 42, username: 'alice', tv: 0 }, SECRET, { expiresIn: '1h' });
        mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 });
        const { req, res, next } = mockReqRes(token);
        await authMiddleware(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.userId).toBe(42);
        expect(req.username).toBe('alice');
    });
});

describe('canManageUser (RBAC)', () => {
    test('super_admin can manage hr_admin', () => {
        expect(canManageUser('super_admin', 'hr_admin')).toBe(true);
    });

    test('hr_admin can manage manager', () => {
        expect(canManageUser('hr_admin', 'manager')).toBe(true);
    });

    test('manager cannot manage hr_admin', () => {
        expect(canManageUser('manager', 'hr_admin')).toBe(false);
    });

    test('employee cannot manage employee (same level)', () => {
        expect(canManageUser('employee', 'employee')).toBe(false);
    });

    test('team_lead can manage employee', () => {
        expect(canManageUser('team_lead', 'employee')).toBe(true);
    });

    test('employee cannot manage team_lead', () => {
        expect(canManageUser('employee', 'team_lead')).toBe(false);
    });
});
