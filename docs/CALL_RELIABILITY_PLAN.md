# Call Reliability Overhaul — Resumable Tracker (P0→P3)

> **Purpose**: Single source of truth for the enterprise-grade call-reliability
> rework. A fresh context window MUST read this file first and resume from the
> first unchecked item. Update checkboxes immediately after each sub-task. Never
> hand off mid-edit — finish each item to a `tsc --noEmit` clean state.

## Goal
Make every answered call connect deterministically and every decline/end tear
down on both devices — across foreground, background, lock-screen, killed, and
push-answer paths. Root cause (now being fixed): fire-and-forget WebRTC
signaling on the server dropped the caller's OFFER/early-ICE whenever the callee
wasn't yet subscribed (push/cold-start/lock-screen answer), so the call hung
("Connecting…" / black screen / "can't connect from push").

## Build / verify commands (Windows PowerShell)
- Server: `cd server && npx tsc --noEmit` (empty output = clean)
- Web:    `cd client && npx tsc --noEmit`
- Mobile: `cd mobile && npx tsc --noEmit`
- NOTE: `head`/pipe truncation is unavailable in this shell. Redirect to a file:
  `npx tsc --noEmit > out.txt 2>&1; type out.txt` (empty file = clean), then delete it.

## Canonical constants / protocol additions
- New WS client→server messages: `call_subscribe { callId, conversationId }`,
  `call_ready { callId, conversationId }`.
- New WS server→client event: `call_peer_ready { callId, conversationId, userId }`
  (tells the OTHER party to (re)send their offer — idempotent via Perfect Negotiation).
- Existing timeouts: `RING_TIMEOUT_MS=35000`, `CONNECT_TIMEOUT_MS=30000`,
  server `STALE_RINGING_TTL_SECS=45`.

---

## ✅ DONE (server) — verified `tsc --noEmit` clean

### P0.1 — Per-call signal buffer infra (`server/utils/ws.ts`)
- Added `BufferedCallSignals` + `_callSignalBuffers` Map (TTL 60s, cap 2000 calls,
  80 ICE/user), helpers: `bufferCallSignal`, `replayCallSignals`,
  `clearCallBuffer`, `hasOpenSocket`. Located right after `isMeetingMember`.

### P0.2 — Buffer on relay miss + replay on accept
- In `call_signal` handler: when `signal.type` is `offer`/`ice-candidate` AND the
  target has no open socket (`hasOpenSocket`), `bufferCallSignal(callId, …)` using
  `msg.data.callId`. Still relays normally (cross-instance).
  **IMPORTANT**: mobile/web must include `callId` in every `call_signal` payload
  for buffering to work (mobile currently does NOT — see P0.7 follow-up below).
- In `call_accept` (after status→answered): `replayCallSignals(callId, senderId, …)`
  delivers buffered offer+ICE to the accepter.

### P0.3 — `call_subscribe` + `call_ready` handlers + buffer clear
- New `call_subscribe` handler: replays buffered signals to sender + emits
  `call_peer_ready` to other participant(s).
- New `call_ready` handler: same (replay + `call_peer_ready`).
- `clearCallBuffer(...)` added to `call_cancel` and `call_end` terminal paths.

### P0.4 — Mobile: emit `call_subscribe` + `call_ready` + include `callId` in signals — verified `tsc --noEmit` clean
File: `mobile/app/call/[conversationId].tsx`
- Added a P0.4 subscribe `useEffect` (callee + reconnect only, guarded by
  `subscribedRef`): once `callIdRef.current` is known it sends
  `call_subscribe { callId, conversationId }` (sendWithBackoff, ensureConnected).
- `acceptIncoming()` now sends `call_ready { callId, conversationId }` after media
  is acquired so the caller (re)offers immediately.
