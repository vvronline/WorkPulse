// Set required environment variables before any module loads
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

// Mock tenant resolution middleware so it passes through to the mocked db module.
// Each test file mocks ../db with its own mockQuery; resolveTenant would otherwise
// fail because it calls masterQuery / getTenantPool which are not mocked.
jest.mock('./middleware/tenant', () => ({
    resolveTenant: (req, _res, next) => {
        const db = require('./db');
        req.tenant = null;
        req.isMasterRoute = true;
        req.tenantId = null;
        req.db = {
            query: (...args) => db.query(...args),
            transaction: (...args) => db.transaction(...args),
            pool: db.pool,
        };
        next();
    },
    requireTenant: (req, _res, next) => next(),
    requireFeature: () => (req, _res, next) => next(),
    checkUserLimit: (req, _res, next) => next(),
    invalidateTenantCache: jest.fn(),
}));

// Mock tenantManager so modules that import it don't try to connect to real DBs
jest.mock('./utils/tenantManager', () => ({
    getTenantPool: jest.fn(),
    getTenantById: jest.fn(),
    listActiveTenants: jest.fn().mockResolvedValue([]),
    destroyAllPools: jest.fn(),
    suspendTenant: jest.fn(),
    reactivateTenant: jest.fn(),
    provisionTenant: jest.fn(),
}));

// Mock the collaboration module — it pulls in @hocuspocus/server which ships
// as ESM and breaks Jest's CommonJS loader. The notes route only uses
// `handleMention`, so a tiny stub is enough for tests.
jest.mock('./utils/collaboration', () => ({
    setupCollaborationServer: jest.fn(),
    handleMention: jest.fn().mockResolvedValue(undefined),
}));
