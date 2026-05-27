# ADR-002 — In-meeting chat reliability

**Status**: Accepted, implemented as Phase 0.5 of the meeting-reliability roadmap.
**Date**: 2026-05-26
**Related**: ADR-001 (status service v2), follow-up Phases 1–6 in the meeting plan.

---

## Context

Users on flaky networks intermittently reported that **in-meeting chat
messages disappeared** — sometimes the sender's own message after a
refresh, sometimes a peer's message that "never arrived". Investigation
turned up **five overlapping defects**, each individually small but
collectively producing the perceived data loss:

1. `messages` lived only inside `useMeetingState`'s React state. Any
   remount of `MeetingRoom` (PiP swap-back, navigation, Strict Mode
   double-invoke, theme provider flush) gave a fresh empty array; the
   ~200–800 ms HTTP re-hydration window looked like a blank panel.
2. The hydration effect re-ran only when the meeting `code` changed —
   **never on WS reconnect**. Messages sent during a 5–15 s WS drop were
   silently lost (the server's broadcast loop only delivered to
   participants in `status='joined'` at that exact instant).
3. The outgoing `wsSend('meeting_chat', …)` call was fire-and-forget.
   If the WS was mid-reconnect the frame went nowhere. The sender's
   optimistic bubble sat there indefinitely, then vanished on the next
   refresh because nothing was ever persisted server-side.
4. Optimistic dedup matched by `(sender_id + text)` which broke for
   files and double-sent identical text ("ok" → "ok").
5. The server's `meeting_chat` persist failure was a `logger.warn(…)`
   followed by an ephemeral broadcast. Transient DB hiccups produced
   never-persisted messages that vanished on the next rejoin without
   any user-visible signal.

The user kept seeing some combination of these depending on which
defect triggered first.

---

## Decision

Treat in-meeting chat as **at-least-once delivery with idempotent
persistence**, modelled on the same patterns RealtimeKit / Dyte / videosdk
ship in their reference clients — but reimplemented natively in WorkPulse
so we don't take on any new vendor cost or signaling plane.

Six concrete changes, all additive:

### 1. Module-scope per-meeting message cache (`messagesCache.js`)

