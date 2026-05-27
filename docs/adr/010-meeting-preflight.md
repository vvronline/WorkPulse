# ADR-010 — Meeting Preflight Check

**Status**: Accepted. Foundation utility shipped; UI adoption gated on focused design pass.
**Date**: 2026-05-26
**Related**: ADR-003 (Resilience Pack), ADR-008 (MeetingStore foundation).

---

## Context

`MeetingJoin.jsx` already runs two checks before letting the user click Join:

1. **Camera + microphone access** via `getUserMedia`
2. **Network speed** via the existing `checkNetworkSpeed` heuristic

It does NOT verify:

- **ICE reachability** — can the browser actually exchange candidates with
  the configured STUN/TURN servers? Corporate firewalls + symmetric NATs
  commonly block UDP entirely, forcing the meeting onto TCP/443 TURN.
  Without a preflight, the user discovers this at the moment the very
  first peer tries to connect and sees a black tile. That bug looks
  identical to "the other person's camera is off", which is impossible
  for support to diagnose without logs.
- **TURN credential validity** — our credentials are time-bound (~30 min).
  A meeting joined right before expiry can hand out an already-stale
  TURN config.

ADR-003's Resilience Pack added the `retryWithBackoff` around
`getIceConfig` so a transient HTTP failure doesn't strand the user on
the default STUN-only set. ADR-010 closes the next gap: **proving the
ICE servers actually work before committing the user to a meeting**.

---

## Decision

Ship the **utility + tests + the summariser the UI will use** in this
ADR. Wiring the banner into `MeetingJoin.jsx` is deferred to a focused
follow-up — the utility is independently valuable today (admin health
checks can call it; the meeting room can run it on `degraded` FSM
transitions to verify recovery is possible).

### 1. `client/src/pages/meeting/preflight.js` (new, ~155 LoC)

Two pure functions:

```js
const result = await runPreflight({
    iceServers,                      // defaults to public STUN
    timeoutMs: 5_000,                // give-up budget
    onCandidate: (type, c) => { … }, // optional trace
});
// → { ok, hasLocalCandidate, hasHostCandidate, hasSrflxCandidate,
//     hasRelayCandidate, elapsedMs, errorCode? }

const banner = summarisePreflight(result);
// → { severity: 'ok' | 'warn' | 'error', label: 'human text' }
```

**Implementation**:
- Spins up a throwaway `RTCPeerConnection`, adds a recvonly audio
  transceiver (no `getUserMedia` needed — preflight must be cheap), and
  watches `onicecandidate` until either:
  1. Gathering completes (`null` candidate or `iceGatheringState === 'complete'`)
  2. `timeoutMs` expires
- Classifies each candidate as `host` / `srflx` / `relay` by reading
  `.type` (modern) with a fallback to parsing the SDP line (older
  browsers + some embedded WebViews).
- **Verdict policy**: `ok` is `true` if ANY candidate appeared. Host-only
  is sufficient because (a) it proves the browser stack works and (b)
  LAN-only deployments are legitimate. The summariser separately
  flags host-only as `warn` so the user knows they may have trouble
  outside their network.

**Why we don't try a full loopback peer connection**:
- Would need a second `RTCPeerConnection` for signalling, doubling
  complexity.
- Round-trip alone would dominate latency (~3-5s).
- Candidate gathering catches every problem that matters: "STUN/TURN
  unreachable" and "browser blocked WebRTC entirely". The actual
  in-meeting connection failures beyond that are network-path
  problems that no preflight can predict (e.g. symmetric NAT on the
  remote side).

### 2. `summarisePreflight` — the UI bridge

Six branches → three severities. The UI consumer just renders the
returned `{ severity, label }` shape; no preflight knowledge leaks
into the component.

| Condition                              | Severity | Label                                                             |
|----------------------------------------|----------|-------------------------------------------------------------------|
| `errorCode === 'no-rtcpeerconnection'` | error    | Your browser doesn't support real-time calls                      |
| `!ok` (timeout / no candidates)        | error    | Unable to reach STUN/TURN servers — your network may block WebRTC |
| TURN reachable                         | ok       | Network looks good (TURN reachable)                               |
| STUN reachable                         | ok       | Network looks good (STUN reachable)                               |
| Host-only                              | warn     | Only local candidates found — may not work outside your network   |
| `ok` but no candidates classified      | error    | No ICE candidates gathered                                        |

