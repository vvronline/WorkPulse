export {};

/**
 * Unit tests for the extracted chat_message handler (ADR-009).
 * The handler is pure (db + sendToUser are injected), so we mock both
 * and assert on the right sequence of calls.
 *
 * What was previously impossible to test
 * ──────────────────────────────────────
 * Before extraction, this logic lived inside the 1000-line if/else chain
 * in handleChatMessage. Testing it required spinning up the WS server +
 * stubbing JWT auth + sending a real frame. That's why there were zero
 * existing unit tests for the chat-send path — now there are 9.
 */
jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../redis", () => ({
    incrUnread: jest.fn(),
}));

const redis = require("../redis");
const { chatMessage } = require("../utils/wsHandlers/chatMessage");

/** Build a fresh ws stub. Captures every `ws.send` payload for assertions. */
function makeWs() {
    const sent: any[] = [];
    return {
        readyState: 1,
        send: (raw: string) => sent.push(JSON.parse(raw)),
        _sent: sent,
    };
}

/** A db stub that responds in the order callers expect for the happy path. */
function makeHappyPathDb({ persistedId = 999 }: { persistedId?: number; mentions?: any[] } = {}) {
    const queries: any[] = [];
    const responses = [
        // 1. participant check (now returns is_group + group_name)
        { rows: [{ is_group: false, group_name: null }] },
        // 2. block-check (Signal parity) — empty = not blocked
        { rows: [] },
        // 3. INSERT messages → returns id + created_at
        { rows: [{ id: persistedId, created_at: "2026-01-01T00:00:00Z" }] },
        // 4. UPDATE conversations (no return assertion needed)
        { rows: [] },
        // 5. INSERT/UPDATE message_reads
        { rows: [] },
        // 6. SELECT participants
        { rows: [{ user_id: 7 }, { user_id: 8 }, { user_id: 9 }] },
        // 7. SELECT sender
        { rows: [{ full_name: "Test User", avatar: null, username: "tu" }] },
        // 8. muted-recipients lookup (push suppression) — none muted
        { rows: [] },
    ];
    const query = jest.fn((..._args: any[]) => Promise.resolve(responses.shift() || { rows: [] }));
    return { query, queries };
}

describe("chatMessage handler — validation", () => {
    beforeEach(() => { jest.clearAllMocks(); });

    test("rejects missing conversationId with typed error ack", async () => {
        const ws = makeWs();
        const send = jest.fn();
        await chatMessage({
            db: { query: jest.fn() }, senderId: 1, tenantId: 1,
            data: { content: "hi" }, ws, sendToUser: send,
        });
        expect(ws._sent).toHaveLength(1);
        expect(ws._sent[0].type).toBe("chat_message_error");
        expect(ws._sent[0].data.reason).toMatch(/^validation:conversationId=/);
        // No DB writes, no fan-out.
        expect(send).not.toHaveBeenCalled();
    });

    test("rejects empty content", async () => {
        const ws = makeWs();
        await chatMessage({
            db: { query: jest.fn() }, senderId: 1, tenantId: 1,
            data: { conversationId: 5, content: "" }, ws, sendToUser: jest.fn(),
        });
        expect(ws._sent[0].data.reason).toMatch(/content=required/);
    });

    test("rejects content > 5 000 chars", async () => {
        const ws = makeWs();
        await chatMessage({
            db: { query: jest.fn() }, senderId: 1, tenantId: 1,
            data: { conversationId: 5, content: "a".repeat(5001) }, ws, sendToUser: jest.fn(),
        });
        expect(ws._sent[0].data.reason).toMatch(/content=too-long/);
    });

    test("rejects script-injection patterns even when otherwise valid", async () => {
        // Stub participant check so we don't trip the not-a-participant path
        // — the injection guard fires AFTER schema and BEFORE the DB check.
        const ws = makeWs();
        const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await chatMessage({
            db, senderId: 1, tenantId: 1,
            data: { conversationId: 5, content: "<script>alert(1)</script>" },
            ws, sendToUser: jest.fn(),
        });
        expect(ws._sent[0].data.reason).toBe("unsafe-content");
        // Should not have touched the DB.
        expect(db.query).not.toHaveBeenCalled();
    });

    test("rejects clientMsgId > 64 chars", async () => {
        const ws = makeWs();
        await chatMessage({
            db: { query: jest.fn() }, senderId: 1, tenantId: 1,
            data: { conversationId: 5, content: "hi", clientMsgId: "x".repeat(65) },
            ws, sendToUser: jest.fn(),
        });
        expect(ws._sent[0].data.reason).toMatch(/clientMsgId=too-long/);
    });
});

