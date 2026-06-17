export {};

/**
 * Integration tests for WebSocket call action idempotency.
 * Verifies that duplicate call_accept / call_reject messages are deduplicated
 * via clientMsgId + the withIdempotentCallAction wrapper.
 */

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
        debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    logPushCallLifecycle: jest.fn(),
}));

const { withIdempotentCallAction, IdempotencyCache } = require("../utils/wsIdempotency");

describe("withIdempotentCallAction", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("wraps and dedupes call_accept with clientMsgId", async () => {
        const cache = new IdempotencyCache();
        const fn = jest.fn().mockResolvedValue("accepted");

        const result1 = await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 5,
                callId: 100,
                action: "answer",
                clientMsgId: "accept-1",
                cache,
            },
            fn,
        );

        const result2 = await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 5,
                callId: 100,
                action: "answer",
                clientMsgId: "accept-1",
                cache,
            },
            fn,
        );

        expect(result1).toBe("accepted");
        expect(result2).toBe("accepted");
        expect(fn).toHaveBeenCalledTimes(1); // dedupe works
    });

    test("dedupes call_reject with clientMsgId", async () => {
        const cache = new IdempotencyCache();
        const fn = jest.fn().mockResolvedValue("rejected");

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 6,
                callId: 101,
                action: "reject",
                clientMsgId: "reject-1",
                cache,
            },
            fn,
        );

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 6,
                callId: 101,
                action: "reject",
                clientMsgId: "reject-1",
                cache,
            },
            fn,
        );

        expect(fn).toHaveBeenCalledTimes(1);
    });

    test("different call IDs do not collide", async () => {
        const cache = new IdempotencyCache();
        const fn = jest.fn().mockResolvedValue("ok");

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 7,
                callId: 102,
                action: "answer",
                clientMsgId: "accept-2",
                cache,
            },
            fn,
        );

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 7,
                callId: 103, // different callId
                action: "answer",
                clientMsgId: "accept-2",
                cache,
            },
            fn,
        );

        expect(fn).toHaveBeenCalledTimes(2); // no collision
    });

    test("different actions do not collide", async () => {
        const cache = new IdempotencyCache();
        const fn = jest.fn().mockResolvedValue("ok");

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 8,
                callId: 104,
                action: "answer",
                clientMsgId: "action-1",
                cache,
            },
            fn,
        );

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 8,
                callId: 104,
                action: "reject", // different action
                clientMsgId: "action-1",
                cache,
            },
            fn,
        );

        expect(fn).toHaveBeenCalledTimes(2); // no collision
    });

    test("missing clientMsgId bypasses dedup (every call runs)", async () => {
        const cache = new IdempotencyCache();
        const fn = jest.fn().mockResolvedValue("ok");

        for (let i = 0; i < 3; i++) {
            await withIdempotentCallAction(
                {
                    tenantId: 1,
                    senderId: 9,
                    callId: 105,
                    action: "answer",
                    // no clientMsgId
                    cache,
                },
                fn,
            );
        }

        expect(fn).toHaveBeenCalledTimes(3); // all run — no dedup
    });

    test("generates fallback clientMsgId from call context", async () => {
        const cache = new IdempotencyCache();
        const fn = jest.fn().mockResolvedValue("ok");

        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 10,
                callId: 106,
                action: "end",
                // no explicit clientMsgId
                cache,
            },
            fn,
        );

        // Second call with same params should reuse the generated id
        await withIdempotentCallAction(
            {
                tenantId: 1,
                senderId: 10,
                callId: 106,
                action: "end",
                // no explicit clientMsgId
                cache,
            },
            fn,
        );

        // Both should hit the same generated key (deterministic from callId + senderId + action)
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
