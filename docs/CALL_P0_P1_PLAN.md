# Call P0/P1 Implementation Tracker (Resumable)

> **Purpose**: Single source of truth for the P0/P1 call fixes. Any fresh context
> window MUST read this file first and resume from the first unchecked item.
> Update the checkboxes immediately after each sub-task. Never hand off mid-edit
> — finish each item to a compiling state (`tsc --noEmit` clean) before stopping.

## Build / verify commands
- Server: `cd server && npx tsc --noEmit`
- Web: `cd client && npx tsc --noEmit`
- Mobile: `cd mobile && npx tsc --noEmit`

## Canonical constants (keep consistent across surfaces)
- `VALID_SIGNAL_TYPES = ["offer","answer","ice-candidate","video-state","audio-state","screen-share-state","quality-state"]`
- Web/mobile client timeouts: `RING_TIMEOUT_MS = 35000`, `CONNECT_TIMEOUT_MS = 30000`
- Server backstop: `STALE_RINGING_TTL_SECS = 45` (must stay > client ring timeout)

## Payload schemas
- `quality-state` signal: `{ type:"quality-state", quality:"good"|"fair"|"poor"|"unknown" }`
- `call_busy` event (server→caller): `{ conversationId, targetUserId, reason:"busy" }`

## Execution order & RESUME POINTER
**ALL P0/P1 items complete (P0.1–P0.3, P1.1–P1.5). Remaining: the deferred 🧪 server/mobile unit tests noted under P0.2 / P0.3 / P1.3.**

### Notes for resuming context
- **P0.2 DONE & tsc-clean (server + client).** quality-state now flows mobile↔server↔web bidirectionally; web shows the peer-unstable banner and emits its own quality. (Server unit test still pending — bundle with P1 tests.)
- **P0.3 DONE & tsc-clean (server + client + mobile).** `call_initiate` detects a busy 1:1 callee, records a `missed` row, emits `call_busy`; web toasts + ends, mobile Alerts + `endAndLeave(false)`.
- **P1.1 + P1.2 DONE & tsc-clean (client).** `client/src/components/chat/call/index.tsx` ring/connect timeouts + "No answer"/"Couldn't connect" via `endMessage`. Server backstop `STALE_RINGING_TTL_SECS = 45`.
- **P1.3 DONE & tsc-clean (mobile).** `nativeCallService` `teardown()` + re-init guard; `AuthContext` logout calls it; test added (no jest runner configured here).
- **P1.5 DONE & tsc-clean (server + client + mobile).** Server `call_initiate` now rejects `is_group` conversations (emits `call_ended { reason:"group_unsupported" }` to the caller, no ring row, records `recordCallTransitionFailure({ reason:"group_unsupported" })`). Web (`pages/chat/ChatHeader.tsx`) already gates with `canCall = !isGroup && ...` so group chats never show voice/video call buttons. Mobile (`app/chat/[id].tsx`) already wraps the call buttons in `!c.isGroupConv ? (...) : null` so group chats hide them too. No client code change was required — the "hide" path of "hide/redirect" satisfies the gate, and the server reject is the authoritative backstop. (Group n-way uses the Meeting flow.)
- **P1.4 DONE & tsc-clean (client + mobile).** Both the web `useWebRTC.ts` and mobile `[conversationId].tsx` relay-only rebuild paths no longer wipe the buffered remote ICE candidates; `flushPendingIceCandidates()` / `flushIce()` drain them after the new `setRemoteDescription`. Glare guards (polite/impolite + makingOffer) stay active. See the P1.4 section for the forced-relay validation note.
- Reference: `call_busy` payload `{ conversationId, targetUserId, reason:"busy" }`; `sendToUser(tenantId, userId, type, data)` is the server helper.

---

## P0.1 — Background incoming-call notification (regression) — ✅ DONE
- [x] Fixed invalid `vibrationPattern` in `mobile/src/services/notifeeService.ts` `displayIncomingCall()`
- [x] Added defensive retry-without-extras fallback in catch
- [x] `tsc` clean

## P0.2 — quality-state interop (mobile→server→web)
- [x] 🟥 `server/utils/ws.ts` `call_signal`: add `"quality-state"` to `VALID_SIGNAL_TYPES`
- [x] 🟥 `server/utils/ws.ts`: validate `signal.quality ∈ {good,fair,poor,unknown}`, reject otherwise
- [x] 🟦 `client/src/components/chat/call/useWebRTC.ts`: handle `quality-state` → `remotePeerQuality` state + expose from hook (+ `sendQualityState`)
- [x] 🟦 `client/src/components/chat/call/index.tsx`: render "‹name›'s connection is unstable" banner when `remotePeerQuality === "poor"`
- [x] 🟦 web emits its own `quality-state` on quality change (bidirectional parity)
- [ ] 🧪 server unit test: valid relayed, invalid dropped (deferred — bundle with P0.3 test)
- [x] `tsc` clean (server + client)

