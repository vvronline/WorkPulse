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

    it("fails startup when LiveKit is selected without credentials", () => {
        process.env.REDIS_URL = "redis://example.invalid:6379";
        process.env.CALL_MEDIA_BACKEND = "livekit";
        delete process.env.LIVEKIT_URL;
        delete process.env.LIVEKIT_API_KEY;
        delete process.env.LIVEKIT_API_SECRET;
        const { validateEnvironment } = require("../bootstrap/env");
        expect(() => validateEnvironment()).toThrow(
            /CALL_MEDIA_BACKEND=livekit requires/,
        );
    });

    it("fails startup when the LiveKit API secret is shorter than 32 characters", () => {
        process.env.REDIS_URL = "redis://example.invalid:6379";
        process.env.CALL_MEDIA_BACKEND = "livekit";
        process.env.LIVEKIT_URL = "wss://calls.example.test";
        process.env.LIVEKIT_API_KEY = "test-key";
        process.env.LIVEKIT_API_SECRET = "short-secret";
        const { validateEnvironment } = require("../bootstrap/env");
        expect(() => validateEnvironment()).toThrow(
            /LIVEKIT_API_SECRET must be at least 32 characters/,
        );
    });
});