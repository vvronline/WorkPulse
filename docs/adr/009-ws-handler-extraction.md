# ADR-009 — WebSocket Handler Extraction + Schema Validation (Phase 6 part 2)

**Status**: Accepted, first slice of the handler-extraction work begun in ADR-005.
**Date**: 2026-05-26
**Related**: ADR-002 (chat reliability), ADR-005 (WS observability + soft-timeout), ADR-007 (idempotency wrapper).

---

## Context

ADR-005 shipped per-handler observability and asked one question: **before
we mechanically split the 1000-line `handleChatMessage` if/else chain into
25 separate files, what's the actual evidence that doing so pays off?**

Two answers became obvious without needing a full week of production data:

1. **No unit-test coverage for the most complex handler in the chain.**
   `chat_message` has ~70 LoC of inline validation + persistence + fan-out
   + mention handling. It writes to 3 tables and broadcasts to N
   participants. Testing it required spinning up the WebSocket server,
   stubbing JWT auth, and sending real frames — that's why it shipped
   with zero unit tests despite being the second-busiest handler in the
   app.

2. **The "inline validation" patterns leak.** Every handler opens with
   the same shape of `if (!x || typeof x !== 'string' || x.length > N)
   return;` checks, with subtly different bounds in each. That's exactly
   the kind of pattern where a typo silently lets bad input through;
   silent drops were the user-visible failure mode that already cost us
   ADR-002.

ADR-009 ships the **first** extraction (`chat_message`) and the **shared
schema primitive** (`wsValidate`) that future extractions will adopt.
Subsequent handlers will follow the same template once the metrics
panel from ADR-005 tells us which to prioritise.

---

## Decision

Three additive changes. No new runtime dependency. ~280 LoC of new code,
~70 LoC of inline handler code DELETED from `ws.js`.

### 1. `server/utils/wsValidate.js` — tiny zero-dep schema validator

```js
const { schema, validate } = require('../utils/wsValidate');

const myShape = {
    conversationId: schema.posInt(),
    content:        schema.str({ min: 1, max: 5_000 }),
    replyToId:      schema.posInt({ optional: true }),
    formatType:     schema.str({ max: 16, optional: true }),
    clientMsgId:    schema.str({ max: 64, optional: true }),
};

const parsed = validate(myShape, msg.data);
if (!parsed.ok) { /* parsed.errors[fieldName] = 'reason' */ }
```

Six primitives: `str`, `posInt`, `num`, `bool`, `enumOf`, plus the
top-level `validate(shape, data)`. Each primitive returns
`{ ok, error?, value? }` so error reporting is uniform.

**Why not zod?**
- Bundle size: zod is ~50 KB; this is ~3 KB.
- Surface area: zod has 30+ schema types we don't use. We use 5.
- Auditability: a contributor can read the whole module in 60 seconds.
- The contract is intentionally zod-shaped (`{ ok, value }` /
  `{ ok: false, errors }`) so a swap to zod later is a textual
  replacement.

### 2. `server/utils/wsHandlers/chatMessage.js` — first extracted handler

The whole `if (msg.type === 'chat_message')` block from `ws.js` moved
into its own file. Signature:

```js
async function chatMessage({ db, senderId, tenantId, data, ws, sendToUser })
```

Key contract changes:

- **`sendToUser` is injected** — the handler doesn't `require('../ws')`,
  avoiding a circular import. The call-site in `ws.js` passes its own
  `sendToUser` in.
- **Schema check first**, before any DB access. Malformed input is
  rejected with a typed `chat_message_error` ack carrying `clientMsgId`
  + structured `reason` (e.g. `validation:content=too-long`,
  `unsafe-content`, `not-a-participant`). The previous code silently
  dropped, leaving the client's optimistic bubble stuck in `_pending`
  until the retry timer flipped it to `_failed`.
- **Same DB writes + fan-out + mention notifications** — pure refactor
  of behaviour for valid inputs.

### 3. `ws.js` call-site

The 70-line inline block is replaced with a 7-line delegation:

