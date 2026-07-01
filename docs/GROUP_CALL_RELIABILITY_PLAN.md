 # Group-Call (Mesh) Reliability Overhaul — Resumable Tracker (Phase 1→5)

> **Purpose**: Single source of truth for porting the proven 1:1 call-reliability
> patterns (see `CALL_RELIABILITY_PLAN.md`) onto the N-party WebRTC **mesh** so
> group calls of **5–10 people** are stable, robust and error-free **without an
> SFU**. A fresh context window MUST read this file first and resume from the
> first unchecked item. Update checkboxes immediately after each sub-task. Never
> hand off mid-edit — finish each item to a `tsc --noEmit` clean state.

## Goal
Make every mesh peer connect deterministically and recover from network blips,
mirroring the 1:1 path's Signal-grade reliability. The mesh transport
(`meeting_*` WS protocol) is shared by web (`client/src/pages/meeting/useMeetingState.ts`),
mobile (`mobile/src/meeting/useMeetingMesh.ts`) and the server relay
(`server/utils/ws.ts`). Group voice/video CALLS reuse this mesh as "huddles".

## Build / verify commands (Windows PowerShell)
- Server: `cd server && npx tsc --noEmit > tscout.txt 2>&1` (empty file = clean), then delete it.
- Web:    `cd client && npx tsc --noEmit > tscout.txt 2>&1`
- Mobile: `cd mobile && npx tsc --noEmit > tscout.txt 2>&1`
- NOTE: terminal output streaming is unreliable in this shell — ALWAYS redirect
  to a file and read it back (empty = clean).

## Realistic ceiling (no SFU)
A WebRTC mesh uploads N−1 copies per peer, so it fundamentally caps at
~**6–8 reliable video / ~10 audio** participants. Target: rock-solid audio for
10, stable video for ~5–6, graceful active-speaker degradation beyond that.
Flawless 10-way video requires an SFU (explicitly out of scope).

## Canonical protocol additions (Phase 1 — DONE server-side)
- New WS client→server: `meeting_subscribe { meetingId }`,
  `meeting_ready { meetingId }`.
- New WS server→client: `meeting_peer_ready { meetingId, userId }` (tells the
  OTHER joined peers to (re)offer toward `userId` — idempotent via Perfect
  Negotiation once Phase 2 lands).
- Server now BUFFERS mesh `offer`/`candidate` destined for an offline peer and
  REPLAYS on (re)join / subscribe / ready (Signal-style reliable delivery).

---

## ✅ Phase 1 — Server: reliable mesh signaling — DONE (`tsc` clean)
File: `server/utils/ws.ts`

### 1.1 — Mesh signal buffer infra
- Added `BufferedMeetingPeerSignals` / `BufferedMeetingSignals` +
  `_meetingSignalBuffers` Map (TTL 60s, cap 2000 meetings, 80 ICE/peer-pair),
  keyed `meetingId → targetUserId → fromUserId`. Helpers:
  `bufferMeetingSignal`, `replayMeetingSignals`, `clearMeetingUserBuffer`,
  `clearMeetingBuffer`, plus `_prune…`/`_getOrCreate…`. Located right after the
  1:1 `clearCallBuffer`.

### 1.2 — Buffer on `meeting_signal` relay miss
- In `meeting_signal` handler: when `signal.type` is `offer`/`candidate` AND the
  target has no open socket (`hasOpenSocket`), `bufferMeetingSignal(...)`. Still
  relays normally (cross-instance via `sendToUser`).

### 1.3 — Replay + `meeting_peer_ready` handshake
- New `meeting_subscribe` handler: `replayMeetingSignals` to the sender + emit
  `meeting_peer_ready` to every OTHER joined peer.
- New `meeting_ready` handler: identical (distinct verb = "media+PCs ready" vs
  "WS subscribed").
