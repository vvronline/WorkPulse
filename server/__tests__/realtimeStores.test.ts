/** Phase D distributed membership and meeting-leave semantics. */
export {};

const values = new Map<string, string>();
const fakeClient = {
    set: jest.fn(async (key: string, value: string) => { values.set(key, value); return "OK"; }),
    del: jest.fn(async (key: string) => values.delete(key) ? 1 : 0),
    eval: jest.fn(async (_script: string, _n: number, key: string, token: string) => {
        if (values.get(key) !== token) return 0;
        values.delete(key);
        return 1;
    }),
};

const shared = new Map<string, any>();
jest.mock("../redis", () => ({
    getClient: () => fakeClient,
    isRedisReady: () => true,
    get: async (key: string) => shared.get(key) ?? null,
    set: async (key: string, value: any) => { shared.set(key, value); },
}));

describe("meeting leave leases", () => {
    const store = require("../realtime/meetingLeaveStore");

    beforeEach(() => values.clear());

    it("a rejoin on any replica cancels the pending cleanup", async () => {
        const token = await store.createMeetingLeaveLease(1, 2, 3);
        expect(await store.cancelMeetingLeaveLease(1, 2, 3)).toBe(true);
        expect(await store.claimMeetingLeaveLease(1, 2, 3, token)).toBe(false);
    });

    it("only the current token can claim a cleanup", async () => {
        const token = await store.createMeetingLeaveLease(1, 2, 3);
        expect(await store.claimMeetingLeaveLease(1, 2, 3, "stale-token")).toBe(false);
        expect(await store.claimMeetingLeaveLease(1, 2, 3, token)).toBe(true);
        expect(await store.claimMeetingLeaveLease(1, 2, 3, token)).toBe(false);
    });

    it("isolates identical meeting/user ids by tenant", async () => {
        const a = await store.createMeetingLeaveLease(1, 2, 3);
        const b = await store.createMeetingLeaveLease(2, 2, 3);
        expect(await store.claimMeetingLeaveLease(1, 2, 3, a)).toBe(true);
        expect(await store.claimMeetingLeaveLease(2, 2, 3, b)).toBe(true);
    });
});

describe("membership cache", () => {
    const cache = require("../realtime/membershipCache");
    beforeEach(() => shared.clear());

    it("isolates identical room/user ids by tenant", async () => {
        await cache.setMembership(1, "conversation", 9, 5, true);
        await cache.setMembership(2, "conversation", 9, 5, false);
        expect(await cache.getMembership(1, "conversation", 9, 5)).toBe(true);
        expect(await cache.getMembership(2, "conversation", 9, 5)).toBe(false);
    });
});