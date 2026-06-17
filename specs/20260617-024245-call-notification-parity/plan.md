# Implementation Plan: Native Incoming Call & Notification Parity

**Branch**: `20260617-024245-call-notification-parity` | **Date**: 2026-06-17 | **Spec**: `specs/20260617-024245-call-notification-parity/spec.md`

**Input**: Feature specification from `specs/20260617-024245-call-notification-parity/spec.md`

## Summary

Implement a native call-notification pipeline (CallKeep/ConnectionService + FCM/APNs background handling) so incoming calls can be shown and answered from OS UI when app is backgrounded/terminated, while preserving current websocket-based media negotiation. In parallel, harden message notification status-bar delivery and launcher badge synchronization using server-authoritative unread counts and resilient client sync hooks.

## Technical Context

**Language/Version**:
- Mobile: TypeScript, React Native 0.85.3, Expo SDK ~56 (custom native build flow)
- Server: TypeScript (Node.js + Express 5)

**Primary Dependencies**:
- Existing: `expo-notifications`, `react-native-webrtc`, websocket signaling (`mobile/src/realtime/socket.ts`, `server/utils/ws.ts`)
- New (planned): `react-native-callkeep`, `@react-native-firebase/messaging`
- Optional: `@notifee/react-native` for Android full-screen call UX polish

**Storage**:
- PostgreSQL tables reused: `device_tokens`, `call_logs`, `messages`, `message_reads`
- Redis unread cache fallback remains enabled where already used

**Testing**:
- Server: Jest + Supertest (`server/__tests__`)
- Mobile: TypeScript typecheck + targeted integration/e2e verification in custom builds

**Target Platform**:
- Android 13+ and iOS 16+ for primary parity goals

**Project Type**:
- Multi-tenant web-service + mobile app

**Performance Goals**:
- Incoming call UI displayed within 2s (SC-001)
- Answer action transitions to connecting within 3s (SC-002)
- Message notification visible delivery >=99% under granted permissions (SC-003)

**Constraints**:
- Must keep websocket as canonical negotiation channel
- Must not break existing Expo route/navigation and chat/call flows
- Must preserve tenant-scoped push-token and signaling behavior

**Scale/Scope**:
- Tenant-scoped, all mobile users with chat/call feature enabled
- Applies to app states: foreground, background, terminated

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Multi-Tenancy Isolation** — Reuse tenant-scoped token registration and call signaling; no client tenant override introduced.
- [x] **II. Security-First** — No auth storage regressions; action callbacks still server-authenticated and RBAC-checked.
- [x] **III. Real-Time Reliability** — Plan enforces idempotent call action processing and reconnect-safe retries.
- [x] **IV. Test Coverage** — Plan includes server integration + handler unit coverage for new stateful paths.
- [x] **V. Observability** — Add structured logs for push dispatch, native action callbacks, retry/failure states.
- [x] **VI. Simplicity** — Minimal new dependencies (CallKeep + FCM messaging) justified by mandatory OS-level behavior requirement.

## Project Structure

### Documentation (this feature)

```text
specs/20260617-024245-call-notification-parity/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── push-payload-contract.md
│   └── native-call-action-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
mobile/
├── app.config.ts
├── app/
│   └── call/[conversationId].tsx
└── src/
    ├── realtime/
    │   ├── PushNotificationInitializer.tsx
    │   ├── PushNotificationListener.tsx
    │   └── socket.ts
    └── services/
        └── pushNotificationService.ts

server/
├── services/
│   └── pushNotifications.ts
├── routes/
│   └── auth.ts
└── utils/
    └── ws.ts
```

**Structure Decision**: Use existing `mobile/` and `server/` modules; add native-call bridge and background push handling into current mobile realtime/services layers, and keep server push payload generation in `server/services/pushNotifications.ts`.

## Phase 0: Research Plan

1. Decide final native-call stack for Expo custom builds (CallKeep + Firebase Messaging baseline, Notifee optional).
2. Validate Android/iOS permission and entitlement matrix required for terminated-state incoming call UI.
3. Define idempotent action-ack pattern for answer/reject events racing with websocket reconnect.
4. Define reliable badge-source policy (server unread as source of truth, local optimistic sync window).
5. Identify rollback/fallback behaviors when native call framework unavailable on device/OS.

## Phase 1: Design Plan

1. Model entities and lifecycle for push invite, native action event, and badge sync.
2. Define push payload and native-action contracts used between server, FCM/APNs, and mobile handlers.
3. Produce quickstart flow for local validation in custom dev build + staging.
4. Update agent context to point to this plan file.
5. Re-check constitution gates post-design (expected pass, no violations).

## Post-Design Constitution Re-Check

- [x] **I. Multi-Tenancy Isolation** — Design keeps tenant/user context attached in push payload metadata and server checks.
- [x] **II. Security-First** — No new unauthenticated control path; native actions pass through authenticated signaling.
- [x] **III. Real-Time Reliability** — Explicit idempotency keys and one-call-per-user-callId guards included.
- [x] **IV. Test Coverage** — Contract + integration tests defined in quickstart and contracts.
- [x] **V. Observability** — Contract requires structured log keys for every state transition.
- [x] **VI. Simplicity** — No speculative features (group-call expansion, PSTN bridging) included.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New native dependencies (`react-native-callkeep`, Firebase Messaging) | Required for true OS-level answer-from-lock-screen behavior | Expo notifications + JS-only handlers cannot guarantee terminated-state call UI parity |
