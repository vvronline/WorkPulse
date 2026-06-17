"use strict";
/**
 * In-memory metrics collector for WebSocket handlers.
 *
 * Why
 * ───
 * `handleChatMessage` in ws.js dispatches ~25 different message types in a
 * single 1000+ line `if/else if` chain. We have no idea which handlers
 * actually take the most time, which fail most often, or which would
 * benefit most from being moved into a dedicated `handlers/` directory
 * with their own zod schema and circuit breaker. Phase 6 of the meeting
 * reliability plan calls for splitting the chain — this module is the
 * evidence collector that tells us where to start.
 *
 * Design
 * ──────
 * One global registry keyed by message type. Each entry tracks:
 *   - total invocation count
 *   - error count (handler threw)
 *   - timeout count (handler exceeded its budget)
 *   - latency p50 / p95 over a rolling 256-sample window
 *
 * Memory is bounded: 256 samples × 8 bytes × ~25 types = ~50 KB peak.
 * Latency samples are stored as a fixed-size circular buffer (no
 * per-sample allocations); p50/p95 are computed lazily on read.
 *
 * The module is pure — no I/O, no timers, no globals beyond the
 * registry. Easy to test. The collector is process-local (NOT shared
 * across WS server instances); for multi-instance metrics we'd
 * roll-up via the existing Pub/Sub channel in Phase 7, but a single
 * snapshot per instance is plenty for the "which handler to split
 * first" question.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WINDOW_SIZE = void 0;
exports.recordHandler = recordHandler;
exports.snapshot = snapshot;
exports.recordCallTransitionFailure = recordCallTransitionFailure;
exports.callReliabilitySnapshot = callReliabilitySnapshot;
exports.__resetForTests = __resetForTests;
const WINDOW_SIZE = 256;
exports.WINDOW_SIZE = WINDOW_SIZE;
const CALL_FAILURE_WINDOW_SIZE = 200;
/** Per-message-type metrics state. */
class HandlerStats {
    count = 0;
    errors = 0;
    timeouts = 0;
    // Circular buffer of latency samples (ms). We use a plain Array
    // pre-filled with zeros and an incrementing write index — same
    // memory cost as a typed array but supports `.sort()` cleanly.
    samples = new Array(WINDOW_SIZE).fill(0);
    sampleIdx = 0;
    sampleFilled = 0; // how many slots have real data (capped at WINDOW_SIZE)
    recordLatency(ms) {
        this.samples[this.sampleIdx] = ms;
        this.sampleIdx = (this.sampleIdx + 1) % WINDOW_SIZE;
        if (this.sampleFilled < WINDOW_SIZE)
            this.sampleFilled++;
    }
    /** Return a fresh array of just the live samples, sorted ascending. */
    sortedSamples() {
        const live = this.samples.slice(0, this.sampleFilled);
        live.sort((a, b) => a - b);
        return live;
    }
    /** Percentile q (0..1). Returns 0 when no samples. */
    percentile(q) {
        const sorted = this.sortedSamples();
        if (sorted.length === 0)
            return 0;
        const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
        return sorted[idx];
    }
    snapshot() {
        return {
            count: this.count,
            errors: this.errors,
            timeouts: this.timeouts,
            errorRate: this.count === 0 ? 0 : +(this.errors / this.count).toFixed(4),
            p50Ms: +this.percentile(0.5).toFixed(2),
            p95Ms: +this.percentile(0.95).toFixed(2),
        };
    }
}
const registry = new Map(); // type -> HandlerStats
const callFailureEvents = [];
function getOrCreate(type) {
    let s = registry.get(type);
    if (!s) {
        s = new HandlerStats();
        registry.set(type, s);
    }
    return s;
}
/**
 * Wrap a handler invocation. Pass the message type, an optional timeout
 * (ms; 0 = no timeout — matches today's behaviour), and the async fn.
 * Returns whatever fn returns; throws whatever fn throws.
 *
 * Side-effects:
 *   • count++ on every call
 *   • errors++ + rethrow if fn throws
 *   • timeouts++ + throw a TimeoutError if `timeoutMs > 0` and the
 *     handler exceeds it
 *   • records latency in ALL cases (success + error + timeout)
 */
async function recordHandler(type, timeoutMs, fn) {
    const safeType = typeof type === "string" && type.length > 0 && type.length <= 64
        ? type : "unknown";
    const stats = getOrCreate(safeType);
    stats.count++;
    const t0 = process.hrtime.bigint();
    try {
        if (timeoutMs && timeoutMs > 0) {
            await Promise.race([
                fn(),
                new Promise((_, reject) => setTimeout(() => {
                    stats.timeouts++;
                    const err = new Error(`ws-handler timeout: ${safeType}`);
                    err.code = "WS_HANDLER_TIMEOUT";
                    reject(err);
                }, timeoutMs)),
            ]);
        }
        else {
            await fn();
        }
    }
    catch (err) {
        stats.errors++;
        throw err;
    }
    finally {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        stats.recordLatency(ms);
    }
}
/**
 * Snapshot the entire registry. Returns a plain object keyed by type with
 * a numeric snapshot per entry, plus a top-level rollup.
 */
function snapshot() {
    const handlers = {};
    let totalCount = 0;
    let totalErrors = 0;
    let totalTimeouts = 0;
    for (const [type, stats] of registry) {
        handlers[type] = stats.snapshot();
        totalCount += stats.count;
        totalErrors += stats.errors;
        totalTimeouts += stats.timeouts;
    }
    return {
        handlers,
        totals: {
            count: totalCount,
            errors: totalErrors,
            timeouts: totalTimeouts,
            errorRate: totalCount === 0 ? 0 : +(totalErrors / totalCount).toFixed(4),
        },
        windowSize: WINDOW_SIZE,
        capturedAt: new Date().toISOString(),
    };
}
function normalizeAction(action) {
    if (action === "initiate" || action === "answer" || action === "reject" || action === "end") {
        return action;
    }
    return "unknown";
}
function recordCallTransitionFailure(input) {
    const event = {
        event: "call_transition_failed",
        action: normalizeAction(input.action),
        tenantId: input.tenantId ?? null,
        senderId: input.senderId ?? null,
        callId: input.callId ?? null,
        conversationId: input.conversationId ?? null,
        fromStatus: input.fromStatus ?? null,
        reason: input.reason || "unspecified",
        timestamp: input.timestamp || new Date().toISOString(),
    };
    callFailureEvents.push(event);
    if (callFailureEvents.length > CALL_FAILURE_WINDOW_SIZE) {
        callFailureEvents.splice(0, callFailureEvents.length - CALL_FAILURE_WINDOW_SIZE);
    }
}
function callReliabilitySnapshot() {
    const byAction = {};
    const byReason = {};
    for (const event of callFailureEvents) {
        byAction[event.action] = (byAction[event.action] || 0) + 1;
        byReason[event.reason] = (byReason[event.reason] || 0) + 1;
    }
    return {
        totalFailures: callFailureEvents.length,
        byAction,
        byReason,
        recentFailures: [...callFailureEvents],
        capturedAt: new Date().toISOString(),
    };
}
/** Test-only — drop every collected sample. */
function __resetForTests() {
    registry.clear();
    callFailureEvents.length = 0;
}
//# sourceMappingURL=wsMetrics.js.map