Lives at module scope keyed by meeting code. The hook seeds its initial
`useState` from the cache and writes back on every change. A remount
of `MeetingRoom` re-reads the cache instantly — no blank-panel flash.
The cache is intentionally NOT persisted to `localStorage` (history is
already in the DB, and we don't want cross-tab leakage).

### 2. Client-generated `clientMsgId` (UUID) on every outgoing message

Round-tripped through the server in the `clientMsgId` / `client_msg_id`
field. Used as the canonical dedup key in two places:
  * The pending-send retry queue (server echo or ack → remove from queue).
  * The receiver dedup (collapse optimistic bubble with server echo
    without depending on text/file equality).

`crypto.randomUUID()` with a `Math.random` fallback for the test
environment.

### 3. DB idempotency: partial unique index + `INSERT … ON CONFLICT DO NOTHING`

Migration `2026_06_v8_messages_client_msg_id` adds a nullable
`client_msg_id TEXT` column on `messages` plus the partial unique index:

```sql
CREATE UNIQUE INDEX idx_messages_client_msg_id
ON messages (conversation_id, sender_id, client_msg_id)
WHERE client_msg_id IS NOT NULL;
```

The server's `meeting_chat` handler now uses
`INSERT … ON CONFLICT (conversation_id, sender_id, client_msg_id)
WHERE client_msg_id IS NOT NULL DO NOTHING RETURNING id, created_at`.
On conflict (i.e. a retry from a flaky client) it fetches the existing
row's id so the echo carries the canonical primary key. **Retries are
free — they can never create duplicates.**

The column is nullable so every pre-existing chat message keeps working
unchanged. The full schema bootstrap in `db.js` also gets the column +
index so brand-new tenants are self-consistent.

### 4. Pending-send retry queue + ack/error WS messages

Two new server → client WS message types:
  * `meeting_message_ack { clientMsgId, id, createdAt }` — sent to the
    sender **immediately after persistence**, decoupled from the
    broadcast loop. This is critical because the broadcast only reaches
    currently-joined participants; a sender mid-reconnect would
    otherwise never see the echo of their own message.
  * `meeting_message_error { clientMsgId, reason }` — sent when the
    server rejects the message. The client flips the optimistic bubble
    to `_failed` so the UI can surface a retry button.

The client maintains `pendingSendsRef: Map<clientMsgId, …>`. A periodic
retry loop (every 1.5 s) re-sends anything still pending if WS is open,
and after 10 s without an ack flips the bubble to `_failed` (red badge
+ "tap to retry" affordance in `MeetingChat.jsx`).

### 5. WS-open replay topic + REST `?since=` parameter

  * New WS topic `meeting_chat_replay { meetingId, sinceMessageId? }`:
    the server returns every message with `id > sinceMessageId`,
    capped at 200, then a `meeting_chat_replay_done` marker. The client
    sends this on every `ws.onopen` with the highest id it currently
    has — closing the "messages sent during a brief WS drop" hole
    without a full REST round-trip.
  * REST `GET /:code/messages` now accepts `?since=<id>` for the same
    incremental-backfill purpose, and includes `client_msg_id` in every
    row so the client can dedupe persisted rows against any still-pending
    optimistic sends.

### 6. Broadcast audience widened

The previous `meeting_chat` broadcast loop filtered to
`status='joined'` only — so anyone in the 15 s
`MEETING_DISCONNECT_GRACE_MS` reconnect window missed live messages
entirely. The handler now broadcasts to everyone with status `joined`
**or `invited`** (`sendToUser` is a no-op for users with no open WS).
Combined with the replay topic and REST hydration, this means a user
**will see every message no matter when they reconnect.**

---

## Consequences

### Positive

* Eliminates all five failure modes documented above.
* All 377 server tests + 89 client tests continue to pass — additive
  changes only, no breaking API contract.
* The `clientMsgId` round-trip generalises beyond meeting chat — the
  same pattern is reused by Phase 2's per-message idempotency for
  every WS handler.
* The module-scope cache is a stepping stone toward the Phase 4
  Zustand store (which subsumes both the cache and the in-hook state).
* `meeting_message_ack` is the building block for Phase 1's
  connection-state-machine — the "Sending… / Failed" indicator is
  the first surfaced reliability signal.

### Negative

* Two new server → client WS message types (`meeting_message_ack`,
  `meeting_message_error`) plus one new client → server type
  (`meeting_chat_replay`). All additive — old clients keep working,
  they just don't get the new reliability guarantees. New clients
  always send `clientMsgId`.
* One new DB column + index. Negligible storage cost (~32 chars per
  message, only populated for new in-meeting messages).
* `MeetingChat.jsx` grew a few lines for the status indicators and
  retry button (~30 LoC).

### Neutral

* Module-scope cache is bounded by tenant×meeting usage; meetings the
  user never rejoins still consume memory until tab close. Acceptable
  given typical session lengths; Phase 4's store handles GC via
  `clearMessagesCache` on explicit leave.

---

## Out of scope

These were considered and explicitly deferred:

* **Replacing module-scope cache with Zustand store** — happens in
  Phase 4 of the broader meeting plan.
* **Generalising `meeting_chat_replay` to a per-meeting event
  sequence** — Phase 2 of the plan (Redis ring buffer).
* **Server-side recording** — Phase 4.5 (separate ADR planned).

---

## Files changed

* `server/utils/migrationRunner.js` — migration
  `2026_06_v8_messages_client_msg_id`.
* `server/db.js` — schema bootstrap mirrors the migration so fresh
  tenants are self-consistent.
* `server/utils/ws.js` — `meeting_chat` handler rewritten to ack /
  error / persist idempotently; new `meeting_chat_replay` topic.
* `server/routes/meetings.js` — `GET /:code/messages` accepts `?since=`
  and includes `client_msg_id`.
* `client/src/pages/meeting/messagesCache.js` — **new** module-scope
  per-meeting cache.
* `client/src/pages/meeting/useMeetingState.js` — seed/write cache,
  hydrate on WS open, `clientMsgId` round-trip, pending-send queue,
  retry loop, `retryMessage` export.
* `client/src/pages/meeting/MeetingChat.jsx` — stable React keys,
  pending/failed/uploading status indicators, retry affordance.
* `client/src/pages/meeting/MeetingRoom.css` — styles for the new
  status indicators.
* `client/src/pages/MeetingRoom.jsx` — wires `retryMessage` into
  `<MeetingChat />`.