## P0.3 — call_busy on 1:1 collision — ✅ DONE
- [x] 🟥 `server/utils/ws.ts` `call_initiate`: for non-group, detect target busy (`ringing`/`answered`), emit `call_busy` to caller, skip ringing row (inserts a `missed` history row)
- [x] 🟦 `client/src/pages/chat/useCallState.ts`: `case "call_busy"` → end outgoing + toast "‹name› is on another call"
- [x] 🟩 `mobile/app/call/[conversationId].tsx`: `case "call_busy"` → Alert + `endAndLeave(false)`
- [ ] 🧪 server unit test: busy target → `call_busy`, no `ringing` row (deferred — bundle with P1 tests)
- [x] `tsc` clean (server + client + mobile)

## P1.1 — Web ring/no-answer timeout (35s + "No answer") — ✅ DONE
- [x] 🟦 `client/src/components/chat/call/index.tsx`: `RING_TIMEOUT_MS=35000`; show "No answer" before `handleEnd()`
- [x] 🟥 `server/jobs.ts`: confirmed `STALE_RINGING_TTL_SECS=45` backstop already present (> 35s client timeout)
- [x] `tsc` clean (client)

## P1.2 — Web connect timeout (30s + "Couldn't connect") — ✅ DONE
- [x] 🟦 `client/src/components/chat/call/index.tsx`: `connecting`/`reconnecting` 30s (`CONNECT_TIMEOUT_MS`) → "Couldn't connect" then `handleEnd()`
- [x] `tsc` clean (client)

## P1.3 — iOS CallKeep listener teardown — ✅ DONE
- [x] 🟩 `mobile/src/services/nativeCallService.ts`: guard re-init / remove listeners before re-add; add `teardown()`
- [x] 🟩 `mobile/src/auth/AuthContext.tsx`: call `nativeCallService.teardown()` on logout
- [x] 🧪 `nativeCallService.test.ts`: assert no double-bind after re-init (written; mobile has no jest runner configured so not executed here)
- [x] `tsc` clean (mobile)

## P1.5 — Gate group calls — ✅ DONE
- [x] 🟥 `server/utils/ws.ts` `call_initiate`: group → emit `call_ended(reason:group_unsupported)`, no ring row
- [x] 🟦 web chat call buttons: already gated — `pages/chat/ChatHeader.tsx` `canCall = !isGroup && ...` hides group voice/video buttons
- [x] 🟩 mobile chat call buttons: already gated — `app/chat/[id].tsx` `!c.isGroupConv ? (...) : null` hides group voice/video buttons
- [x] `tsc` clean (server + client + mobile)

## P1.4 — Preserve ICE candidates across relay-only rebuild — ✅ DONE
- [x] 🟦 `client/src/components/chat/call/useWebRTC.ts`: stop clearing `pendingIceCandidatesRef` on rebuild; flush after new `setRemoteDescription`. The offer-received rebuild path (`handleSignal`, was line ~794) no longer does `pendingIceCandidatesRef.current = []`; the existing `flushPendingIceCandidates()` calls (after each `setRemoteDescription` in `handleSignalInternal`) drain the buffered candidates onto the rebuilt PC.
- [x] 🟩 `mobile/app/call/[conversationId].tsx`: stop `pendingIce.current = []` on rebuild; flush via `flushIce()` after remote desc. BOTH relay-only rebuild sites were fixed — (a) the `onconnectionstatechange("failed")` escalation rebuild and (b) the `call_signal` offer-received rebuild. `flushIce()` (already called after `setRemoteDescription` on both offer + answer) now drains the preserved buffer.
- [x] 🟦🟩 keep polite/impolite + makingOffer glare guards active during rebuild (untouched — `politeRef`/`makingOfferRef` collision handling still runs on the rebuilt PC)
- [x] `tsc` clean (client + mobile)
- [x] ⚠️ forced-relay validation (block UDP / iceTransportPolicy=relay): **Static/code validation only — no live two-device forced-relay run was possible in this headless environment.** Reasoning: in relay-only mode the buffered remote candidates are TURN `relay`-type candidates the peer already gathered; they stay valid for the rebuilt PC because the peer keeps the same TURN allocation across the escalation (only the local side toggles `iceTransportPolicy=relay`). Both flush helpers early-return unless `remoteDescription` is set, and per-candidate `addIceCandidate` failures are swallowed, so a stale candidate can never abort ICE. **Recommended before release:** a runtime forced-relay smoke test (block UDP on the host, or set `iceTransportPolicy=relay` unconditionally + firewall STUN) to confirm media flows end-to-end after the escalation.

---

## Handoff protocol (if context ~80%)
1. Ensure current file edits compile (`tsc` clean) — never stop mid-edit.
2. Update this tracker's checkboxes + move the **RESUME POINTER**.
3. Spawn `new_task` with: completed items, next unchecked task, file targets,
   constants/payloads above, and any pending verification.
4. New context reads this file first, resumes from RESUME POINTER.