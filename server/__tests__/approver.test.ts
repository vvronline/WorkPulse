export {};

// Suppress pino logs during tests
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
        debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
}));

const mockQuery: jest.Mock = jest.fn();
const mockTransaction: any = undefined;

jest.mock("../db", () => ({
    pool: { end: jest.fn() },
    query: (...args: any[]) => mockQuery(...args),

    masterQuery: (...args: any[]) => mockQuery(...args),

    masterTransaction: (fn: any) => fn({ query: (...a: any[]) => mockQuery(...a) }),
    initDB: jest.fn(),
}));

const { findApprover } = require("../utils/approver");

const mockDb = { query: (...args: any[]) => mockQuery(...args) };

describe("findApprover", () => {
    beforeEach(() => mockQuery.mockReset());

    test("returns direct manager when active", async () => {
        mockQuery
            // Step 0: get user
            .mockResolvedValueOnce({ rows: [{ manager_id: 5, team_id: 1, department_id: 1 }] })
            // Step 1: SELECT id FROM users WHERE id=5 AND is_active=TRUE
            .mockResolvedValueOnce({ rows: [{ id: 5 }] });

        const result = await findApprover(mockDb, 1, 1);
        expect(result).toEqual({ id: 5 });
    });

    test("skips inactive manager, falls to team lead", async () => {
        mockQuery
            // Step 0: get user
            .mockResolvedValueOnce({ rows: [{ manager_id: 5, team_id: 1, department_id: 1 }] })
            // Step 1: manager not active → empty
            .mockResolvedValueOnce({ rows: [] })
            // Step 2a: get team lead_id
            .mockResolvedValueOnce({ rows: [{ lead_id: 7 }] })
            // Step 2b: SELECT id FROM users WHERE id=7 AND is_active=TRUE
            .mockResolvedValueOnce({ rows: [{ id: 7 }] });

        const result = await findApprover(mockDb, 1, 1);
        expect(result).toEqual({ id: 7 });
    });

    test("skips self as team lead, falls to dept head", async () => {
        mockQuery
            // Step 0: get user — no manager
            .mockResolvedValueOnce({ rows: [{ manager_id: null, team_id: 1, department_id: 1 }] })
            // Step 2a: team lead is self (userId=1)
            .mockResolvedValueOnce({ rows: [{ lead_id: 1 }] })
            // Step 3a: dept head
            .mockResolvedValueOnce({ rows: [{ head_id: 9 }] })
            // Step 3b: head active
            .mockResolvedValueOnce({ rows: [{ id: 9 }] });

        const result = await findApprover(mockDb, 1, 1);
        expect(result).toEqual({ id: 9 });
    });

    test("falls to HR admin when no manager/lead/head", async () => {
        mockQuery
            // Step 0: get user
            .mockResolvedValueOnce({ rows: [{ manager_id: null, team_id: null, department_id: null }] })
            // Step 4: HR admin search
            .mockResolvedValueOnce({ rows: [{ id: 20 }] });

        const result = await findApprover(mockDb, 1, 1);
        expect(result).toEqual({ id: 20 });
    });

    test("returns null when no approver found and not super_admin", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ manager_id: null, team_id: null, department_id: null }] })
            // Step 4: no HR admin
            .mockResolvedValueOnce({ rows: [] })
            // Step 5: not super_admin
            .mockResolvedValueOnce({ rows: [] });

        const result = await findApprover(mockDb, 1, 1);
        expect(result).toBeNull();
    });

    test("super_admin self-approves as last resort", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ manager_id: null, team_id: null, department_id: null }] })
            .mockResolvedValueOnce({ rows: [] }) // no HR admin
            .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // self is super_admin

        const result = await findApprover(mockDb, 1, 1);
        expect(result).toEqual({ id: 1 });
    });

    test("returns null when no orgId before HR step", async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ manager_id: null, team_id: null, department_id: null }],
        });

        const result = await findApprover(mockDb, 1, null);
        expect(result).toBeNull();
    });
});