- `meeting_join`: after the `meeting_participant_joined` fan-out, also
  `replayMeetingSignals` to the joiner (happy path needs no extra round-trip).

### 1.4 — Buffer clears on teardown
- `clearMeetingUserBuffer(meetingId, userId)` on explicit `meeting_leave` and on
  grace-expiry cleanup; `clearMeetingBuffer(meetingId)` when the meeting empties
  and in `meeting_end`.

### 1.5 — Verify
- `cd server && npx tsc --noEmit` → 0 chars (clean). ✅

---

## ✅ Phase 2 — Shared negotiation core (web + mobile parity) — DONE (`tsc` clean ×3)
Files: `client/src/pages/meeting/useMeetingState.ts`,
`mobile/src/meeting/useMeetingMesh.ts`

### 2.1 — Perfect Negotiation per peer (kills renegotiation glare) ✅ DONE (`tsc` clean ×3)
- Replace the fixed initiator/non-initiator rule with deterministic politeness:
  `polite = String(selfId) > String(remoteId)`. On an inbound offer collision
  (`signalingState !== "stable"` AND we have a local offer), the **impolite**
  peer ignores the incoming offer; the **polite** peer rolls back
  (`setLocalDescription({type:"rollback"})`) then accepts. Add an
  `isSettingRemoteAnswerPending` / `makingOffer` guard set, mirroring the 1:1
  `useWebRTC.ts` Perfect-Negotiation block. This is the fix for video-toggle /
  ICE-restart deadlocks (G3).
- Keep the EXISTING glare-free initial-offer rule (existing peers initiate toward
  newcomer) as the bootstrap; Perfect Negotiation governs all RE-negotiation.
- **Implemented**:
  - WEB (`useMeetingState.ts`): `ExtendedPC` gained `_polite`/`_makingOffer`/
    `_isSettingRemoteAnswerPending`. In `createPeerConnection` we set
    `_polite = String(user.id) > String(remoteUserId)`, wrap the initiator
    `createOffer→setLocalDescription` in `_makingOffer=true … finally false`,
    and `handleSignal`'s offer branch now computes
    `offerCollision = _makingOffer || signalingState!=="stable"`, impolite peer
    returns, polite peer rolls back then accepts.
  - MOBILE (`useMeetingMesh.ts`): `PeerEntry` gained `polite`/`makingOffer`;
    set in `createPeer` (`polite = normId(selfId) > key`), `makingOffer` wraps
    the initiator offer, and `handleSignal` does the same collision guard
    (looks up the entry by `normId(fromUserId)` for `polite`/`makingOffer`).
  - Renegotiation paths (video toggle, screen-share add/remove) are covered by
    the `signalingState!=="stable"` arm of the guard — no per-callsite changes.

### 2.2 — `meeting_peer_ready` consumers ✅ DONE (`tsc` clean ×3)
- BOTH clients: on inbound `meeting_peer_ready { userId }`, if we have a live PC
  toward `userId` whose `localDescription.type==="offer"`, re-send that offer
  once (idempotent). If no PC exists yet, create one as initiator. Add a
  `meeting_subscribe` send once the WS handler is attached + media acquired, and
  `meeting_ready` once PCs are built (mirror 1:1 P0.4/P0.6).
- **Implemented**:
  - WEB (`useMeetingState.ts`): added `subscribedRef`/`readySentRef` guards
    (reset on each fresh WS connection in the join effect). `sendJoin` now also
    emits `meeting_subscribe` once. The `meeting_participant_joined` handler
    emits `meeting_ready` once PCs are built (`hasPeersToConnect`). New
    `meeting_peer_ready` case: if a PC exists with an `offer` localDescription,
    re-send that offer; else create an initiator PC.
  - MOBILE (`useMeetingMesh.ts`): added `subscribedRef`/`readySentRef` (reset in
    `leave()`). After a successful `meeting_join`, emits `meeting_subscribe`. The
    `meeting_participant_joined` handler emits `meeting_ready` once PCs are built.
    New `meeting_peer_ready` case mirrors web: re-send the offer if present, else
    `createPeer(userId, true)`.
  - Both re-offers are idempotent under the Phase 2.1 Perfect-Negotiation guard.

