/**
 * Tests for the GET /api/internal/ws-stats observability endpoint.
 * Verifies platform_admin guard and the response shape.
 */
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

const jwt = require('jsonwebtoken');
const request = require('supertest');

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTransaction = jest.fn(async (fn) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return fn(client);
});

jest.mock('../db', () => ({
    pool: { end: jest.fn() },
    query: (...args) => mockQuery(...args),
    masterQuery: (...args) => mockQuery(...args),
    masterTransaction: (...args) => mockTransaction(...args),
    transaction: (...args) => mockTransaction(...args),
    initDB: jest.fn(),
}));

const { app } = require('../index');
const wsMetrics = require('../utils/wsMetrics');

const SECRET = process.env.JWT_SECRET || 'test-secret';

function authCookie(userId = 1) {
    const token = jwt.sign({ id: userId, username: 'admin', tv: 0 }, SECRET, { expiresIn: '1h' });
    return `token=${token}`;
}

/**
 * The /api/internal router runs: authMiddleware → loadUserContext → requireRole.
 * authMiddleware needs ONE token-version row, loadUserContext needs ONE user
 * row containing the role. Anything after that is up to the handler — the
 * /ws-stats handler hits no DB, so two mocks is the full requirement.
 */
function setupAuth(role = 'platform_admin') {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ token_version: 0 }], rowCount: 1 })          // auth
        .mockResolvedValueOnce({                                                        // loadUserContext
            rows: [{
                role,
                org_id: 1,
                team_id: null,
                department_id: null,
                manager_id: null,
                is_active: true,
            }],
            rowCount: 1,
        });
}

describe('GET /api/internal/ws-stats', () => {
    beforeEach(() => {
        mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        wsMetrics.__resetForTests();
    });

    test('401 without auth cookie', async () => {
        const res = await request(app).get('/api/internal/ws-stats');
        expect(res.status).toBe(401);
    });

    test('403 for non-platform-admin users', async () => {
        setupAuth('hr_admin');
        const res = await request(app)
            .get('/api/internal/ws-stats')
            .set('Cookie', authCookie());
        expect(res.status).toBe(403);
    });

    test('200 with the expected payload shape for platform_admin', async () => {
        // Pre-populate the metrics with one fake invocation so the
        // handlers map is non-empty and we can assert on a real key.
        await wsMetrics.recordHandler('meeting_chat', 0, async () => 'ok');

        setupAuth('platform_admin');
        const res = await request(app)
            .get('/api/internal/ws-stats')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            instanceId: expect.any(String),
            handlers: expect.any(Object),
            totals: {
                count: expect.any(Number),
                errors: expect.any(Number),
                timeouts: expect.any(Number),
                errorRate: expect.any(Number),
            },
            windowSize: expect.any(Number),
            capturedAt: expect.any(String),
        });

        // The handler we recorded above should be in the snapshot.
        expect(res.body.handlers.meeting_chat).toMatchObject({
            count: 1,
            errors: 0,
            timeouts: 0,
            errorRate: 0,
            p50Ms: expect.any(Number),
            p95Ms: expect.any(Number),
        });
    });

    test('totals correctly reflect mixed success/error invocations', async () => {
        await wsMetrics.recordHandler('h1', 0, async () => { });
        await wsMetrics.recordHandler('h2', 0, async () => { throw new Error('x'); }).catch(() => { });
        await wsMetrics.recordHandler('h2', 0, async () => { });

        setupAuth('platform_admin');
        const res = await request(app)
            .get('/api/internal/ws-stats')
            .set('Cookie', authCookie());

        expect(res.status).toBe(200);
        expect(res.body.totals.count).toBe(3);
        expect(res.body.totals.errors).toBe(1);
        // 1 / 3 → 0.3333 after rounding to 4dp
        expect(res.body.totals.errorRate).toBeCloseTo(0.3333, 3);
    });
});