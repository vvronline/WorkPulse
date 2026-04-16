// Suppress pino logs during tests
jest.mock('../utils/logger', () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
}));

jest.mock('../db', () => ({
    pool: { end: jest.fn() },
    query: jest.fn(),
    masterQuery: jest.fn(),
    initDB: jest.fn(),
}));

const { sendCSV } = require('../utils/export');

function mockRes() {
    const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
    };
    return res;
}

describe('sendCSV', () => {
    test('sets Content-Type and Content-Disposition headers', () => {
        const res = mockRes();
        sendCSV(res, [{ name: 'Alice' }], ['name'], 'test.csv');
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
        expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="test.csv"');
    });

    test('sends CSV content', () => {
        const res = mockRes();
        sendCSV(res, [{ name: 'Alice', age: '30' }], ['name', 'age'], 'out.csv');
        expect(res.send).toHaveBeenCalled();
        const csv = res.send.mock.calls[0][0];
        expect(csv).toContain('name');
        expect(csv).toContain('Alice');
    });

    test('sanitizes formula injection characters in cell values', () => {
        const res = mockRes();
        sendCSV(res, [{ val: '=CMD()' }, { val: '+evil' }, { val: '@SUM(A1)' }], ['val'], 'safe.csv');
        const csv = res.send.mock.calls[0][0];
        // Should be prefixed with single-quote to prevent formula injection
        expect(csv).toContain("'=CMD()");
        expect(csv).toContain("'+evil");
        expect(csv).toContain("'@SUM(A1)");
    });

    test('leaves safe strings unchanged', () => {
        const res = mockRes();
        sendCSV(res, [{ val: 'Hello World' }], ['val'], 'ok.csv');
        const csv = res.send.mock.calls[0][0];
        expect(csv).toContain('Hello World');
        // Should NOT be prefixed
        expect(csv).not.toContain("'Hello World");
    });

    test('handles empty data', () => {
        const res = mockRes();
        sendCSV(res, [], ['col1'], 'empty.csv');
        expect(res.send).toHaveBeenCalled();
    });
});