### 2.3 — Web outbound signal queue (G4) ✅ DONE (`tsc` clean ×3)
- `useMeetingState.wsSend` previously dropped frames when `readyState !== 1`.
  Route mesh sends through the same queue-on-closed-flush-on-open guarantee the
  1:1 path uses (the shared `useWebSocket` sendMessage already does this for the
  1:1 screen — adopt it here, or add a small outbound queue + onopen flush).
  Mobile already has `socket.sendWithRetry`/`sendWithBackoff` — route every mesh
  `socket.send("meeting_signal", …)` through it.
- **Implemented**:
  - WEB (`useMeetingState.ts`): added `outboundQueueRef` +
    `flushOutboundQueue()`. `wsSend` now enqueues the frame (bounded by
    `OUTBOUND_QUEUE_MAX = 500`, oldest-evicted) whenever the socket isn't OPEN or
    a `send()` throws, instead of silently dropping it. The existing on-`open`
    `flushAndReplay` effect calls `flushOutboundQueue()` first so queued
    offer/answer/ICE/track-state frames replay in order on reconnect. The join
    effect clears the queue on a fresh WS connection (PCs are torn down + rebuilt
    from the authoritative `existingPeers`, so stale frames would target dead
    PCs).
  - MOBILE (`useMeetingMesh.ts`): added a `sendSignal()` helper that routes every
    mesh `meeting_signal` frame through `socket.sendWithRetry` (6s / 200ms) —
    replacing the bare `socket.send` at all five signaling call-sites
    (onicecandidate, ICE-restart offer, initiator offer, answer, and the
    `meeting_peer_ready` re-offer). Happy path still sends synchronously
    (order-preserving); a blip retries until the socket reopens. Dep arrays for
    `createPeer`/`handleSignal`/`handleWsMessage` updated to include `sendSignal`.
    (Lifecycle/state frames — join/subscribe/ready/track_state/leave — already
    use `sendWithRetry` or are fine as best-effort.)

### 2.4 — Deterministic ICE-config gating + public-TURN policy (G6) ✅ DONE (`tsc` clean ×3)
- Import the proven `hasRealTurn(cfg)` + `applyPublicTurnPolicy(servers, allowPublic)`
  helpers (see 1:1 P1.8/P1.9 in `useWebRTC.ts` / `[conversationId].tsx`) into
  BOTH mesh hooks. Gate the FIRST negotiation (~1.5s, per P4.18) on real
  provisioned TURN; strip `openrelay.metered.ca` when `allowPublicFallback` is
  false. Warm Cloudflare TURN before join (mobile `warmIceConfig`).