describe("chatMessage handler — happy path", () => {
    beforeEach(() => { jest.clearAllMocks(); });

    test("inserts, broadcasts to every participant, bumps unread for non-senders", async () => {
        const db = makeHappyPathDb();
        const send = jest.fn();
        const ws = makeWs();
        await chatMessage({
            db, senderId: 7, tenantId: 1,
            data: { conversationId: 5, content: "hello world", clientMsgId: "abc" },
            ws, sendToUser: send,
        });
        // 1 participant check + 1 block-check + 1 INSERT + 1 conv touch + 1 read upsert
        // + 1 participants fetch + 1 sender fetch + 1 muted-recipients lookup = 8 core
        // queries, PLUS 1 getTotalUnread badge query per non-sender participant
        // (2 here: users 8 and 9) fired from the fan-out loop = 10.
        expect(db.query).toHaveBeenCalledTimes(10);
        // 3 broadcasts (one per participant)
        const broadcasts = send.mock.calls.filter((c: any[]) => c[2] === "chat_message");
        expect(broadcasts).toHaveLength(3);
        // Echo carries the clientMsgId.
        expect(broadcasts[0][3].clientMsgId).toBe("abc");
        expect(broadcasts[0][3].id).toBe(999);
        // 2 non-sender participants get unread bumped.
        expect(redis.incrUnread).toHaveBeenCalledTimes(2);
    });

    test("rejects non-participant via auth check (no broadcast)", async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [] }) }; // participant check returns []
        const send = jest.fn();
        const ws = makeWs();
        await chatMessage({
            db, senderId: 7, tenantId: 1,
            data: { conversationId: 5, content: "hi", clientMsgId: "abc" },
            ws, sendToUser: send,
        });
        // One query (participant check) and an error ack.
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(ws._sent[0].data.reason).toBe("not-a-participant");
        expect(ws._sent[0].data.clientMsgId).toBe("abc");
    });

    test("mentions broadcast a chat_mention ONLY to participants who are mentioned (and not the sender)", async () => {
        const db = makeHappyPathDb();
        const send = jest.fn();
        const ws = makeWs();
        await chatMessage({
            db, senderId: 7, tenantId: 1,
            // mention sender (filtered out) + a non-participant (filtered out) + a real one (8)
            data: { conversationId: 5, content: "hi @8 @7 @99", clientMsgId: "m1", mentions: [7, 8, 99] },
            ws, sendToUser: send,
        });
        const mentionCalls = send.mock.calls.filter((c: any[]) => c[2] === "chat_mention");
        expect(mentionCalls).toHaveLength(1);
        expect(mentionCalls[0][1]).toBe(8);
    });

    test('formatType defaults to "text" when missing / unknown', async () => {
        const db = makeHappyPathDb();
        const ws = makeWs();
        const send = jest.fn();
        await chatMessage({
            db, senderId: 7, tenantId: 1,
            data: { conversationId: 5, content: "hi", formatType: "weird-unknown" },
            ws, sendToUser: send,
        });
        // Index 2: [0]=participant check, [1]=block check, [2]=INSERT.
        const insertCall = db.query.mock.calls[2];
        expect(insertCall[1][4]).toBe("text");
    });

    test('formatType "markdown" / "code" are preserved', async () => {
        for (const ft of ["markdown", "code"]) {
            const db = makeHappyPathDb();
            await chatMessage({
                db, senderId: 7, tenantId: 1,
                data: { conversationId: 5, content: "x", formatType: ft },
                ws: makeWs(), sendToUser: jest.fn(),
            });
            expect(db.query.mock.calls[2][1][4]).toBe(ft);
        }
    });
});