export {};

/**
 * Pure-function tests for wsIdempotency. The module is intentionally
 * side-effect free apart from its internal LRU which we reset between
 * tests via the test-only hook.
 */
const { withIdempotency, IdempotencyCache, defaultCache } = require("../utils/wsIdempotency");

describe("wsIdempotency", () => {
    beforeEach(() => {
        defaultCache._resetForTests();
    });

    describe("withIdempotency wrapper", () => {
        test("runs the fn the first time and returns its result", async () => {
            const fn = jest.fn().mockResolvedValue("ok-1");
            const out = await withIdempotency(
                { tenantId: 1, senderId: 7, type: "meeting_raise_hand", clientMsgId: "a" },
                fn
            );
            expect(out).toBe("ok-1");
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test("replays the cached result on a second call with the same id", async () => {
            const fn = jest.fn().mockResolvedValue("ok-1");
            await withIdempotency(
                { tenantId: 1, senderId: 7, type: "meeting_raise_hand", clientMsgId: "a" },
                fn
            );
            const out = await withIdempotency(
                { tenantId: 1, senderId: 7, type: "meeting_raise_hand", clientMsgId: "a" },
                fn
            );
            expect(out).toBe("ok-1");
            expect(fn).toHaveBeenCalledTimes(1); // still only ran once
        });

        test("different (tenantId, senderId, type, clientMsgId) tuples never collide", async () => {
            const fn = jest.fn().mockResolvedValue("ok");
            await withIdempotency({ tenantId: 1, senderId: 1, type: "t", clientMsgId: "a" }, fn);
            await withIdempotency({ tenantId: 2, senderId: 1, type: "t", clientMsgId: "a" }, fn); // diff tenant
            await withIdempotency({ tenantId: 1, senderId: 2, type: "t", clientMsgId: "a" }, fn); // diff sender
            await withIdempotency({ tenantId: 1, senderId: 1, type: "u", clientMsgId: "a" }, fn); // diff type
            await withIdempotency({ tenantId: 1, senderId: 1, type: "t", clientMsgId: "b" }, fn); // diff id
            expect(fn).toHaveBeenCalledTimes(5);
        });

        test("missing / falsy clientMsgId bypasses dedupe completely", async () => {
            const fn = jest.fn().mockResolvedValue("ok");
            for (const id of [undefined, null, "", 0]) {
                // eslint-disable-next-line no-await-in-loop
                await withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: id }, fn);
            }
            // Every call ran — no cache key was eligible.
            expect(fn).toHaveBeenCalledTimes(4);
        });

        test("clientMsgId longer than 64 chars is ignored (treated as missing)", async () => {
            const longId = "x".repeat(65);
            const fn = jest.fn().mockResolvedValue("ok");
            await withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: longId }, fn);
            await withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: longId }, fn);
            // Both ran — overlong ids are refused so retries always re-execute.
            expect(fn).toHaveBeenCalledTimes(2);
        });

        test("throws from the wrapped fn are NOT cached — retry gets a fresh world", async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error("first transient"))
                .mockResolvedValueOnce("ok-second");
            await expect(
                withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: "r" }, fn)
            ).rejects.toThrow("first transient");
            // Second call same id should re-run the fn (the first error wasn't cached).
            const out = await withIdempotency(
                { tenantId: 1, senderId: 1, type: "x", clientMsgId: "r" }, fn
            );
            expect(out).toBe("ok-second");
            expect(fn).toHaveBeenCalledTimes(2);
        });

        test("undefined results are cached so the retry still skips the fn", async () => {
            const fn = jest.fn().mockResolvedValue(undefined);
            await withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: "u" }, fn);
            await withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: "u" }, fn);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test("throws TypeError if fn is not a function", async () => {
            await expect(
                withIdempotency({ tenantId: 1, senderId: 1, type: "x", clientMsgId: "a" }, null)
            ).rejects.toThrow(TypeError);
        });
    });

    describe("IdempotencyCache", () => {
        test("evicts the oldest entry when full", () => {
            const cache = new IdempotencyCache({ maxEntries: 3, ttlMs: 60_000 });
            cache.set("a", 1);
            cache.set("b", 2);
            cache.set("c", 3);
            cache.set("d", 4);                            // overflow → evicts 'a'
            expect(cache.get("a")).toBeUndefined();
            expect(cache.get("b")).toBe(2);
            expect(cache.snapshot().evictions).toBe(1);
        });

        test("LRU touch moves an entry to the tail so it survives eviction", () => {
            const cache = new IdempotencyCache({ maxEntries: 3, ttlMs: 60_000 });
            cache.set("a", 1);
            cache.set("b", 2);
            cache.set("c", 3);
            cache.get("a");                               // touch
            cache.set("d", 4);                            // should now evict 'b' (oldest)
            expect(cache.get("a")).toBe(1);
            expect(cache.get("b")).toBeUndefined();
        });

        test("expired entries return undefined and are pruned", () => {
            const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 5 });
            cache.set("a", 1);
            // Force expiry by waiting past the TTL.
            return new Promise<void>((resolve) => setTimeout(() => {
                expect(cache.get("a")).toBeUndefined();
                resolve();
            }, 20));
        });

        test("snapshot reports size + hit-rate accurately", () => {
            const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 });
            cache.set("a", 1);
            cache.get("a");
            cache.get("a");
            cache.get("b"); // miss
            const s = cache.snapshot();
            expect(s.size).toBe(1);
            expect(s.hits).toBe(2);
            expect(s.misses).toBe(1);
            expect(s.hitRate).toBeCloseTo(0.6667, 3);
        });
    });
});