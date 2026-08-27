/** Redis signal-store semantics, exercised through the development L1 fallback. */
export {};

jest.mock("../redis", () => ({
    getClient: () => null,
    isRedisReady: () => false,
}));

const store = require("../realtime/signalStore");

describe("call signal store", () => {
    it("replays the latest offer before ordered ICE, exactly once", async () => {
        await store.bufferCallSignal(1, 10, 2, 3, { type: "offer", sdp: "old" });
        await store.bufferCallSignal(1, 10, 2, 3, { type: "ice-candidate", candidate: { candidate: "stale" } });
        // New offer starts a fresh generation and drops stale ICE.
        await store.bufferCallSignal(1, 10, 2, 3, { type: "offer", sdp: "new" });
        await store.bufferCallSignal(1, 10, 2, 3, { type: "ice-candidate", candidate: { candidate: "a" } });
        await store.bufferCallSignal(1, 10, 2, 3, { type: "ice-candidate", candidate: { candidate: "b" } });

        const first = await store.drainCallSignals(1, 10, 3);
        expect(first.map((x: any) => x.signal.type)).toEqual(["offer", "ice-candidate", "ice-candidate"]);
        expect(first[0].signal.sdp).toBe("new");
        expect(first.map((x: any) => x.signal.candidate?.candidate).filter(Boolean)).toEqual(["a", "b"]);
        expect(await store.drainCallSignals(1, 10, 3)).toEqual([]);
    });

    it("isolates tenants with identical call and user ids", async () => {
        await store.bufferCallSignal(1, 55, 2, 3, { type: "offer", sdp: "tenant-a" });
        await store.bufferCallSignal(2, 55, 2, 3, { type: "offer", sdp: "tenant-b" });
        expect((await store.drainCallSignals(1, 55, 3))[0].signal.sdp).toBe("tenant-a");
        expect((await store.drainCallSignals(2, 55, 3))[0].signal.sdp).toBe("tenant-b");
    });

    it("clears every target for a terminal call", async () => {
        await store.bufferCallSignal(1, 77, 2, 3, { type: "offer", sdp: "x" });
        await store.bufferCallSignal(1, 77, 3, 2, { type: "offer", sdp: "y" });
        await store.clearCallSignals(1, 77);
        expect(await store.drainCallSignals(1, 77, 3)).toEqual([]);
        expect(await store.drainCallSignals(1, 77, 2)).toEqual([]);
    });
});

describe("meeting signal store", () => {
    it("keeps each sender's latest offer and ICE for the target", async () => {
        await store.bufferMeetingSignal(1, 90, 2, 4, { type: "offer", sdp: "from-2" });
        await store.bufferMeetingSignal(1, 90, 2, 4, { type: "candidate", candidate: "2a" });
        await store.bufferMeetingSignal(1, 90, 3, 4, { type: "offer", sdp: "from-3" });
        await store.bufferMeetingSignal(1, 90, 3, 4, { type: "candidate", candidate: "3a" });

        const drained = await store.drainMeetingSignals(1, 90, 4);
        expect(drained.filter((x: any) => x.signal.type === "offer")).toHaveLength(2);
        expect(drained.filter((x: any) => x.signal.type === "candidate")).toHaveLength(2);
        expect(await store.drainMeetingSignals(1, 90, 4)).toEqual([]);
    });

    it("clears signals to and from a departing user", async () => {
        await store.bufferMeetingSignal(1, 91, 2, 4, { type: "offer", sdp: "to-4" });
        await store.bufferMeetingSignal(1, 91, 4, 3, { type: "offer", sdp: "from-4" });
        await store.clearMeetingUserSignals(1, 91, 4);
        expect(await store.drainMeetingSignals(1, 91, 4)).toEqual([]);
        expect(await store.drainMeetingSignals(1, 91, 3)).toEqual([]);
    });
});