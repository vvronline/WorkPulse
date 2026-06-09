export {};

/**
 * Regression tests for the WebSocket relay access-control fix.
 *
 * Before the fix, the WebRTC signaling/control relays trusted the
 * client-supplied `targetUserId` and skipped sender/target membership checks
 * on the high-frequency paths (ICE candidates, reactions, quality requests,
 * screen-track announcements). Any authenticated tenant user could therefore
 * inject frames at an arbitrary userId (DoS / user-enumeration / harassment).
 *
 * The relays now verify BOTH the sender AND the target are members of the
 * conversation/meeting before forwarding. We observe forwarding via
 * `redis.publish` (every `sendToUser` publishes to the cross-instance channel).
 *
 * NOTE: ws.js keeps a short-TTL in-memory membership cache keyed by
 * (room, userId), so each test uses a UNIQUE conversation/meeting id to avoid
 * cross-test cache contamination.
 */
jest.mock("../db", () => ({ masterQuery: jest.fn() }));
jest.mock("../redis", () => ({
    publish: jest.fn(),
    getTokenVersion: jest.fn(),
    setTokenVersion: jest.fn(),
    TTL: { PRESENCE: 60 },
}));
jest.mock("../services/status", () => ({
    openSession: jest.fn(), closeSession: jest.fn(),
    clearActivityForRef: jest.fn(() => Promise.resolve()),
}));
jest.mock("../utils/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
    requestLogger: (_req: any, _res: any, next: any) => next(),
}));

const redis = require("../redis");
const { handleChatMessage } = require("../utils/ws");

const SENDER = 1;
const TENANT = 42;

let _roomSeq = 1000;
const nextRoom = () => ++_roomSeq; // unique id per test → fresh membership cache key

/**
 * Build a db stub. `convMembers` / `meetMembers` are the sets of userIds that
 * are members of the conversation / meeting respectively.
 */
function makeDb({ convMembers = new Set<number>(), meetMembers = new Set<number>() }: { convMembers?: Set<number>; meetMembers?: Set<number> } = {}) {
    return {
        query: jest.fn(async (sql: string, params: any[]) => {
            if (/conversation_participants/.test(sql)) {
                return { rows: convMembers.has(params[1]) ? [{ ok: 1 }] : [] };
            }
            if (/meeting_participants/.test(sql)) {
                return { rows: meetMembers.has(params[1]) ? [{ ok: 1 }] : [] };
            }
            return { rows: [] };
        }),
    };
}

const ws = { readyState: 1, send: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe("call_signal relay", () => {
    test("drops ICE relay when target is NOT a conversation member", async () => {
        const cid = nextRoom();
        const db = makeDb({ convMembers: new Set([SENDER]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "call_signal",
            data: { conversationId: cid, targetUserId: 999, signal: { type: "ice-candidate", candidate: { candidate: "x" } } },
        }, ws);
        expect(redis.publish).not.toHaveBeenCalled();
    });

    test("forwards ICE relay when both sender and target are members", async () => {
        const cid = nextRoom();
        const db = makeDb({ convMembers: new Set([SENDER, 2]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "call_signal",
            data: { conversationId: cid, targetUserId: 2, signal: { type: "ice-candidate", candidate: { candidate: "x" } } },
        }, ws);
        expect(redis.publish).toHaveBeenCalledTimes(1);
    });

    test("drops when sender is NOT a member even if target is", async () => {
        const cid = nextRoom();
        const db = makeDb({ convMembers: new Set([2]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "call_signal",
            data: { conversationId: cid, targetUserId: 2, signal: { type: "ice-candidate", candidate: { candidate: "x" } } },
        }, ws);
        expect(redis.publish).not.toHaveBeenCalled();
    });
});

describe("call_reaction relay", () => {
    test("drops reaction to a non-member target", async () => {
        const cid = nextRoom();
        const db = makeDb({ convMembers: new Set([SENDER]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "call_reaction",
            data: { conversationId: cid, targetUserId: 999, emoji: "\u{1F44D}" },
        }, ws);
        expect(redis.publish).not.toHaveBeenCalled();
    });

    test("forwards reaction to a member target", async () => {
        const cid = nextRoom();
        const db = makeDb({ convMembers: new Set([SENDER, 2]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "call_reaction",
            data: { conversationId: cid, targetUserId: 2, emoji: "\u{1F44D}" },
        }, ws);
        expect(redis.publish).toHaveBeenCalledTimes(1);
    });
});

describe("meeting_signal relay", () => {
    test("drops ICE relay when target is NOT a meeting member", async () => {
        const mid = nextRoom();
        const db = makeDb({ meetMembers: new Set([SENDER]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "meeting_signal",
            data: { meetingId: mid, targetUserId: 999, signal: { type: "ice-candidate" } },
        }, ws);
        expect(redis.publish).not.toHaveBeenCalled();
    });

    test("forwards when both are meeting members", async () => {
        const mid = nextRoom();
        const db = makeDb({ meetMembers: new Set([SENDER, 2]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "meeting_signal",
            data: { meetingId: mid, targetUserId: 2, signal: { type: "ice-candidate" } },
        }, ws);
        expect(redis.publish).toHaveBeenCalledTimes(1);
    });
});

describe("meeting_request_quality relay", () => {
    test("drops quality request to a non-member (video-sabotage DoS)", async () => {
        const mid = nextRoom();
        const db = makeDb({ meetMembers: new Set([SENDER]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "meeting_request_quality",
            data: { meetingId: mid, targetUserId: 999, level: "q" },
        }, ws);
        expect(redis.publish).not.toHaveBeenCalled();
    });
});

describe("meeting_screen_track_id relay", () => {
    test("drops screen-track signal to a non-member", async () => {
        const mid = nextRoom();
        const db = makeDb({ meetMembers: new Set([SENDER]) });
        await handleChatMessage(db, SENDER, TENANT, {
            type: "meeting_screen_track_id",
            data: { meetingId: mid, targetUserId: 999, sharing: true, trackId: "t1" },
        }, ws);
        expect(redis.publish).not.toHaveBeenCalled();
    });
});