- **Implemented**:
  - WEB (`useMeetingState.ts`): added module-scope `hasRealTurn` +
    `applyPublicTurnPolicy` (copied verbatim from `useWebRTC.ts`). New refs
    `iceHasRealTurnRef` / `iceAllowPublicRef` / `firstNegotiationStartedRef` /
    `initialIceConfigLoadedRef`. `refreshIceConfig` now records
    `allowPublicFallback` + `hasRealTurn(data)`; `waitForIceConfig` does the
    two-stage gate (Stage 1: any config; Stage 2 FIRST-negotiation-only: bounded
    ~1.5s wait for real TURN, re-fetch once). `createPeerConnection` builds the
    PC with `applyPublicTurnPolicy(...)` ICE servers; the initiator offer now
    `await waitForIceConfig()` then `setConfiguration(...)` (refresh ICE servers
    if creds landed) before `createOffer`. `handleSignal`'s offer branch does the
    same gate + `setConfiguration` before `createAnswer` (FIRST answer). Dep
    arrays updated (`waitForIceConfig`).
  - MOBILE (`useMeetingMesh.ts`): imports `hasRealTurn` /
    `applyPublicTurnPolicy` from `../realtime/callIceConfig` and `warmIceConfig`
    from `../features`. New refs `iceHasRealTurnRef` / `iceAllowPublicRef` /
    `firstNegotiationStartedRef`. New `refreshIceConfig` warms the shared
    Cloudflare TURN cache (`warmIceConfig`) + records the policy/real-TURN flags;
    the up-front ICE-load effect calls it. `waitForIceConfig` mirrors the web
    two-stage gate. `createPeer` builds the PC via `applyPublicTurnPolicy(...)`;
    the initiator offer `await waitForIceConfig()` before `createOffer`;
    `handleSignal`'s offer branch `await waitForIceConfig()` before
    `createAnswer`. Dep arrays updated (`waitForIceConfig`).
  - Only the FIRST negotiation is gated; ICE-restart / renegotiation proceed
    promptly with whatever creds are cached (the recovery ladder still applies).

### 2.5 — Verify all three tsc clean ✅ DONE
- `cd server && npx tsc --noEmit` → clean. ✅
- `cd client && npx tsc --noEmit` → clean. ✅
- `cd mobile && npx tsc --noEmit` → clean. ✅

---

## ✅ Phase 3 — Recovery ladder parity (web + mobile) — DONE (`tsc` clean ×3)
> Phase 2 (shared negotiation core) is COMPLETE — 2.1→2.5 all done, `tsc` clean ×3.
Files: same two mesh hooks.

### 3.1 — Relay-first fast retry per peer (P4.19) ✅ DONE (`tsc` clean ×3)
- Armed once per peer in `createPeer`/`createPeerConnection` on the initial
  non-relay PC: if not `connected` within ~5s, rebuild that ONE peer TURN-only
  (`iceTransportPolicy:"relay"`) and re-offer (initiator) / request re-offer via
  `meeting_peer_ready` semantics (answerer). Per-peer `relayOnlyPeers` set
  already exists on web — extend, and add to mobile.
- **Implemented**:
  - WEB (`useMeetingState.ts`): `ExtendedPC` gained `_relayRetryTimer`. After a
    PC is built (skipped when already relay-only), we arm a one-shot 5s timer: if
    the peer isn't `connected` (and `pcsRef` still holds THIS pc), add it to
    `relayOnlyPeersRef`, close + delete the PC, and `createPeerConnection(id,
    true)` — the rebuilt PC picks up `iceTransportPolicy:"relay"` from the
    existing guard. Cleared on `connected` and `failed`.
  - MOBILE (`useMeetingMesh.ts`): added `relayOnlyPeersRef` (new — mobile had
    none) + `PeerEntry.relayRetryTimer`. The PC config now sets
    `iceTransportPolicy:"relay"` when the peer is in `relayOnlyPeersRef`. Same 5s
    arm/rebuild logic (`closePeer` + `createPeer(id, true)`); cleared on
    `connected`/`failed`/`closed`, in `closePeer`, and `relayOnlyPeersRef` is
    cleared in `leave()` so a re-join starts fresh.

### 3.2 — Per-peer connect timeout ✅ DONE (`tsc` clean ×3)
- 30s connect timeout per peer → mark that tile "Couldn't connect — Retry" with
  a manual rebuild button instead of an infinite spinner (G5). Cleared on
  `connected` / teardown.
