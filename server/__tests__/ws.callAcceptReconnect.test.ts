export {};

/**
 * Integration-style tests for reconnect-time call_accept retries.
 *
 * Goal:
 * - A reconnect resend with the same clientMsgId must apply exactly once.
 * - A transient failure must not be cached (retry can still succeed).
 */

const { withIdempotentCallAction, IdempotencyCache } = require("../utils/wsIdempotency");

describe("call_accept reconnect retries", () => {
    test("dedupes repeated call_accept frames after reconnect", async () => {
        const cache = new IdempotencyCache();
        const applyAccept = jest.fn().mockResolvedValue("ok");

        await withIdempotentCallAction(
            {
                tenantId: 5,
                senderId: 21,
                callId: 9001,
                action: "answer",
                clientMsgId: "reconnect-accept-1",
                cache,
            },
            applyAccept,
        );

        // Reconnect replay of the same frame
        await withIdempotentCallAction(
            {
                tenantId: 5,
                senderId: 21,
                callId: 9001,
                action: "answer",
                clientMsgId: "reconnect-accept-1",
                cache,
            },
            applyAccept,
        );

        expect(applyAccept).toHaveBeenCalledTimes(1);
    });

    test("does not cache failures, allowing reconnect retry to succeed", async () => {
        const cache = new IdempotencyCache();
        const applyAccept = jest
            .fn()
            .mockRejectedValueOnce(new Error("transient db timeout"))
            .mockResolvedValueOnce("ok");

        await expect(
            withIdempotentCallAction(
                {
                    tenantId: 5,
                    senderId: 21,
                    callId: 9002,
                    action: "answer",
                    clientMsgId: "reconnect-accept-2",
                    cache,
                },
                applyAccept,
            ),
        ).rejects.toThrow("transient db timeout");

        // Same id on retry should execute again (error responses are not cached)
        await withIdempotentCallAction(
            {
                tenantId: 5,
                senderId: 21,
                callId: 9002,
                action: "answer",
                clientMsgId: "reconnect-accept-2",
                cache,
            },
            applyAccept,
        );

        expect(applyAccept).toHaveBeenCalledTimes(2);
    });

    test("native fallback key also dedupes reconnect retries", async () => {
        const cache = new IdempotencyCache();
        const applyAccept = jest.fn().mockResolvedValue("ok");

        await withIdempotentCallAction(
            {
                tenantId: 5,
                senderId: 21,
                callId: 9003,
                action: "answer",
                cache,
            },
            applyAccept,
        );

        await withIdempotentCallAction(
            {
                tenantId: 5,
                senderId: 21,
                callId: 9003,
                action: "answer",
                cache,
            },
            applyAccept,
        );

        expect(applyAccept).toHaveBeenCalledTimes(1);
    });
});
