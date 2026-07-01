# Phase 0 Research - Native Incoming Call & Notification Parity

## Decision 1: Use `react-native-callkeep` + `@react-native-firebase/messaging` in Expo custom builds

- **Decision**: Adopt CallKeep for OS-native incoming call UI and Firebase Messaging for background/terminated push handling.
- **Rationale**: This combination is the minimum reliable path for "answer without opening app" behavior; it provides Android ConnectionService and iOS CallKit hooks plus headless/background delivery handlers.
- **Alternatives considered**:
  - `expo-notifications` only: rejected; cannot guarantee terminated-state native call UI parity.
  - Notifee-only implementation: rejected as primary path; improves Android UX but does not replace CallKit/ConnectionService semantics.

## Decision 2: Keep websocket signaling as source of truth for call negotiation

- **Decision**: Continue using existing `call_initiate/call_accept/call_signal/call_end` websocket protocol; native action handlers only bridge into this flow.
- **Rationale**: Reuses battle-tested signaling and avoids duplicating negotiation logic in push layer.
- **Alternatives considered**:
  - Move full signaling to push actions: rejected due to complexity and unreliable sequencing for SDP/ICE exchange.

## Decision 3: Treat server unread count as badge source of truth

- **Decision**: Badge value is derived from `getConversations().unread_count` / server unread cache and reconciled on foreground events + read actions.
- **Rationale**: Eliminates client-only badge drift and keeps consistency across multi-device usage.
- **Alternatives considered**:
  - Client-local unread counter only: rejected; drifts on missed socket events/offline windows.

## Decision 4: Use default notification channel for guaranteed background posting

- **Decision**: Route server notifications through a guaranteed channel (`default`) and create richer channels on app init.
- **Rationale**: Prevents dropped notifications when custom channels are absent during killed-app delivery.
- **Alternatives considered**:
  - Custom channel only (`calls/messages`): rejected due to first-run/terminated-state race risk.

## Decision 5: Enforce idempotent native call actions

- **Decision**: Include dedupe guards keyed by `callId + action + userId` when applying answer/reject transitions.
- **Rationale**: Duplicate push/action callbacks are common; idempotency prevents ghost/duplicate call state.
- **Alternatives considered**:
  - No dedupe and rely on transport order: rejected; violates constitution reliability principle.

## Decision 6: Permission strategy is explicit and stateful

- **Decision**: Add onboarding checks for POST_NOTIFICATIONS (Android), notification/call permissions (iOS), with settings deep-link fallback.
- **Rationale**: Missing permissions are the primary non-code cause of delivery failures.
- **Alternatives considered**:
  - Silent failure with logs only: rejected; poor user recoverability.

## Decision 7: Ring TTL fixed at 30 seconds (clarification 2026-07-01)

- **Decision**: The incoming-call invite rings for 30 seconds, then auto-transitions to `missed` and dismisses the native UI on all of the callee's devices.
- **Rationale**: Matches Teams-style expectation and the existing server stale-call sweep window; short enough to avoid stuck ringing, long enough for a locked device to react.
- **Alternatives considered**:
  - 45s (existing sweep default): acceptable but longer than product target.
  - Per-tenant configurable: rejected as premature (YAGNI, Principle VI).

## Decision 8: First-write-wins for simultaneous multi-device answer (clarification 2026-07-01)

- **Decision**: The first `call_accept` to reach the server applies the `answered` transition via the existing `withIdempotentCallAction` guard; other devices of the same callee receive `call_handled_elsewhere` and dismiss.
- **Rationale**: Reuses the already-implemented atomic call-action idempotency; no new coordination protocol needed.
- **Alternatives considered**:
  - Most-recently-active device wins: rejected; requires extra device-activity tracking with no user benefit.
  - Multi-device merge/join: rejected; out of scope for 1:1 call parity.

## Decision 9: Lock-screen content shown by default with per-user hide toggle (clarification 2026-07-01, FR-010)

- **Decision**: Caller name and message preview render on the lock screen by default; a per-user `hideSensitiveContent` preference switches to generic content ("Incoming call" / "New message") via Android channel `visibility` and iOS content-preview suppression.
- **Rationale**: Matches WhatsApp/Teams defaults and the existing implementation (call pushes already carry caller name/avatar) while preserving a privacy escape hatch.
- **Alternatives considered**:
  - Always hide: rejected; degrades default UX.
  - Always show (no toggle): rejected; no privacy control for shared/visible devices.

## Decision 10: Launcher badge counts combined unread (clarification 2026-07-01)

- **Decision**: The badge value is `unread chat messages + unread in-app notifications`, reconciled against the server's authoritative totals — matching the existing mobile `TopBar` computation.
- **Rationale**: Users expect the launcher dot to reflect everything needing attention; codifies current behavior and prevents divergence tests from ambiguity.
- **Alternatives considered**:
  - Messages-only badge: rejected; hides mentions/task/approval notifications.
  - Notifications-only badge: rejected; hides unread chats (the primary use case).

## End-to-end validation notes (2026-06-17)

### Automated validation

- ✅ `mobile`: `npx tsc --noEmit -p tsconfig.json`
- ✅ `server`: `npm run typecheck`
- ✅ `server`: `npm run test`
- ✅ `server` reliability subset:
  - `ws.callAcceptReconnect.test.ts`
  - `ws.callDuplicateInvite.test.ts`
  - `ws.callActionIdempotency.test.ts`
  - `wsMetrics.test.ts`

### Reliability checks covered by automation

- Reconnect-time `call_accept` replay is deduped.
- Duplicate call invite replay with same `clientMsgId` is deduped.
- Call-action dedupe keys are isolated by `callId`.
- Terminal-state call transitions (`answered/rejected/ended`) emit structured diagnostics instead of mutating state again.

### Manual device checks to run before production cut

- Android and iOS physical-device verification of lock-screen incoming-call UI.
- Background/terminated message status-bar visibility and launcher badge parity.
- Permission recovery UX flow (Open Settings deep-link) on denied-notification state.
