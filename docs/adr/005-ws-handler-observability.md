# ADR-005 — WebSocket Handler Observability (Phase 6, part 1)

**Status**: Accepted, first slice of Phase 6 (Backend reliability polish).
**Date**: 2026-05-26
**Related**: ADR-001 (status service v2), ADR-002 (chat reliability),
ADR-003 (Resilience Pack), ADR-004 (Mesh quality).

---

## Context

`server/utils/ws.js`'s `handleChatMessage` is a single 1000-line `if/else if`
that dispatches ~25 WebSocket message types. It mixes:

- presence + status updates
- 1:1 chat (send / typing / read)
- 1:1 call signaling (initiate, accept, reject, end, signal, reaction)
- mesh meeting signaling (join, leave, end, signal, mute, hand, track
  state, screen-track ids, chat, replay, request_quality, audio_level)

The original WS plan called for splitting this into a `handlers/`
directory with:

1. per-message zod schemas
2. per-handler timeouts
3. a per-handler circuit breaker

before doing any of that we need **evidence** for *which* handlers
actually cause production heartburn. Splitting all 25 is busy-work; we
should split the 2-3 that show high p95 latency or non-zero error rate
in production. ADR-005 ships the measurement infrastructure that
answers "which ones?".

A secondary problem this fixes: the previous dispatch had **no
soft-timeout**. A handler stuck on a slow DB query would sit in
`Promise.then` forever, the WebSocket frame buffer would back up, and
nothing about the symptom would point at the cause. Now any handler
exceeding 5 s surfaces as a `WS_HANDLER_TIMEOUT` error in the metrics
snapshot, attributing the hang to a specific message type.

---

## Decision

Three small additions. All additive, ~150 LoC of code + ~150 LoC of
tests, zero new runtime dependencies, no schema migration.

### 1. `server/utils/wsMetrics.js`

A self-contained metrics collector. Single API:

```js
await wsMetrics.recordHandler(type, timeoutMs, asyncFn);
const snapshot = wsMetrics.snapshot();
```

Each `type` gets a `HandlerStats` entry with:

| Field        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `count`      | total invocations                                    |
| `errors`     | invocations that threw (incl. timeouts)              |
| `timeouts`   | invocations that hit the per-call budget             |
| `errorRate`  | `errors / count`, rounded to 4 dp                    |
| `p50Ms`      | median latency in ms, over a rolling 256-sample window |
| `p95Ms`      | 95th percentile latency in ms                        |

Memory bound: 256 samples × 8 bytes × ~25 types ≈ 50 KB peak per
process. p50/p95 are computed lazily on read (snapshot) — the hot path
just appends to a circular buffer of `Float64`-equivalent JS numbers.
No I/O, no timers, no globals beyond the registry.

### 2. Wrap `handleChatMessage` dispatch

The WS message receive path now wraps every dispatch in
`recordHandler(msg.type, 5_000, () => handleChatMessage(...))`. The
existing `try { JSON.parse } catch` and the post-promise `.catch`
remain unchanged — `recordHandler` rethrows so the outer error logging
still fires.

5 s is a **soft** timeout, intentionally generous. Every existing
handler completes in well under a second on warm pools; 5 s is the
threshold above which "this is definitely a bug, not a slow network".

### 3. `GET /api/internal/ws-stats`

New router at `server/routes/internal.js`, gated behind
`authMiddleware → loadUserContext → requireRole('platform_admin')`. The
endpoint reads `wsMetrics.snapshot()` and returns:

```json
{
  "instanceId": "12345",
  "handlers": {
    "meeting_chat":   { "count": 142, "errors": 0, "timeouts": 0, "errorRate": 0, "p50Ms": 2.31, "p95Ms": 18.4 },
    "meeting_signal": { "count": 980, "errors": 0, "timeouts": 0, "errorRate": 0, "p50Ms": 0.12, "p95Ms": 1.8 },
    ...
  },
  "totals":  { "count": 4031, "errors": 2, "timeouts": 1, "errorRate": 0.0005 },
  "windowSize": 256,
  "capturedAt": "2026-05-26T05:00:00.000Z"
}
```

