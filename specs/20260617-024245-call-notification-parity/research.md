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
