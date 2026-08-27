/** Phase D: background jobs must never duplicate per production replica. */
export {};

jest.mock("../utils/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));
jest.mock("../redis", () => ({ getClient: () => null, isRedisReady: () => false }));
jest.mock("../utils/tenantManager", () => ({
    forEachTenant: jest.fn(), getTenantPool: jest.fn(), deleteTenant: jest.fn(),
}));
jest.mock("../db", () => ({ masterQuery: jest.fn() }));
jest.mock("../utils/ws", () => ({ sendToUser: jest.fn(), emitCallHistoryMessage: jest.fn() }));
jest.mock("../services/pushNotifications", () => ({ pushNotifications: {} }));
jest.mock("../services/chatMediaPipeline", () => ({ processChatMediaJob: jest.fn() }));

describe("production job fallback safety", () => {
    const old = process.env;
    beforeEach(() => {
        jest.resetModules();
        process.env = { ...old, NODE_ENV: "production", ROLE: "worker" };
    });
    afterAll(() => { process.env = old; });

    it("refuses setInterval fallback when Redis/BullMQ is unavailable", async () => {
        const { initJobs } = require("../jobs");
        await expect(initJobs({
            autoClockOut: jest.fn(),
            cleanupTokens: jest.fn(),
        })).rejects.toThrow(/refusing setInterval job fallback/);
    });
});