```js
if (msg.type === 'chat_message') {
    await chatMessage({ db, senderId, tenantId, data: msg.data || {}, ws, sendToUser });
    return;
}
```

The rest of `handleChatMessage` is untouched. Future handler extractions
slot in the same way.

---

## Consequences

### Positive

- **First unit-testable WS handler in the codebase.** 9 new tests
  (5 validation paths + 4 happy-path scenarios) for what was previously
  ~0% covered logic.
- **Typed error replies** for the chat-send path. Clients can now show
  meaningful "message couldn't send because …" UX instead of generic
  "_failed" after a 10s timeout.
- **Zero-dep schema primitive** is now available for every future
  handler extraction. Each follow-up adoption is ~10 lines of changes
  in the handler + 10 lines of validation.
- **Template established.** The next handler extraction is a copy-
  paste-edit (new schema, new file under `wsHandlers/`, two-line swap
  in `ws.js`). The risky part — establishing the dependency-injection
  pattern that avoids circular imports — was solved once here.
- **`ws.js` got slightly smaller** (~70 LoC deleted, ~7 added). The
  goal is for `ws.js` to eventually be a thin dispatcher that just
  routes to handlers.

### Negative

- One more directory to navigate (`wsHandlers/`). Mitigated by the
  consistent naming (`<eventType>.js`) and the single-purpose nature.
- The hand-rolled validator is one more thing the team owns. Mitigated
  by the test suite (13 tests, every primitive + edge case) and the
  ~150 LoC implementation size.
- **24 handlers still live inline in `ws.js`.** This ADR only extracts
  the one with the worst test coverage gap; the rest are intentionally
  deferred until `/api/internal/ws-stats` data (from ADR-005) tells us
  which is the next worst.

### Neutral

- Server test count went from 418 → 443 (+25 — the wsValidate suite
  added 13 tests, the chat-message handler suite added 9, plus 3 jest
  setup tests came along for the ride). Client unchanged.
- The extracted handler's behaviour for **valid inputs** is bit-for-bit
  identical to the previous inline implementation. The only behavioural
  difference is "garbage in" now gets a typed error rather than silent
  drop — which is a strict improvement.

---

## Out of scope (next ADR slots)

Each of these is a single follow-up ADR of roughly this size. **Drive
priority by `/api/internal/ws-stats` data, not speculation.**

- **Extract `meeting_chat`** — second-most-complex handler, has the
  `meeting_message_ack` round-trip + the `meeting_chat_replay`
  companion. Probably worth doing next purely because it's adjacent
  to what we just touched.
- **Extract `call_signal` + `meeting_signal`** — highest WS message
  volume by far. The schema work would land first; the handlers
  themselves are simpler than `chat_message`.
- **Adopt `withIdempotency` for `meeting_add_participant`** —
  ADR-007's foundation already supports it; just needs the wrapper.
- **Per-handler circuit breakers** for handlers with measurable
  `errorRate > 1 %` over a sustained window in the stats panel.

---

## Files changed

- `server/utils/wsValidate.js` — **new** (~150 LoC). Schema primitives
  + `validate()` aggregator. Zero runtime deps.
- `server/utils/wsHandlers/chatMessage.js` — **new** (~165 LoC).
  Extracted handler with injected `sendToUser`. Sends typed
  `chat_message_error` ack on validation failure.
- `server/utils/ws.js`:
  - imports `chatMessage` from the new module
  - 70-line inline block replaced with a 7-line delegation
- `server/__tests__/wsValidate.test.js` — **new**, 13 tests covering
  every primitive + `validate()` aggregation.
- `server/__tests__/wsHandlers.chatMessage.test.js` — **new**, 9 tests
  covering validation (5 paths) + happy-path persistence/fan-out
  (4 scenarios).

## Test summary

```
server:  Test Suites: 35 passed, 35 total | Tests: 443 passed, 443 total  (418 → +25)
client:  Test Files:  16 passed, 16 total | Tests: 118 passed, 118 total  (unchanged)