export {};

/**
 * Integration-style tests for duplicate invite/action dedupe behaviour.
 *
 * Covers:
 * - Duplicate call_initiate replay with same clientMsgId
 * - Distinct invites with distinct ids
 * - Call action dedupe isolation by callId
 */

const { withIdempotency, withIdempotentCallAction, IdempotencyCache } = require("../utils/wsIdempotency");

describe("call duplicate invite/action dedupe", () => {
    test("dedupes duplicate call_initiate with same clientMsgId", async () => {
        const cache = new IdempotencyCache();
        const initiate = jest.fn().mockResolvedValue({ callId: 7001 });

        const params = {
            tenantId: 9,
            senderId: 42,
            type: "call_initiate",
            clientMsgId: "invite-dup-1",
            cache,
        };

        await withIdempotency(params, initiate);
        await withIdempotency(params, initiate);

        expect(initiate).toHaveBeenCalledTimes(1);
    });

    test("does not dedupe call_initiate with different clientMsgIds", async () => {
        const cache = new IdempotencyCache();
        const initiate = jest.fn().mockResolvedValue({ ok: true });

        await withIdempotency(
            {
                tenantId: 9,
                senderId: 42,
                type: "call_initiate",
                clientMsgId: "invite-1",
                cache,
            },
            initiate,
        );

        await withIdempotency(
            {
                tenantId: 9,
                senderId: 42,
                type: "call_initiate",
                clientMsgId: "invite-2",
                cache,
            },
            initiate,
        );

        expect(initiate).toHaveBeenCalledTimes(2);
    });

    test("call actions are deduped per callId even with identical clientMsgId", async () => {
        const cache = new IdempotencyCache();
        const applyAction = jest.fn().mockResolvedValue("ok");

        await withIdempotentCallAction(
            {
                tenantId: 9,
                senderId: 42,
                callId: 7101,
                action: "answer",
                clientMsgId: "same-client-id",
                cache,
            },
            applyAction,
        );

        await withIdempotentCallAction(
            {
                tenantId: 9,
                senderId: 42,
                callId: 7102,
                action: "answer",
                clientMsgId: "same-client-id",
                cache,
            },
            applyAction,
        );

        expect(applyAction).toHaveBeenCalledTimes(2);
    });
});
