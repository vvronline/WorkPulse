/** Distributed, tenant-aware HTTP rate limiters. */
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
import * as redis from "../../redis";

/**
 * Build a Redis-backed store; local/test environments without REDIS_URL use
 * express-rate-limit's MemoryStore.
 *
 * The Redis client is resolved lazily because limiters are constructed before
 * bootstrap() calls redis.initRedis(). Resolving it eagerly would permanently
 * pin every limiter to per-instance memory.
 */
function makeStore(prefix: string) {
    if (!process.env.REDIS_URL) return undefined;
    return new RedisStore({
        sendCommand: (...args: unknown[]) => {
            const client = redis.getClient();
            if (!client) return Promise.reject(new Error("Redis unavailable"));
            return (client as any).call(...args);
        },
        prefix: `rl:${prefix}:`,
    });
}

/** Create fresh limiters for each Express app instance. */
function createRateLimiters() {
    const { ipKeyGenerator } = rateLimit;
    const tenantKeyGen = (req: any) =>
        `${req.tenantId || "master"}:${ipKeyGenerator(req.ip || "")}`;
    const options = (prefix: string, max: number) => ({
        windowMs: 15 * 60 * 1000,
        max,
        store: makeStore(prefix),
        keyGenerator: tenantKeyGen,
        validate: { keyGeneratorIpFallback: false },
        // Never take the API down because the rate-limit backend hiccuped.
        passOnStoreError: true,
    });

    return {
        authLimiter: rateLimit({
            ...options("auth", 15),
            message: { error: "Too many attempts. Please try again later." },
        }),
        registerLimiter: rateLimit({
            ...options("reg", 10),
            message: { error: "Too many registration attempts. Please try again later." },
        }),
        forgotPasswordLimiter: rateLimit({
            ...options("fp", 5),
            message: { error: "Too many password reset attempts. Please try again later." },
        }),
        passwordLimiter: rateLimit({
            ...options("pw", 10),
            message: { error: "Too many password attempts. Please try again later." },
        }),
        apiLimiter: rateLimit({
            ...options("api", 5000),
            message: { error: "Too many requests. Please try again later." },
        }),
    };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
export { createRateLimiters };