- Added `callId: callIdRef.current` to EVERY `call_signal` payload: onicecandidate
  ICE, ICE-restart offer, failed-state restart offer, relay-only rebuild offer,
  dead-video recovery offer + video-state, post-resume renegotiation offer +
  video-state, `call_accepted` offer + video-state, answer + video-state in the
  offer handler, `call_reconnect` re-offer + video-state, quality-state, and the
  toggleMute / toggleVideo / toggleHold control signals.
- New inbound `call_peer_ready` handler: if we are the CALLER (`mode==="outgoing"`)
  and have a live PC whose `localDescription.type === "offer"`, re-send that offer
  once (idempotent via Perfect Negotiation). callId-gated to the active call.

### P0.5 — Mobile: callee auto re-offer recovery — verified `tsc --noEmit` clean
File: `mobile/app/call/[conversationId].tsx`
- Added `acceptReofferTimeoutRef` (Signal-style bounded recovery timer).
- At the END of `acceptIncoming()` (after `call_ready`): arm a ~4s timer. If
  `pcRef.current` is still null when it fires (NO offer ever arrived — both the
  caller's original offer AND the `call_peer_ready` re-offer were lost), send
  `call_reconnect { callId, conversationId }` (sendWithBackoff, ensureConnected)
  to request a FRESH offer; the server relays it to the caller, whose existing
  `call_reconnect` handler re-offers and the call binds.
- Timer is CLEARED the moment any PC is built (inside `createPC`, covering the
  incoming-offer answer, reconnect re-offer, and relay-only rebuild paths) and on
  screen unmount (added to the recovery-timer cleanup `useEffect`).

### P0.6 — Web parity for `call_peer_ready` — verified `tsc --noEmit` clean
Files: `client/src/components/chat/call/useWebRTC.ts`,
`client/src/pages/chat/useCallState.ts`, `client/src/pages/chat/useChatState.ts`,
`client/src/__tests__/callSignaling.test.tsx`
- `useWebRTC.ts`: added a `callIdRef` (kept in sync each render) and now include
  `callId: callIdRef.current` in EVERY `call_signal` payload — onnegotiationneeded
  reneg offer, onicecandidate ICE, ice-restart offer (disconnected + failed),
  relay-only rebuild offer, answer (offer handler), deferred outgoing offer,
  `reconnectTo` re-offer, post-accept caller offer, network-change ICE-restart
  offer, and the video/audio/screen-share/quality state signals. A ref is used
  because the long-lived PC handlers don't depend on `callId`, and an OUTGOING
  call only learns its id after `call_started`.
- `useWebRTC.ts`: `handleAccept()` now emits `call_ready { callId, conversationId }`
  once media is ready (web parity of mobile `acceptIncoming`). Added a P0.6
  `call_subscribe` effect (callee/reconnect, guarded by `subscribedRef`) that
  fires once the callId is known. Added a P0.6 `call_peer_ready` effect: the
  CALLER (only) re-sends its current offer when `peerReadyNonce` bumps, gated on
  a live PC whose `localDescription.type === "offer"` (idempotent via Perfect
  Negotiation).
- `useCallState.ts`: added `peerReadyNonce` to `CallState` and a `call_peer_ready`
  handler that bumps it. `useChatState.ts`: route `call_peer_ready` into
  `handleCallWsEvent`. Updated the signaling test's answer-payload expectation to
  include `callId`. Both call-signaling tests pass; `client` tsc clean.

---

### P0.7 — Reliable ICE transport (mobile + web) — verified `tsc --noEmit` clean
File: `mobile/app/call/[conversationId].tsx` (`onicecandidate`) and
`client/src/components/chat/call/useWebRTC.ts` (`onicecandidate`).
- Mobile: added a local outbound-ICE queue (`iceOutQueueRef`) + single-flight
  drain `flushIceOutQueue()` that delivers each candidate via
  `socket.sendWithBackoff` (which reconnects + retries) preserving FIFO order; a
  failed send leaves the candidate at the front of the queue and a 1s re-flush
  timer retries until the socket recovers. `onicecandidate` now calls
  `enqueueLocalIce(targetUserId, e.candidate.toJSON())` instead of a bare
  `socket.send`. Queue + timer are cleared in the recovery-timer cleanup
  `useEffect` on unmount. `callId` is included on every queued frame (P0.4).
- Web: `wsSend` (useWebSocket `sendMessage`) ALREADY provides this guarantee —
  when the socket isn't OPEN it queues the frame (capped, drop-oldest) and
  `flushQueue()` re-sends every queued frame IN ORDER on the next `onopen`
  (focus / online / visibility all force an immediate reconnect). Documented the
  `onicecandidate` handler to make the P0.7 guarantee explicit; `callId` already
  included (P0.6). No code change needed beyond the clarifying comment.

---

### P1.8 — Deterministic ICE-config gating — verified `tsc --noEmit` clean (mobile + web)
Files: `mobile/app/call/[conversationId].tsx`, `client/src/components/chat/call/useWebRTC.ts`
- Added a shared `hasRealTurn(cfg)` helper + `REAL_TURN_MODES` set in BOTH
  clients: a config carries "real" (provisioned) TURN only when the server's
  `mode` is `cloudflare-calls`/`coturn-rest`/`static`, or (legacy/no-mode) when
  a non-`openrelay.metered.ca` `turn:`/`turns:` URL is present. The public Open
  Relay fallback + STUN-only (`public-fallback`/`stun-only`) are treated as
  fallback-only.
- `waitForIceConfig` is now a TWO-STAGE deterministic gate:
  1. wait for ANY config to load (existing behaviour), then
  2. on the FIRST negotiation only (`firstNegotiationStartedRef`), if we don't
     already have real TURN, ADDITIONALLY wait (bounded ~6s) for genuine TURN to
     arrive — never negotiating the first offer/answer against the public-only
     fallback (the "fresh install/load: first call doesn't connect" bug on
     relay-requiring networks). A later ICE-restart/renegotiation skips the gate
     so recovery offers proceed promptly. If real TURN never lands in time we
     proceed with the fallback rather than hang (recovery ladder still applies).
- Mobile tracks `iceHasRealTurnRef` from the warmed cache, the live fetch, AND
  the in-loop cache poll. Web tracks it in `refreshIceConfig` and the gate
  triggers a single best-effort re-fetch in case the first config resolved to
  the public fallback before managed creds were provisioned.

### P1.9 — Gate client public-TURN fallback — verified `tsc --noEmit` clean (server + web + mobile)
Files: `server/utils/coturn.ts`, `server/routes/chat.ts`, `mobile/src/features.ts`,
`mobile/app/call/[conversationId].tsx`, `client/src/components/chat/call/useWebRTC.ts`
- `coturn.ts`: `IceConfigResult` now carries `allowPublicFallback` (derived ONCE
  from `DISABLE_PUBLIC_TURN`); every return path (cloudflare-calls / coturn-rest /
  static / public-fallback / stun-only) sets it. The public Open Relay branch is
  gated on `allowPublicFallback` (mirrors the previous inline env check).
- `server/routes/chat.ts` ice-config: surfaces `allowPublicFallback` in the JSON
  payload so the client knows whether it may use its hard-coded public-TURN list.
- Both clients added a shared `applyPublicTurnPolicy(servers, allowPublic)` helper
  that strips every `openrelay.metered.ca` `turn:`/`turns:` URL (dropping an entry
  entirely when it was public-TURN-only) while ALWAYS keeping STUN. A new
  `iceAllowPublicRef` (default `true` for backwards-compat with older servers that
  omit the flag) is set from the warmed cache / live `/ice-config` fetch (mobile:
  the load effect + both `waitForIceConfig` cache-adoption sites; web:
  `refreshIceConfig`). `createPC`/`createPeerConnection` now feed
  `applyPublicTurnPolicy(iceServersRef.current, iceAllowPublicRef.current)` into
  the `RTCPeerConnection` config so a deployment with `DISABLE_PUBLIC_TURN=true`
  never relays through the public service from the client either.
- `mobile/src/features.ts`: `IceConfig` type gains optional `allowPublicFallback`.

### P1.10 — Black-video hardening — verified `tsc --noEmit` clean (server + web + mobile)
Files: `mobile/app/call/[conversationId].tsx`,
`client/src/components/chat/call/useWebRTC.ts`, `server/utils/ws.ts`
- Post-resume + `recoverDeadVideoTrack` renegotiation already fire once a PC
  exists (guaranteed by P0): the AppState-resume effect re-attaches tracks and
  re-announces `video-state`, and `recoverDeadVideoTrack` republishes a dead
  camera track + renegotiates. Confirmed both paths are PC-gated.
- NEW one-shot peer `video-state` re-request ("black-video watchdog"). When a
  VIDEO call reaches `connected`, both clients arm a ~3s timer
  (`remoteVideoWatchdogRef`, gated once per call via `videoStateRequestedRef`):
  if there is still NO live remote video track, they send a new
  `request-video-state` `call_signal` to the peer. Cleared on teardown/unmount
  so it can never fire post-teardown.
- NEW inbound `request-video-state` responder on BOTH clients: the peer replies
  with the GROUND TRUTH `video-state` derived from its LIVE local video track
  (not-ended + enabled) rather than a possibly-stale `videoOff` closure, so a
  dropped/late original `video-state` self-heals and the avatar↔video state
  converges.
- `server/utils/ws.ts`: added `request-video-state` to `VALID_SIGNAL_TYPES`
  (it is a pure relay; no extra payload validation needed) so the new signal is
  forwarded instead of dropped as an unknown type.

### P2.11 — Push token freshness / re-registration — verified `tsc --noEmit` clean (mobile)
Files: `mobile/src/realtime/socket.ts`,
`mobile/src/services/pushNotificationService.ts`,
`mobile/src/realtime/PushNotificationInitializer.tsx`
- `socket.ts`: added an `openListeners` set + `onOpen(listener)` subscription
  API that fires on EVERY socket transition to OPEN (initial connect AND every
  reconnect), invoked from `ws.onopen`. `onOpen` also fires the callback once
  immediately if the socket is already open when subscribing, so a late
  subscriber never misses the current connection. Listener errors are swallowed
  so they can't kill the socket.
- `pushNotificationService.ts`: added `refreshAndRegisterDeviceToken()` — it
  re-acquires the FCM/APNs device token from the native layer (the token can
  ROTATE on reinstall/restore/data-clear/FCM-key-refresh) and only POSTs to the
  backend when the token actually CHANGED (forces `registerDeviceTokenForCurrentUser`
  on rotation; otherwise the cached-auth-token guard short-circuits a redundant
  POST). No-ops when no user is signed in.
- `PushNotificationInitializer.tsx`: wires `refreshAndRegisterDeviceToken()` to
  the two events that reliably mark "this device is live again": app FOREGROUND
  (`AppState` `change` → `active`) and WS RECONNECT (`socket.onOpen`). Also runs
  once on mount. All three subscriptions are torn down in the effect cleanup
  alongside the existing native-action unsubscribe.

### P2.12 — Push send verification + WS fallback — verified `tsc --noEmit` clean (server); call-payload tests pass
File: `server/services/pushNotifications.ts`
- `sendCallNotification` now captures the `sendToDevices` result and, when
  `succeeded === 0` (EVERY device token failed despite having tokens), logs a
  STRUCTURED `push_call_all_failed` error (alertable: tenant/user/call/conv ids,
  dedupeKey, tokenCount, failed count). This is the only delivery path for a
  backgrounded/locked/killed callee device, so a total failure is significant.
- Optional SINGLE retry: re-fetches device tokens (invalid ones may have been
  purged by the failed attempt) and, if any remain, re-dispatches once with a
  distinct `call-<id>-retry` collapse key. A still-failed retry logs
  `push_call_retry_failed`. The final result reflects the retry outcome.
- WS `call_incoming` remains the GUARANTEED alive-device fallback: it is emitted
  by the `call_initiate` handler in `server/utils/ws.ts` (line ~931) to every
  participant BEFORE `sendCallNotification` is dispatched, so any callee with a
  live socket rings regardless of push success. Documented this invariant inline.
- Existing `pushNotifications.callPayload` tests still pass (4/4); server tsc clean.

### P2.13 — Decline/end teardown verification — verified `tsc --noEmit` clean (server)
Files: `server/utils/ws.ts` (`call_end` handler),
`server/routes/chat.ts` (HTTP `/calls/:callId/end`)
- AUDIT findings (decline path already complete): the WS `call_reject` handler
  emits `call_rejected` to the caller, `call_handled_elsewhere` to the rejecter's
  other sessions, AND push-cancels BOTH the rejecter's twin devices and the
  caller's devices. The HTTP fallback `POST /calls/:callId/reject` mirrors all of
  this. The `call_accept` WS + HTTP paths likewise push-cancel the accepter's
  twins. The stale-call sweep in `jobs.ts` push-cancels callee twins on
  force-expire. So decline/accept/cancel teardown was already twin-complete.
- GAP found + fixed (end path): the WS `call_end` handler and the HTTP
  `/calls/:callId/end` fallback ONLY emitted the `call_ended` WS event — they did
  NOT push-cancel. A locked/backgrounded/killed twin (e.g. the call was ended
  while it was still ringing on that device, or a second device never joined)
  therefore kept its native incoming-call ring / ongoing-call notification with
  no dismiss push. Added `pushNotifications.sendCallCancellation(..., reason: "ended")`
  for every non-sender participant in BOTH the WS handler and the HTTP fallback,
  mirroring the call_cancel / call_reject / stale-sweep pattern.
- Verified the mobile teardown consumer is reason-agnostic: the
  background/headless handler (`mobile/src/services/backgroundPushService.ts`,
  `handleNotificationPayload`) dismisses the active call UI on ANY
  `type === "call_handled_elsewhere"` data push via `notifeeService.cancelCall`,
  so the new `reason: "ended"` push correctly dismisses the twin. The foreground
  `IncomingCallListener` + `OngoingCallBanner` already clear on the WS
  `call_handled_elsewhere` / `call_ended` / `call_rejected` events.
- HTTP fallbacks confirmed to cover WS-down cases: `rejectCallHttp` (ringing →
  declined), `endCallHttp` (→ ended/missed) both apply the same DB transition,
  WS notifications, push-cancels, and status clear as their WS twins, so a dropped
  decline/end frame still reaches the server and tears down both devices.
- Server `tsc --noEmit` clean.

### P3.14 — Consolidate mobile call state machine — verified `tsc --noEmit` clean (mobile); 16/16 reducer tests pass
Files: `mobile/src/realtime/callStateMachine.ts` (new),
`mobile/src/realtime/__tests__/callStateMachine.test.ts` (new),
`mobile/app/call/[conversationId].tsx`
- Extracted the call lifecycle into an explicit, pure reducer
  (`callStateReducer`) with phases `ringing | connecting | connected |
  reconnecting | ended | rejected` and a typed `CallEvent` union (ACCEPT,
  PEER_ACCEPTED, PEER_RECONNECT, PC_CONNECTED, PC_RECONNECTING, RING_TIMEOUT,
  REMOTE_ENDED, REMOTE_REJECTED, REMOTE_BUSY). `initialCallPhase(isReconnect)`
  seeds `reconnecting` for a rejoin, `ringing` otherwise.
- KEY RACE FIX: terminal phases (`ended`, `rejected`) are ABSORBING — once the
  call is torn down, NO later event (including a late `PC_CONNECTED` from a peer
  connection that reached "connected" a beat after `call_ended`/`call_rejected`
  arrived, or a delayed `PEER_ACCEPTED`) can revive it. This removes the effect
  races that previously let a stale async handler flip the UI back to a live call
  after teardown.
- The call screen now drives `status` via `useReducer(callStateReducer, …)`
  instead of nine scattered `setStatus(...)` calls. Each former `setStatus` site
  maps 1:1 to a `dispatchCall({ type })`: `onconnectionstatechange("connected")`
  → PC_CONNECTED; relay-only rebuild → PC_RECONNECTING; ring timeout →
  RING_TIMEOUT; `call_accepted` → PEER_ACCEPTED; `call_reconnect` →
  PEER_RECONNECT; `call_ended` → REMOTE_ENDED; `call_rejected` → REMOTE_REJECTED;
  `call_busy` → REMOTE_BUSY; `acceptIncoming()` → ACCEPT. WebRTC primitives (PC,
  media, ICE, recovery ladder, Perfect Negotiation) are unchanged.
- Added a dedicated reducer test suite (16 cases) covering every transition plus
  the terminal-absorption invariant (no event revives an ended/rejected call;
  the exact late-`PC_CONNECTED`-after-`REMOTE_ENDED` race stays `ended`). All
  pass; mobile `tsc --noEmit` clean.

### P3.15 — Android ConnectionService / CallStyle native UI — verified `tsc --noEmit` clean (mobile)
Files: `mobile/src/services/nativeCallService.ts`, `mobile/src/config.ts`,
`mobile/app.config.ts`
- Re-enabled the Android react-native-callkeep incoming-call surface behind a
  NEW feature flag `ANDROID_NATIVE_CALL_UI` (DEFAULT OFF). Previously
  `resolveCallKeepModule()` UNCONDITIONALLY returned `null` on Android to dodge a
  startup crash on some RN versions (duplicate exported method names); it now
  returns `null` on Android ONLY when the flag is off, so a verified build can
  opt into the native ConnectionService/CallStyle UI without a code change.
- Flag plumbing: `app.config.ts` reads `EXPO_PUBLIC_ANDROID_NATIVE_CALL_UI` env
  (`=== "true"`) into `extra.ANDROID_NATIVE_CALL_UI`; `src/config.ts` exposes a
  typed `ANDROID_NATIVE_CALL_UI` boolean (coerces a boolean OR string extra,
  default `false` for backwards-compat / older builds). `nativeCallService.ts`
  imports it to gate the Android branch.
- Fallback invariant preserved: when the flag is OFF the app continues to use the
  Notifee CallStyle status-bar notification + CallRinger foreground service
  (`mobile/modules/call-ringer`) so background/locked/killed incoming calls still
  ring — the native surface is purely additive and opt-in. `isNativeAvailable()`
  doc updated to reflect the flag.
- Mobile `tsc --noEmit` clean.

### P3.16 — Docs + final tsc pass — verified all three `tsc --noEmit` clean
Files: `docs/CALL_AUDIT.md`, `docs/CALL_RELIABILITY_PLAN.md`
- Updated `docs/CALL_AUDIT.md`: the roadmap item **P3.1 — Android native call UI
  (CallKeep/ConnectionService)** is now marked ✅ flag-gated re-enable, documenting
  the P3.15 `ANDROID_NATIVE_CALL_UI` feature flag, the preserved Notifee/CallRinger
  fallback, and the remaining on-device verification before flipping the flag on
  by default.
- Final verification pass (Windows PowerShell, redirect-to-file): all three
  projects compile clean —
  - `cd server && npx tsc --noEmit` → 0 chars (clean)
  - `cd client && npx tsc --noEmit` → 0 chars (clean)
  - `cd mobile && npx tsc --noEmit` → 0 chars (clean)
- The full P0→P3 call-reliability overhaul is now complete and `tsc`-clean across
  server, web, and mobile.

## ✅ COMPLETE — all P0→P3 items done

---

## Handoff protocol
1. Ensure current file edits compile (`tsc` clean) — never stop mid-edit.
2. Update this tracker's checkboxes + RESUME pointer.
3. Resume from the first unchecked item.