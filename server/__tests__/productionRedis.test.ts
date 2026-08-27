/** Phase D: Redis is mandatory for production correctness. */
export {};

jest.mock("../utils/logger", () => ({
    logger: { fatal: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe("production environment validation", () => {
    const old = process.env;
    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...old,
            NODE_ENV: "production",
            JWT_SECRET: "a-secure-production-secret-that-is-over-32-chars",
            STORAGE_DRIVER: "r2",
            R2_ACCOUNT_ID: "acct",
            R2_ACCESS_KEY_ID: "key",
            R2_SECRET_ACCESS_KEY: "secret",
        };
    });
    afterAll(() => { process.env = old; });

    it("fails when REDIS_URL is missing", () => {
        delete process.env.REDIS_URL;
        const { validateEnvironment } = require("../bootstrap/env");
        expect(() => validateEnvironment()).toThrow(/REDIS_URL is required/);
    });

    it("accepts a configured Redis URL", () => {
        process.env.REDIS_URL = "redis://example.invalid:6379";
        const { validateEnvironment } = require("../bootstrap/env");
        expect(() => validateEnvironment()).not.toThrow();
    });
});