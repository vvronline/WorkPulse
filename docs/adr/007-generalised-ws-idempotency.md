# ADR-007 — Generalised WebSocket Handler Idempotency (Phase 2)

**Status**: Accepted, implementation of Phase 2.
**Date**: 2026-05-26
**Related**: ADR-002 (chat reliability), ADR-005 (WS observability), ADR-006 (Permission Presets).

---

## Context

ADR-002 (Phase 0.5) introduced a `clientMsgId` round-trip for `meeting_chat`
specifically — backed by a partial unique index on `messages.client_msg_id`
to enforce at-most-once persistence at the DB layer. That bug class is gone
for chat, but the same shape of "user clicks twice on a flaky link" can hit
several other handlers:

- `meeting_raise_hand` — hand stuck "on" / "off" depending on which retry won
- `meeting_mute_participant` — host taps mute during a WS glitch and the
  target's mic flips twice
- `meeting_add_participant` — invite-during-reconnect double-fire spams the
  invitee with two ringing prompts
- `meeting_track_state` — track-state burst during media swap re-broadcasts

These are all "naturally" idempotent at the DB layer (each one writes a
single row keyed by `(meeting_id, user_id)`) but we still pay the full SQL
cost + broadcast fan-out per retry. The user-visible flicker is the bigger
problem — a remote-muted participant's UI flips off-on-off-on if 3 messages
arrive in quick succession.

We could keep solving this one handler at a time with bespoke DB unique
indexes (the chat approach). That has two problems:

1. Adding a unique index per handler doesn't generalise — handlers that
   *don't* persist (pure relays like `meeting_request_quality`) have
   nowhere to put one.
2. The pattern is the same every time. Each repeat is a temptation to
   skip the safety + a chance to misimplement the dedupe key.

ADR-007 ships a single utility that handles it once.

---

## Decision

Two additions, additive, zero new dependencies, zero schema migration.

### 1. `server/utils/wsIdempotency.js` (new)

Public API:

```js
const { withIdempotency } = require('../utils/wsIdempotency');

await withIdempotency(
    { tenantId, senderId, type, clientMsgId },
    async () => { /* the actual handler */ }
);
```

Implementation: in-process LRU keyed by
`(tenantId, senderId, type, clientMsgId)`. Cached entries TTL after 5
minutes (long enough to cover the existing 15-second `MEETING_DISCONNECT_GRACE_MS`
+ a slow WS reconnect, short enough that a buggy client repeating the same
id hours later doesn't get a stale answer).

**Bounded memory**: 5_000 entries × ~50 bytes ≈ 250 KB peak. LRU evicts on
overflow + a 60s background sweep prunes expired entries even when idle.

**No-op when there's no `clientMsgId`**: the wrapper just runs the fn and
returns. Adoption is opt-in per handler.

**Errors aren't cached**: if the wrapped fn throws, the next retry gets a
fresh world. This is on purpose — most errors are transient (DB pool
hiccup, brief disconnect of a downstream service). Caching them would
permanently fail any handler that ever hits a hiccup.

### 2. Adopted by two highest-value handlers

`server/utils/ws.js`:
- `meeting_raise_hand` — wrapped with `withIdempotency(...)`. The hand-toggle
  button is the easiest thing in the meeting UI to double-fire (tap → no
  response → tap again).
- `meeting_mute_participant` — same wrapper. Host's "mute" click during a
  glitchy reconnect no longer toggles the target's mic state twice.

`client/src/pages/meeting/useMeetingState.js`:
- `raiseHand` now sends `clientMsgId: newClientMsgId()` with every toggle.
- `muteParticipant` now sends `clientMsgId: newClientMsgId()` with every
  mute request.

(Both reuse the same `newClientMsgId()` minter that already exists for
chat — no new utility on the client.)

### Why not just put a unique index on every handler's underlying table?

For the chat case the index makes sense — `messages` is append-only and a
duplicate row would be a permanent data-integrity issue. For these
ephemeral handlers (hand toggle, mute toggle, track state) there is no
"row" to make unique; the operation is "broadcast X to N peers". A DB
index would force us to introduce a synthetic side-effect table just so
we could index it. The in-memory LRU is the right tool: it dedupes the
*operation*, not its byproducts.

---

## Consequences

### Positive

- **One utility, many adopters**: every new handler that wants "safe to
  retry" just wraps with `withIdempotency` and starts trusting the
  client's id. Bug class "remote toggle flickers twice on flaky network"
  is solved by an additive 3-line change per handler.
- **No DB pressure**: dedupe happens in memory. A retry of a hand toggle
  costs O(1) hash lookup instead of N+1 SELECTs + broadcasts.
- **Bounded memory**: 250 KB peak, with LRU + TTL eviction. No leak
  surface even under sustained traffic.
- **Backwards-compatible**: legacy clients without `clientMsgId` keep
  working — the wrapper is a pure no-op for them.
- **Errors don't get cached**: transient DB hiccups don't permanently
  poison a key.

### Negative

- **Process-local**: the cache lives in the WS server's memory, not
  Redis. A multi-instance deployment would not share dedupe state — the
  same retry hitting two different instances would execute on both.
  Acceptable for now (we run a single WS instance); a multi-instance
  upgrade would promote `defaultCache` to Redis with a key TTL.
- **Doesn't dedupe across server restarts**: a crash mid-window resets
  the cache. The handlers we've adopted are all idempotent at the DB
  layer anyway (mute is a fresh broadcast, hand-raise is a fresh
  broadcast), so this is an aesthetic cost, not a correctness one.

### Neutral

- Bumped server test count from 406 → 418 (+12 tests across LRU
  behaviour, TTL expiry, error non-caching, key collision avoidance).
- Client test count unchanged (103) — the change is a pure wire-format
  addition that doesn't affect any rendered component.

---

## Out of scope

- **Promoting to Redis** — only worth it once we run ≥2 WS server
  instances. The contract supports it (the cache is a pure noun;
  swapping the implementation behind `defaultCache` is trivial).
- **Adopting in `meeting_add_participant` and `meeting_track_state`** —
  intentionally deferred until we see them double-fire in production
  via the new `/api/internal/ws-stats` panel from ADR-005. Drive
  adoption by data, not speculation.
- **Cross-handler typed schemas** — separate concern, covered by the
  deferred Phase 6 part 2 work.

---

## Files changed

- `server/utils/wsIdempotency.js` — **new** (~165 LoC). `IdempotencyCache`
  + `withIdempotency` + default singleton + 60s background sweep.
- `server/utils/ws.js`:
  - `require('./wsIdempotency')`
  - `meeting_raise_hand` handler wrapped in `withIdempotency(...)`
  - `meeting_mute_participant` handler wrapped in `withIdempotency(...)`
- `client/src/pages/meeting/useMeetingState.js`:
  - `raiseHand` sends `clientMsgId`
  - `muteParticipant` sends `clientMsgId`
- `server/__tests__/wsIdempotency.test.js` — **new**, 12 tests
  (run-once, replay, key isolation, no-id pass-through, overlong-id
  rejection, no-cache-on-throw, undefined-cached, TypeError on bad fn,
  LRU eviction, LRU touch, TTL expiry, snapshot hit-rate).

## Test summary

```
server:  Test Suites: 33 passed, 33 total | Tests: 418 passed, 418 total  (406 → +12)
client:  Test Files:  15 passed, 15 total | Tests: 103 passed, 103 total  (unchanged)