### Why ship the utility now, defer the MeetingJoin wiring?

Same pattern as ADR-008 (MeetingStore foundation):
- The utility is **immediately useful** outside MeetingJoin —
  `useMeetingState`'s FSM can call it on a `degraded` → `connecting`
  transition to verify recovery is possible; the `/api/internal/ws-stats`
  panel from ADR-005 could surface preflight pass rate per tenant.
- The MeetingJoin wiring is a **UX decision** (blocking modal vs
  warning banner vs background trace) that benefits from a focused
  review separate from the runtime code.
- Locks the contract NOW so a follow-up wiring PR can't drift.

---

## Consequences

### Positive

- **Closes the "black tile" failure mode** at the source. We can finally
  tell a user "your network is blocking WebRTC" before they commit to
  joining and waste 30 seconds discovering it themselves.
- **Pure module, no runtime deps**. Trivially testable (14 tests
  covering every branch via a fake RTCPeerConnection class).
- **Sub-second on healthy networks** (~50-300 ms typical) — gathering
  completes the moment the first STUN binding response arrives. The
  5 s timeout is a give-up, not a normal-case wait.
- **Zero `getUserMedia` cost** — the preflight doesn't touch the
  camera/mic, so it can run in the background without prompting for
  permissions or affecting battery on laptops.
- **Reusable surface**: the utility takes injected `iceServers`, so
  callers can pass production TURN credentials (during MeetingJoin)
  OR a public STUN-only set (during admin health checks) without
  branching.

### Negative

- **Preflight is opt-in until the UI lands**. Until a caller actually
  invokes `runPreflight`, this ADR ships dead code. Mitigated by:
  the foundational nature of the utility, immediate availability for
  ad-hoc admin scripts, and the test coverage guaranteeing it'll work
  the day the UI calls it.
- **False positives are possible** — a successful preflight doesn't
  guarantee a successful in-meeting connection. A peer behind a
  symmetric NAT that the preflight didn't talk to can still fail.
  The point of preflight is to catch the EASY 80 % of failures
  before the user joins; the remaining 20 % are handled by ADR-003's
  FSM + degraded-mode banner.

### Neutral

- Bumped client test count from 118 → 132 (+14 — 8 for `runPreflight`
  including the WebRTC-missing path, the all-candidates path, the
  SDP-string fallback, the timeout, both error paths, the trace
  callback, the default-timeout constant; plus 6 for `summarisePreflight`
  covering each severity branch).
- Server test count unchanged.

---

## Out of scope (follow-up)

- **Wire into MeetingJoin.jsx**: run preflight in parallel with
  `getUserMedia` + the network speed check; render the
  `summarisePreflight` banner near the existing connection-quality
  indicator. Blocking vs warning is a UX decision.
- **Periodic re-run in MeetingRoom**: when the FSM transitions to
  `degraded`, re-run with the current ICE config to verify recovery
  is even possible. If preflight now fails, surface a stronger error
  than the "Reconnecting…" banner.
- **Expose pass-rate metric** via `/api/internal/ws-stats` so we
  can detect regressions in TURN reachability per tenant.

---

## Files changed

- `client/src/pages/meeting/preflight.js` — **new** (~155 LoC).
  `runPreflight`, `summarisePreflight`, `DEFAULT_TIMEOUT_MS`.
- `client/src/__tests__/preflight.test.js` — **new**, 14 tests
  across two describe blocks: `runPreflight` (8 — WebRTC missing,
  all candidate kinds, SDP fallback, timeout, createOffer failure,
  constructor failure, trace callback, default timeout constant) +
  `summarisePreflight` (6 — null, no-rtc, TURN, STUN, host-only,
  no-candidates).

## Test summary

```
server:  Test Suites: 35 passed, 35 total | Tests: 443 passed, 443 total  (unchanged)
client:  Test Files:  17 passed, 17 total | Tests: 132 passed, 132 total  (118 → +14)