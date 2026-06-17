"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Pure unit tests for the WS metrics collector. No supertest needed —
 * the module is side-effect free apart from its private registry which we
 * reset in beforeEach.
 */
const wsMetrics = require("../utils/wsMetrics");
describe("wsMetrics", () => {
    beforeEach(() => {
        wsMetrics.__resetForTests();
    });
    test("snapshot of an empty registry has zeroed totals", () => {
        const s = wsMetrics.snapshot();
        expect(s.handlers).toEqual({});
        expect(s.totals).toEqual({ count: 0, errors: 0, timeouts: 0, errorRate: 0 });
        expect(s.windowSize).toBe(wsMetrics.WINDOW_SIZE);
        expect(typeof s.capturedAt).toBe("string");
    });
    test("counts a successful invocation and records its latency", async () => {
        await wsMetrics.recordHandler("meeting_chat", 0, async () => "ok");
        const s = wsMetrics.snapshot();
        expect(s.handlers.meeting_chat.count).toBe(1);
        expect(s.handlers.meeting_chat.errors).toBe(0);
        expect(s.handlers.meeting_chat.timeouts).toBe(0);
        // p50/p95 are tiny (microseconds), but they should be numbers.
        expect(typeof s.handlers.meeting_chat.p50Ms).toBe("number");
        expect(typeof s.handlers.meeting_chat.p95Ms).toBe("number");
    });
    test("errors are counted and rethrown", async () => {
        const err = new Error("boom");
        await expect(wsMetrics.recordHandler("meeting_signal", 0, async () => { throw err; })).rejects.toBe(err);
        const s = wsMetrics.snapshot();
        expect(s.handlers.meeting_signal.count).toBe(1);
        expect(s.handlers.meeting_signal.errors).toBe(1);
        expect(s.handlers.meeting_signal.errorRate).toBe(1);
    });
    test("timeouts are counted and throw a WS_HANDLER_TIMEOUT error", async () => {
        await expect(wsMetrics.recordHandler("chat_message", 20, () => new Promise(() => { }))).rejects.toMatchObject({ code: "WS_HANDLER_TIMEOUT" });
        const s = wsMetrics.snapshot();
        expect(s.handlers.chat_message.timeouts).toBe(1);
        expect(s.handlers.chat_message.errors).toBe(1); // errors includes timeouts
    });
    test("totals roll up across multiple handlers", async () => {
        await wsMetrics.recordHandler("a", 0, async () => { });
        await wsMetrics.recordHandler("a", 0, async () => { });
        await wsMetrics.recordHandler("b", 0, async () => { });
        await wsMetrics.recordHandler("b", 0, async () => { throw new Error("x"); }).catch(() => { });
        const s = wsMetrics.snapshot();
        expect(s.totals.count).toBe(4);
        expect(s.totals.errors).toBe(1);
        expect(s.totals.errorRate).toBe(0.25);
    });
    test("p50/p95 ordering: p95 ≥ p50 for any non-trivial latency mix", async () => {
        // Inject latencies via a stub clock: we run handlers that yield in
        // an awaited setTimeout. Use a couple of obvious gaps so p95 ≠ p50.
        for (const ms of [1, 1, 1, 1, 1, 1, 1, 1, 1, 30]) {
            // eslint-disable-next-line no-await-in-loop
            await wsMetrics.recordHandler("mix", 0, () => new Promise((r) => setTimeout(r, ms)));
        }
        const s = wsMetrics.snapshot();
        expect(s.handlers.mix.count).toBe(10);
        expect(s.handlers.mix.p95Ms).toBeGreaterThanOrEqual(s.handlers.mix.p50Ms);
    });
    test('safely coerces unknown / missing type to "unknown"', async () => {
        await wsMetrics.recordHandler(undefined, 0, async () => { });
        await wsMetrics.recordHandler("", 0, async () => { });
        await wsMetrics.recordHandler(null, 0, async () => { });
        const s = wsMetrics.snapshot();
        // All three should land on the same `unknown` bucket.
        expect(s.handlers.unknown.count).toBe(3);
    });
});
//# sourceMappingURL=wsMetrics.test.js.map