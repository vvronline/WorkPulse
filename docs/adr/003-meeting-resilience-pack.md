# ADR-003 — Meeting Resilience Pack (Phase 1)

**Status**: Accepted, implemented as Phase 1 of the meeting-reliability roadmap.
**Date**: 2026-05-26
**Related**: ADR-001 (status service v2), ADR-002 (in-meeting chat reliability — Phase 0.5), follow-up Phases 2–6.

---

## Context

ADR-002 (Phase 0.5) fixed the most user-visible reliability problem —
disappearing chat messages — by introducing client-mint `clientMsgId`s,
idempotent server inserts, an `ack` round-trip, and a per-meeting
module-scope cache.

The other reliability cliffs that show up on flaky networks are:

1. **One transient HTTP failure during join strands the user.** The
   `getIceConfig` call had no retry, so a single 5xx blip kicked the
   user back to STUN-only servers (which can't traverse symmetric NATs
   used by most corporate Wi-Fi).
2. **Status string is a stringly-typed grab-bag.** The hook exposed a
   flat `'joining' | 'connecting' | 'connected' | 'ended' | 'left' | 'failed'`
   string updated from ~6 different places, and a single peer
   transitioning to `disconnected` would flap the global value back to
   `connecting` for ~5 s — making the spinner flicker every time the
   mesh churned during normal use.
3. **Devicechange events were ignored.** When a user unplugged a USB
   headset or the laptop lid woke and the camera re-enumerated
   differently, remote peers saw a frozen frame forever. The local
   client kept sending the (now-ended) track.
4. **No user-facing signal when the WS or network drops.** Users
   thought the app "froze" instead of "is reconnecting" — particularly
   bad UX on the 5–15 s reconnect window during a Wi-Fi handoff.
5. **No reusable retry-with-backoff helper.** Each caller that
   *should* have retried open-coded it differently or skipped it
   entirely (chat hydration was a fire-and-forget for example).

---

## Decision

Ship a small, surgical "Resilience Pack" — three new modules plus
hooks into the existing meeting code. All additive, all under 400
LoC, zero new dependencies.

### 1. `client/src/utils/retryWithBackoff.js`

Generic exponential-backoff retry with full jitter, `AbortSignal`
support, and a `shouldRetry(err, attempt)` escape hatch. Also exports
`withTimeout(ms, fn)` which uses native `AbortSignal.timeout()` where
available and falls back to a manual `AbortController` for older
runtimes / the test environment.

This util replaces ~5 inline ad-hoc retry loops across the meeting
code and gives every future caller a uniform "try, back off, give up
cleanly" path. First adopter: `getIceConfig` (4 attempts, 0.3–4 s).

### 2. `client/src/pages/meeting/connectionStateMachine.js`

A pure (no React, no side effects) FSM with 9 named states:

```
idle → joining → connecting → connected
                      ↑           ↓
                      └── reconnecting
                            ↑   ↓
                    degraded ← ws_close / offline
```

`nextState(currentState, event)` enforces legal transitions; terminal
states (`left`, `ended`, `failed`) are sticky. `describeState(s)`
returns `{ label, severity, showBanner }` — all UI copy lives in one
place. **Trivially testable** (100% pure functions); 8 unit tests
cover happy path, reconnect flapping, terminal stickiness, and idle-
state noise suppression.

### 3. Hooked into `useMeetingState`

- New `dispatchFsm(event)` funnel; every existing state transition
  also fires the right FSM event.
- New `connectionBanner` return value computed via `describeState`.
- WS `open`/`close`, network `online`/`offline`, and per-peer
  `connected`/`disconnected`/`failed` callbacks all feed into the FSM.
- The hook continues to expose the flat `status` string for back-compat
  — every existing consumer of `status === 'ended'` etc still works.

### 4. Devicechange listener

A new `useEffect` registers `navigator.mediaDevices.addEventListener(
'devicechange', …)`. When a video track has `readyState === 'ended'`
(camera unplugged) we call `replaceVideoTrackOnPeers(null)` so peers
immediately see "video off" instead of a frozen frame, and broadcast
the new track state. We deliberately do **not** force re-acquisition
— that would surprise the user.

### 5. Degraded-mode banner in `MeetingRoom`

A non-blocking pill at the top of the meeting view, driven directly
by `connectionBanner.showBanner`. Two severities: `warn` (orange,
"Reconnecting to a participant…" / "You appear to be offline") and
`error` (red, "Unable to join — please check camera/mic permissions").
The meeting keeps working underneath; this is purely informational.

---

## Consequences

### Positive

- Single-place transition table makes future state changes safe to add
  (Phase 4's Zustand store will just call `fsmNext` from the store
  action — no rewrite needed).
- `retryWithBackoff` is reusable everywhere; first adoption immediately
  fixes the "transient ICE fetch failure → STUN-only" footgun.
- Users now see a clear "Reconnecting…" banner during the 15 s WS
  grace window instead of wondering if the app froze.
- Devicechange handling closes the silent-black-tile failure mode that
  occurred every time someone unplugged a headset mid-meeting.
- 14 new unit tests (8 FSM + 6 retry), all green. Total client
  test count went from 89 → 103.

### Negative

- Two new client-only modules (~300 LoC combined).
- The FSM intentionally **collapses transient peer churn** into the
  `connected` state for stability — this means we will *not* surface
  the very first peer's brief disconnect-then-reconnect cycle. That's
  a deliberate trade-off (no flicker for the common case) but means
  ops/debug folks who want the raw signal still need `console.log`
  on the peer-connection callbacks.

### Neutral

- The flat `status` string is now a back-compat shim. Phase 4 may
  delete it entirely once every consumer is on the FSM state.
- We chose **not** to implement the preflight (preview) check in this
  pass. The device probe + ICE reachability check is well understood
  but needs UX work in `MeetingJoin.jsx` that's beyond the scope of
  pure reliability. Deferred to a follow-up.

---

## Out of scope (still TODO)

- **Preflight check** (`MeetingJoin.jsx` preview): probe ICE
  reachability + run a 1-second camera/mic test and surface results
  before the user clicks Join. Needs design treatment.
- **Simulcast / active-speaker** (Phase 5).
- **Zustand store** (Phase 4) — supersedes the messagesCache + the
  flat status shim.
- **Event-sequence Redis ring buffer** (Phase 2).

---

## Files changed

- `client/src/utils/retryWithBackoff.js` — **new**.
- `client/src/pages/meeting/connectionStateMachine.js` — **new**.
- `client/src/pages/meeting/useMeetingState.js`:
  - imports new utils
  - new `dispatchFsm` + `fsmState` ref
  - WS `open`/`close` + network `online`/`offline` listeners
  - devicechange listener
  - `getIceConfig` wrapped in `retryWithBackoff`
  - all peer-connection state changes fire FSM events
  - returns `fsmState` + `connectionBanner`
- `client/src/pages/MeetingRoom.jsx` — renders the degraded banner.
- `client/src/pages/meeting/MeetingRoom.css` — banner styles.
- `client/src/__tests__/connectionStateMachine.test.js` — **new**, 8 tests.
- `client/src/__tests__/retryWithBackoff.test.js` — **new**, 6 tests.