- **Implemented**:
  - WEB (`useMeetingState.ts`): `ExtendedPC` gained `_connectTimeoutTimer` +
    module constant `PEER_CONNECT_TIMEOUT_MS = 30_000`. `createPeerConnection`
    arms a one-shot 30s timer (skipped for relay-only rebuilds) that, if the
    CURRENT pc (`pcsRef.current.get(id)`) isn't `connected`, sets the
    participant `connectFailed: true`. The `onconnectionstatechange`
    `connected` branch clears the timer + clears `connectFailed`. New
    `retryPeer(peerId)` useCallback clears timers, closes+deletes the PC, clears
    `relayOnlyPeersRef`/`iceRestartCountsRef`, resets the participant
    (`connectFailed:false, stream:null`), `createPeerConnection(id, true)`, and
    re-emits `meeting_ready`. Exported from the hook.
    `ParticipantTile.tsx` gained an `onRetry` prop + a `hasConnectFailed` state
    that renders a `mr-tile-status--failed` block (WifiOff + "Couldn't connect"
    + a `mr-tile-retry-btn` RefreshCw "Retry" button) instead of the spinner;
    `isConnecting`/`isReconnecting` now also require `!hasConnectFailed`.
    `MeetingRoom.tsx` destructures `retryPeer` and passes
    `onRetry={!isLocal ? () => retryPeer(participant.userId) : undefined}` to
    both `<ParticipantTile>` renders. `MeetingRoom.css` adds
    `.mr-tile-status--failed` + `.mr-tile-retry-btn` (+ `:hover`).
  - MOBILE (`useMeetingMesh.ts`): `MeetingParticipant` gained `connectFailed`;
    `PeerEntry` gained `connectTimeoutTimer`; module constant
    `PEER_CONNECT_TIMEOUT_MS = 30_000`. `createPeer` arms the guarded 30s timer
    (checks the current entry's `connectionState`, sets `connectFailed:true`);
    the `connected` branch clears the timer + `connectFailed`; the
    `failed`/`closed` branch and `closePeer`/`leave()` teardown all clear it.
    New `retryPeer(peerId)` useCallback (`closePeer` + clear relay/pending-ICE +
    reset participant + `createPeer(id, true)` + `meeting_ready`), exported.
    `app/meeting/[code].tsx` imports `RefreshCw`, destructures `retryPeer`,
    threads `connectFailed`/`onRetry` through `RemoteTile`→`VideoTile`, and the
    tile renders a "Couldn't connect" + `tileRetryBtn` Pressable when
    `hasConnectFailed` instead of the "Connecting…" spinner.
    `app/meeting/[code].styles.ts` adds `tileFailedText` / `tileRetryBtn` /
    `tileRetryText`.

### 3.3 — Global network-change ICE restart on MOBILE (G7) ✅ DONE (`tsc` clean ×3)
- Web already has `restartAll` on `online` + `connection.change`. Add the same to
  `useMeetingMesh`: on `online` (and RN NetInfo change if available), ICE-restart
  every stable PC (`createOffer({iceRestart:true})`).
- **Implemented**:
  - MOBILE (`useMeetingMesh.ts`): imported `@react-native-community/netinfo`.
    New `restartAllPeers()` ICE-restarts every stable PC (`createOffer({
    iceRestart:true})` wrapped in the `makingOffer` glare guard, routed through
    `sendSignal`). An effect (active while `wantJoin`) wires two triggers:
    `socket.onOpen(...)` (realtime socket reopened after a drop) and
    `NetInfo.addEventListener(...)` firing only on a false→true connectivity
    edge (Wi-Fi↔cellular handoff / airplane-mode off). Both unsubscribe on
    cleanup. Perfect Negotiation (2.1) keeps the resulting offers glare-safe.

### 3.4 — Verify all three tsc clean ✅ DONE
- `cd server && npx tsc --noEmit` → clean. ✅
- `cd client && npx tsc --noEmit` → clean. ✅
- `cd mobile && npx tsc --noEmit` → clean. ✅

---

## ✅ Phase 4 — Mesh scaling for 5–10 (no SFU) — DONE (`tsc` clean ×3)
Files: same two mesh hooks (bitrate + active-speaker already partly present).

### 4.1 — Bandwidth governor ✅ DONE (`tsc` clean ×3)
- Single uplink budget split across active video peers. Audio ALWAYS prioritized
  (Opus, ~32–48 kbps, never starved). Tiered caps:
  `≤3 peers: 500k`, `4–6: 300k`, `7-10: 150k`. Below the video floor at high
  counts, request `q` from non-active-speakers (existing `meeting_request_quality`)
  and/or pause inbound video so audio survives. Mobile already has
  `targetBitrateForPeerCount` + ramp — retune thresholds; web has a peer-count
  bitrate block — unify the ladder.
- **Implemented**:
  - Shared ladder: `videoBitrateForPeerCount(peerCount)` = `≤3 → 500k`,
    `4–6 → 300k`, `7+ → 150k`, keyed on REMOTE-peer count (N−1), plus
    `AUDIO_MAX_BITRATE = 48_000` (audio pinned, never governed). Defined
    identically on both platforms.
  - WEB (`useMeetingState.ts`): replaced the two old ad-hoc peer-count bitrate
    blocks (the post-`addTrack` `setTimeout` in `createPeerConnection` and the
    `meeting_participant_joined` re-cap loop, both previously
    `≤2:1.2M/≤4:600k/else 400k`) with `videoBitrateForPeerCount`; audio senders
    now use `AUDIO_MAX_BITRATE`. `applyQualityCapForPeer` (driven by
    `meeting_request_quality` from active-speaker/presenter demotion) is now
    BOUNDED by the governor ceiling: `f → ceiling`, `h → min(300k, ceiling)`,
    `q → min(150k, ceiling)` — so a remote's "full" request can never push the
    uplink past what N−1 peers afford.
  - MOBILE (`useMeetingMesh.ts`): retuned `targetBitrateForPeerCount` from
    `≤1:800k/≤3:500k/else 350k` to the unified ladder; `setVideoBitrate` audio
    branch now uses `AUDIO_MAX_BITRATE`; `applyBitrateRampUp` clamps its start
    `INITIAL = Math.min(300k, TARGET)` so a 7+ call (150k ceiling) never opens
    above the ceiling and congests the uplink on the first frame.
  - Audio is prioritized on both platforms: audio-track `maxBitrate` is pinned
    at `AUDIO_MAX_BITRATE` and is never touched by the peer-count governor or the
    quality-cap path, so voice survives when video is squeezed at high counts.

### 4.2 — Active-speaker-driven video at high counts ✅ DONE (`tsc` clean ×3)
- Reuse existing `meeting_audio_level` + `meeting_request_quality`: only
  upgrade the dominant speaker (+ a few) to full video; demote the rest to
  `q`/audio+avatar. Web has `activeSpeakerId` + `requestPeerQuality` scaffolding;
  wire the demotion policy. Add parity on mobile.
- **Implemented**:
  - Shared knobs (defined identically on both platforms):
    `HIGH_COUNT_VIDEO_THRESHOLD = 6` (remote-peer count at/above which we demote),
    `RECENT_SPEAKER_WINDOW_MS = 12_000` (hysteresis so a peer stays priority for
    12s after last speaking), `MAX_PRIORITY_VIDEO_PEERS = 4` (cap on full-video
    tiles).
  - WEB (`useMeetingState.ts`): added `recentSpeakersRef` (userId → last-floor
    timestamp), recorded in the active-speaker selector whenever a dominant
    speaker is picked. Replaced the old flat `f`/`h` "Adaptive bitrate" effect
    with a count-aware policy on a 2s interval: BELOW the threshold →
    presenter + active speaker get `f`, rest `h` (original behaviour); AT/ABOVE →
    build a bounded priority set (presenter first, then dominant speaker, then
    most-recent speakers up to the cap) that get `f`, everyone else `q`. Expired
    recent-speaker entries are pruned each tick; `requestPeerQuality` dedup means
    a steady state produces no WS traffic.
  - MOBILE (`useMeetingMesh.ts`): added the full scaffolding mobile lacked —
    `audioLevelsRef` / `recentSpeakersRef` / `lastRequestSentRef` /
    `requestedQualityRef`, a deduped `sendRequestQuality`, and
    `applyQualityCapForPeer` (bounds an inbound request to the governor ceiling).
    New WS handlers: `meeting_request_quality` (records + re-caps OUR sender) and
    `meeting_audio_level` (stores remote levels). Two `getStats`-based sampling
    effects (RN has no Web-Audio AnalyserNode): one derives per-remote speaking
    levels (native `audioLevel` when present, else inbound-audio byte-rate
    proxy), the other broadcasts OUR level via `meeting_audio_level` so
    web/desktop promote us. The demotion policy effect mirrors web (dominant +
    recent-speaker priority set, `f`/`h` below threshold, `f`/`q` above); mobile
    has no `presenterId` (no screenshare) so the set is speaker-driven only.

### 4.3 — Verify all three tsc clean ✅ DONE
- `cd server && npx tsc --noEmit` → clean. ✅
- `cd client && npx tsc --noEmit` → clean. ✅
- `cd mobile && npx tsc --noEmit` → clean. ✅

---

## ✅ Phase 5 — State machine + reconnect orchestration — DONE (`tsc` clean ×3)
### 5.1 — Per-peer connection reducer (port P3.14 absorbing-terminal pattern) ✅ DONE (`tsc` clean ×3)
- Extract a pure per-peer reducer so a late `connected` after teardown can't
  revive a removed peer (the mesh equivalent of the 1:1 `callStateMachine.ts`).
  Add a small test suite.
- **Implemented**:
  - New pure reducer `peerConnectionMachine.ts` on BOTH platforms
    (`client/src/pages/meeting/peerConnectionMachine.ts` +
    `mobile/src/meeting/peerConnectionMachine.ts`, identical logic). Phases
    `connecting → connected → reconnecting`, recoverable `failed` (via `RETRY`),
    and the ABSORBING terminal `closed`. Events `CONNECTING`/`CONNECTED`/
    `RECONNECTING`/`FAILED`/`RETRY`/`CLOSED`; `isPeerTerminal` guards call sites.
    Mirrors the 1:1 `callStateMachine.ts` absorbing-terminal invariant — once a
    peer is `closed` NO later event (notably a late `CONNECTED`/`ontrack` from a
    PC being torn down) can revive the removed tile. NOTE: `failed` is NOT
    terminal (the Phase 3.2 "Couldn't connect — Retry" button drives `RETRY` →
    `connecting`); only `closed` absorbs.
  - Test suites: web `client/src/__tests__/peerConnectionMachine.test.ts`
    (vitest, 10 tests) + mobile
    `mobile/src/meeting/__tests__/peerConnectionMachine.test.ts` (jest, 12
    tests). Both cover the happy path, the failed→retry recovery, and — the core
    fix — "a late CONNECTED after CLOSED never flips back to connected".
    Verified: web 10/10 ✅, mobile 12/12 ✅.
  - WEB wiring (`useMeetingState.ts`): `ExtendedPC` gained `_phase`; module
    helper `dispatchPeerPhase(pc, event)` drives it. `createPeerConnection` sets
    `_phase = initialPeerPhase()`. `ontrack` + `onconnectionstatechange` both
    early-return when `isPeerTerminal(pc._phase)` (the terminal-absorption
    guard), and `onconnectionstatechange` dispatches `CONNECTED`/`FAILED`/
    `RECONNECTING`. `meeting_participant_left` dispatches `CLOSED` BEFORE
    `pc.close()` so any in-flight late callback sees the terminal phase. (A
    rebuilt PC is a fresh instance with its own `_phase`, so this only kills the
    dead one.)
  - MOBILE wiring (`useMeetingMesh.ts`): `PeerEntry` gained `phase`; `createPeer`
    sets `phase = initialPeerPhase()`; `dispatchPeer(entry, event)` helper.
    `closePeer` dispatches `CLOSED` first (before clearing timers + `pc.close()`).
    `ontrack` + `onconnectionstatechange` early-return on
    `isPeerTerminal(entry.phase)`; the `connected` branch dispatches `CONNECTED`,
    `disconnected` → `RECONNECTING` (only from `connected`), `failed`/`closed` →
    `FAILED`, and the 30s connect-timeout dispatches `FAILED` (guarded).

### 5.2 — Reconnect orchestration on socket reopen (G10) ✅ DONE (`tsc` clean ×3)
- On `socket.onOpen` (mobile) / ws `open` (web): re-send `meeting_join` +
  `meeting_subscribe`, reconcile the peer map against the authoritative
  `existingPeers`, and rebuild any missing PCs. Mobile `useMeetingMesh` already
  reconciles `existingPeers` — add the re-subscribe on reconnect.
- **Implemented**:
  - MOBILE (`useMeetingMesh.ts`): the existing `socket.onOpen` effect (which used
    to only `restartAllPeers()`) now FIRST re-announces us on reopen — re-sends
    `meeting_join` (via `sendWithRetry`, re-registers us + re-fetches the
    authoritative `existingPeers`, which the `meeting_participant_joined` handler
    already reconciles: prunes phantoms + rebuilds missing PCs) then
    `meeting_subscribe` (replays buffered offer/ICE + fans out
    `meeting_peer_ready`), THEN `restartAllPeers()` for same-membership blips.
    Guarded on `joinedRef.current` so it only fires for an active member.
  - WEB (`useMeetingState.ts`): the on-`open` `flushAndReplay` effect now, after
    `flushOutboundQueue()`, resets the handshake guards and re-sends
    `meeting_join` + `meeting_subscribe` so a WS reopen that lost our membership
    (grace-expiry) re-registers us and replays buffered signals — the
    `meeting_participant_joined` reconcile path rebuilds missing PCs. The
    separate Network-change → ICE-restart effect still covers same-membership
    blips.

### 5.3 — Verify all three tsc clean ✅ DONE
- `cd server && npx tsc --noEmit` → clean. ✅
- `cd client && npx tsc --noEmit` → clean. ✅
- `cd mobile && npx tsc --noEmit` → clean. ✅
- Tests: web vitest `peerConnectionMachine.test.ts` 10/10 ✅; mobile jest
  `peerConnectionMachine.test.ts` 12/12 ✅.

---

## Handoff protocol
1. Ensure current file edits compile (`tsc` clean) — never stop mid-edit.
2. Update this tracker's checkboxes + RESUME pointer.
3. Resume from the first unchecked item.

## RESUME POINTER → ALL PHASES COMPLETE ✅ (Phases 1→5 done, `tsc` clean ×3 at every gate)
> The Group-Call (Mesh) Reliability Overhaul is COMPLETE. Phase 5 landed the
> per-peer connection reducer (`peerConnectionMachine.ts` on web + mobile, with
> an absorbing terminal `closed` phase so a late `connected`/`ontrack` after
> teardown can't revive a removed peer — the mesh analogue of the 1:1 P3.14
> effect-race fix), wired it into both mesh hooks' PC lifecycle
> (`createPeer(Connection)` / `ontrack` / `onconnectionstatechange` /
> teardown), added reconnect orchestration on socket/WS reopen (re-send
> `meeting_join` + `meeting_subscribe`, reconcile against the authoritative
> `existingPeers`), and shipped test suites (web vitest 10/10, mobile jest
> 12/12). Final gate: server/client/mobile `tsc --noEmit` all clean.
>
> No unchecked items remain. Future work beyond this tracker (an SFU for
> flawless 10-way video) is explicitly out of scope per the "Realistic ceiling"
> section above.