`instanceId` is the process PID — useful when the platform runs
multiple WS server instances. Per-instance is sufficient for the
"which handler to split first?" question; a cluster-wide rollup via
Redis Pub/Sub is deferred until we have ≥3 instances actually running
simultaneously.

`apiLimiter` rate-limits the endpoint (5000 reqs/15-min by default,
which is generous for a polling stats reader).

---

## Consequences

### Positive

- **First-time visibility** into per-handler latency + error rates.
  We can finally answer "is `meeting_signal` really 80 % of the WS
  traffic?" with `count`, not guesses.
- **Runaway handlers no longer hide**. A stuck DB query in any
  handler now surfaces as `timeouts: 1+` in the snapshot, attributed
  to the exact message type. The 5 s budget is far below the WS
  framing-buffer collapse time.
- **Hard-data prerequisite for the `handlers/` split**. Once we have
  24-48 h of production data, we can re-prioritise the Phase 6
  remainder: only handlers with measurable problems need their own
  file + zod schema + circuit breaker.
- **Pure additive change**. No existing behaviour is altered;
  `recordHandler` just measures and rethrows.

### Negative

- Tiny per-invocation overhead: 2 × `process.hrtime.bigint()` calls
  and one circular-buffer write. Benchmarks the obvious way come out
  at < 1 μs per invocation, far below any existing handler's median.
- 256 samples × 25 types ≈ 6400 numbers retained. Negligible.
- The instance-local nature means a horizontally scaled deployment
  needs `/api/internal/ws-stats` polled per-instance. Acceptable for
  the current single-instance footprint; if/when we go multi-instance
  we'll add a rollup endpoint.

### Neutral

- `apiLimiter` is the same one used by every other tenant-scoped
  endpoint. The route guard requires `platform_admin` (not just
  `super_admin`) so the platform team can poll without needing the
  full operator role.
- The endpoint is **process-local only** by design. We deliberately
  did NOT introduce a Redis time-series rollup — premature for a
  single-instance setup, and it would mean every WS dispatch writes
  one Redis key. If/when we need cluster-wide aggregation we can
  publish snapshots on a 10 s timer, not per-call.

---

## Out of scope (still TODO for Phase 6)

- **Split `handleChatMessage` into `handlers/` directory**: defer until
  we have ≥1 week of metrics. Then pick the worst 3-5 handlers by
  `p95Ms` or `errorRate` and move them.
- **Per-handler zod schemas**: same — drive priority by the data.
- **Circuit breakers**: only worth adding to handlers where
  `errorRate > 1 %` over a sustained window.
- **Cluster-wide rollup**: defer until we deploy ≥3 instances.

---

## Files changed

- `server/utils/wsMetrics.js` — **new**. Pure metrics collector
  (~165 LoC), no I/O.
- `server/utils/ws.js`:
  - imports `wsMetrics`
  - new constant `WS_HANDLER_DEFAULT_TIMEOUT_MS = 5_000`
  - wraps `handleChatMessage` dispatch in `wsMetrics.recordHandler`
- `server/routes/internal.js` — **new**. Single endpoint
  `GET /api/internal/ws-stats`. Gated by `platform_admin`.
- `server/index.js` — mounts `/api/internal` under `apiLimiter`.
- `server/__tests__/wsMetrics.test.js` — **new**, 7 tests
  (empty registry, success, error, timeout, totals roll-up,
  p95 ≥ p50, unknown-type coercion).
- `server/__tests__/internal.routes.test.js` — **new**, 4 tests
  (401 unauth, 403 wrong-role, 200 shape, totals correctness).

## Test summary

```
server:  Test Suites: 31 passed, 31 total | Tests: 388 passed, 388 total  (was 377 → +11)
client:  Test Files:  15 passed, 15 total | Tests: 103 passed, 103 total  (unchanged)