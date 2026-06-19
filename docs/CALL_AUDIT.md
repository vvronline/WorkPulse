# WorkPulse Call System — Release-Prioritized Audit

Scope: incoming/outgoing 1:1 calls across **mobile ↔ mobile** and **web/desktop ↔ mobile**.

Surfaces traced:
- **Server**: `server/utils/ws.ts`, `server/jobs.ts`, `server/routes/chat.ts`, `server/services/pushNotifications.ts`
- **Web/Desktop**: `client/src/components/chat/call/useWebRTC.ts`, `CallOverlay.tsx`, `CallContext.tsx`
- **Mobile**: `mobile/app/call/[conversationId].tsx`, `realtime/callRouting.ts`, `services/nativeCallService.ts`, `services/notifeeService.ts`, `services/backgroundPushService.ts`

The core is strong (Perfect Negotiation, relay-only escalation, ICE restart, pre-warm, bitrate ramp, idempotent transitions, stale-ring backstop). The items below are prioritized **for shipping**, not by theoretical completeness.

---

## Priority Legend

| Tier | Meaning | Release stance |
| ---- | ------- | -------------- |
| **P0** | Active defect or interop break — users hit it now | **Must fix before release** |
| **P1** | Reliability/UX gap that causes support tickets | **Strongly recommended this release** |
| **P2** | Parity/polish vs Slack/Teams/Meet | Next release |
| **P3** | Large effort / platform feature | Roadmap |

---

## P0 — Must fix before release

### P0.1 — ✅ FIXED: Background incoming-call notification dropped (regression v1.0.79)
- **File**: `mobile/src/services/notifeeService.ts` → `displayIncomingCall()`
- **Cause**: invalid Notifee `vibrationPattern: [0, 700, 700, 700, 700]` (odd length + leading 0) threw, swallowed by catch → no notification in killed/background state.
- **Status**: Fixed (valid pattern `[300,500,300,500]` + defensive retry-without-extras fallback). Verified `tsc` clean.
- **Effort**: Done.

### P0.2 — `quality-state` interop break (mobile→web/server)
- **Files**: `server/utils/ws.ts` (`VALID_SIGNAL_TYPES`), `client/src/components/chat/call/useWebRTC.ts`
- **Symptom**: Mobile emits `quality-state` every quality change. The server's `call_signal` whitelist does **not** include it → server logs "rejected unknown signal type" and **drops every frame**. The feature is dead on any call involving the server relay, and web can never show the "X's connection is unstable" banner.
- **Why P0**: It's a shipped feature that is silently 100% broken, and it spams server warn logs on every mobile call.
- **Fix**: Add `"quality-state"` to the server whitelist (with light payload validation), and handle it on web `useWebRTC` to render the peer-unstable banner (mobile already renders it).
- **Effort**: S (≈1–2 h). Low risk.

### P0.3 — Missing "Busy" handling on 1:1 collision
- **Files**: `server/utils/ws.ts` (`call_initiate`), `client/src/CallContext.tsx`, `mobile/app/call/[conversationId].tsx`
- **Symptom**: If the callee is already in/handling a call, web `CallContext` silently drops the new `call_incoming`; the **caller is never told** and rings the full timeout. Mobile has no busy concept at all.
- **Why P0**: Confusing, frequent in real use (calling someone mid-call), and trivially observable. Slack/Teams/Meet all show "X is on another call" immediately.
- **Fix**: In `call_initiate`, if the target user has an `answered` (or currently `ringing`) call, emit `call_busy` to the caller instead of ringing; mark the call_log `missed`. Handle `call_busy` on web + mobile with a clear "X is on another call" message and auto-dismiss.
- **Effort**: M (≈half day). Server-authoritative, low risk.

---

## P1 — Strongly recommended this release

### P1.1 — Web caller has no ring/no-answer timeout
- **Files**: `client/src/components/chat/call/useWebRTC.ts` / `CallOverlay.tsx`
- **Symptom**: Mobile ends an unanswered outgoing call at 35s ("No answer"). Web relies only on the server's 45s stale-sweep → caller stares at "Ringing…" with no clean "No answer" UX, and the timeout differs by platform.
- **Fix**: Add a 35s outgoing ring timeout on web mirroring mobile; show "No answer" and end. Align server `STALE_RINGING_TTL_SECS` understanding (keep server slightly higher as the backstop).
- **Effort**: S. Low risk.

### P1.2 — Web has no hard "Connecting…" timeout
- **File**: `client/src/components/chat/call/useWebRTC.ts`
- **Symptom**: Mobile tears down a call stuck at "Connecting…" after 30s. Web has only a 5s disconnect grace and **no** connect timeout → a call that never reaches `connected` can hang indefinitely.
- **Fix**: Add a 30s connect timeout to web matching mobile; on expiry, end with a "Couldn't connect" message.
- **Effort**: S. Low risk.

### P1.3 — `nativeCallService` CallKeep listener double-bind (iOS)
- **File**: `mobile/src/services/nativeCallService.ts`
- **Symptom**: `configureCallKeep` adds `answerCall`/`endCall` listeners with no teardown. Re-init (logout→login) can double-bind → double `call_accept`/`call_reject`.
- **Why P1**: iOS-only, but causes duplicate actions which the server mostly absorbs via idempotency — still worth fixing to avoid edge races.
- **Fix**: Track an `initialized`/listener-set and remove existing listeners before re-adding (or guard re-init); add a teardown on logout.
- **Effort**: S. Low risk.

### P1.4 — ICE candidates lost during relay-only rebuild
- **Files**: `client/src/components/chat/call/useWebRTC.ts`, `mobile/app/call/[conversationId].tsx`
- **Symptom**: On the relay-only escalation rebuild, pending ICE buffers are cleared; candidates arriving between `close()` and the new PC's `setRemoteDescription` can be dropped, slowing/failing the corporate-network fallback (the exact scenario relay-only exists for).
- **Fix**: Keep buffering inbound ICE during rebuild and flush after the new remote description is set; don't blanket-clear.
- **Effort**: M. Medium risk (touches the recovery ladder) — test behind corporate-proxy / forced-relay.

### P1.5 — Group "call" half-works (decide + gate)
- **Files**: `server/utils/ws.ts` (`call_initiate` group branch), web `CallOverlay`, mobile call screen
- **Symptom**: `call_initiate` rings everyone for `is_group`, but the 1:1 call UI is strictly 2-party (mesh only exists under `meeting/`). A group call will half-connect and confuse.
- **Fix (release-safe)**: **Disable** group-call entry points in chat for this release (route group voice/video to the existing meeting flow). Full group-call-in-chat is P3.
- **Effort**: S (gating) now; defer the real feature.

---

## P2 — Next release (parity/polish)

### P2.1 — Web ringtone ignores user preference
- Web uses a synthesized WebAudio oscillator (`CallOverlay`) instead of the user-selected ringtone honored on mobile. Inconsistent UX. Reuse `NotificationPrefsContext` `playRingtone`. **Effort: S.**

### P2.2 — Audio output/input device picker (web/desktop)
- No `enumerateDevices` + `setSinkId` speaker/mic selection mid-call (Teams/Meet have it). **Effort: M.**

### P2.3 — In-call device hot-swap
- No `devicechange` handling (plug in a headset mid-call). **Effort: M.**

### P2.4 — Reconnecting overlay consistency
- Unify the web/mobile "reconnecting…" banner treatment. **Effort: S.**

### P2.5 — Client public-TURN fallback hardening
- `FALLBACK_ICE_SERVERS` hardcodes `openrelay.metered.ca` on web + mobile; if the server `/ice-config` fails, media relays through a third party even when `DISABLE_PUBLIC_TURN=true` server-side. Gate the client fallback via a served flag. **Effort: S.** (Security-adjacent; move up if compliance matters for release.)

---

## P3 — Roadmap (large effort / platform features)

### P3.1 — Android native call UI (CallKeep/ConnectionService)
- `resolveCallKeepModule` returns null on Android (disabled to avoid a crash). Android relies solely on Notifee full-screen-intent — the biggest parity gap vs WhatsApp/Teams on Android. Re-enabling needs careful native work + device testing. **Effort: L.**

### P3.2 — Group calling in chat (mesh/SFU)
- Real N-party calling in the chat call UI (reuse `meeting/` mesh or an SFU). **Effort: L.**

### P3.3 — Screen share on mobile
- Web has it; mobile doesn't. **Effort: M–L.**

### P3.4 — DTMF / richer hold signalling
- Nice-to-have. **Effort: M.**

---

## Recommended Release Cut

**Ship this release with:** P0.1 (done), **P0.2**, **P0.3**, plus **P1.1**, **P1.2**, **P1.3**, and **P1.5 (gating only)**.
These are all **Small/Medium, low-risk** and eliminate the visible, ticket-generating defects (broken quality signal, no busy state, no web ring/connect timeouts, iOS double-accept, confusing group calls).

**Defer:** P1.4 if corporate-proxy testing can't be done in time (it's real but needs forced-relay validation), and everything in P2/P3.

### Suggested implementation order (single release branch)
1. **P0.2** quality-state whitelist + web banner (unblocks a dead feature, kills log spam)
2. **P0.3** call_busy end-to-end
3. **P1.1 + P1.2** web ring + connect timeouts (same file, do together)
4. **P1.3** CallKeep listener teardown
5. **P1.5** gate group calls
6. *(if time)* **P1.4** ICE buffering across rebuild — with forced-relay test