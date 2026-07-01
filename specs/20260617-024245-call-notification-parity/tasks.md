# Tasks: Native Incoming Call & Notification Parity

**Input**: Design documents from `specs/20260617-024245-call-notification-parity/`

**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Included because the feature spec explicitly requires integration/unit coverage (FR-009).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (`US1`, `US2`, `US3`)
- Every task includes an exact file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare dependencies, native build scaffolding, and baseline configuration.

- [X] T001 ✅ COMPLETE Add native call and messaging dependencies in `mobile/package.json` and lock updates in `mobile/package-lock.json`
- [X] T002 ✅ COMPLETE Add Expo plugin and permissions config for call/notification parity in `mobile/app.config.ts`
- [X] T003 [P] ✅ COMPLETE Add mobile environment variable placeholders for push/call setup in `mobile/.env.example`
- [X] T004 [P] ✅ COMPLETE Add server environment variable placeholders for APNs/FCM call payload controls in `server/.env.example`
- [X] T005 ✅ COMPLETE Document custom-build prerequisites for call parity in `mobile/RELEASE.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement shared infrastructure required by all user stories.

**⚠️ CRITICAL**: No user story work starts before this phase is complete.

- [X] T006 ✅ COMPLETE Implement native call bridge service skeleton in `mobile/src/services/nativeCallService.ts` (133 lines, CallKeep integration)
- [X] T007 ✅ COMPLETE Implement background push handler entrypoint in `mobile/src/services/backgroundPushService.ts` (53 lines)
- [X] T008 [P] ✅ COMPLETE Wire app bootstrap to initialize native call + push background services in `mobile/app/_layout.tsx`
- [X] T009 [P] ✅ COMPLETE Extend mobile push notification service contract helpers for typed call/message payload normalization in `mobile/src/services/pushNotificationService.ts` (352 lines, full implementation)
- [X] T010 ✅ COMPLETE Add server-side payload builder helpers (call/message/common metadata) in `server/services/pushNotifications.ts`
- [X] T011 ✅ COMPLETE Add idempotency helper for native call action events in `server/utils/wsIdempotency.ts` (242 lines, LRU cache with 5min TTL)
  - **Acceptance Criteria**: (1) Dedup key format: `{userId}:{callId}:{actionType}` (answer/reject/end); (2) Cache TTL: 5 minutes ✅; (3) Handler checks dedup key before state mutation ✅; (4) Duplicate push delivery (T034 scenario) produces single call_accept event ✅; (5) Out-of-order websocket + push actions handled idempotently ✅
- [X] T012 ✅ COMPLETE Add structured logging schema for push/call lifecycle events in `server/utils/logger.ts` (109 lines)

**Checkpoint**: Foundation complete; user stories can proceed.

---

## Phase 3: User Story 1 - Answer incoming call from system UI (Priority: P1) 🎯 MVP

**Goal**: Show native incoming-call UI while app is backgrounded/terminated and allow answer/reject from OS UI.

**Independent Test**: Terminate app, send incoming call push, verify native call UI appears, answer joins call, reject signals caller and stops ringing.

### Tests for User Story 1

- [X] T013 [P] [US1] Add server integration tests for incoming call push payload contract in `server/__tests__/pushNotifications.callPayload.test.ts`
  - **Acceptance Criteria**: (1) Valid payload with correct tenant_id generates expected call invite; (2) Payload with spoofed/different tenant_id is rejected by server validation; (3) Payload missing tenant_id generates error; (4) Duplicate invites with same dedupeKey produce single call state
- [X] T014 [P] [US1] Add server integration tests for call action idempotency (`answer`/`reject`) in `server/__tests__/ws.callActionIdempotency.test.ts`
- [X] T015 [P] [US1] Add mobile service unit tests for native call action mapping in `mobile/src/services/__tests__/nativeCallService.test.ts`

### Implementation for User Story 1

- [X] T016 [US1] Implement incoming call push -> native UI display flow in `mobile/src/services/backgroundPushService.ts`
- [X] T017 [US1] Implement native answer/reject callbacks and deep-link bridge in `mobile/src/services/nativeCallService.ts`
  - **Security Note**: All callbacks MUST use authenticated WebSocket (HttpOnly JWT from session, never plaintext token in push payload). Server-side RBAC enforcement (user owns call) applied before state mutation. No native-action shortcuts around auth.
- [X] T018 [US1] Update call screen to accept native-entry params and auto-connect flow in `mobile/app/call/[conversationId].tsx`
- [X] T019 [US1] Add call action retry-on-reconnect helper usage in `mobile/src/realtime/socket.ts`
- [X] T020 [US1] Extend websocket handler for deduped native call actions in `server/utils/ws.ts`
  - **Security Note**: Verify caller ownership (authenticated user_id must own call or be invited participant). Enforce RBAC before transitioning call state. Log all answer/reject/end actions with tenant/user/call context.
- [X] T021 [US1] Extend call push payload fields (`expiresAt`, `dedupeKey`, caller metadata) in `server/services/pushNotifications.ts`
- [X] T022 [US1] Add call push observability logs with tenant/user/call context in `server/services/pushNotifications.ts`
- [X] T023 [US1] Add native call onboarding and permission prompt flow in `mobile/src/realtime/PushNotificationInitializer.tsx`
  - **Acceptance Criteria**: (1) First app launch: show call + notification permission prompts with clear UX; (2) If user grants both: proceed to home; (3) If user denies: show retry option on next app open (max once per 24h); (4) Show settings deep-link if user denies twice; (5) App remains functional without permissions (no crashes); (6) Permissions state persisted in AsyncStorage

---

## Phase 4: User Story 2 - Receive message notifications with launcher badge (Priority: P1)

**Goal**: Ensure status-bar notifications and launcher badge/dot remain accurate in all app states.

**Independent Test**: Send messages with app foreground/background/terminated, verify status-bar visibility and badge increments/decrements without app restart.

### Tests for User Story 2

- [X] T024 [P] [US2] ✅ COMPLETE Add server integration tests for message push payload/channel behavior in `server/__tests__/pushNotifications.messagePayload.test.ts`
- [X] T025 [P] [US2] ✅ COMPLETE Add mobile unit tests for unread badge synchronization logic in `mobile/src/realtime/__tests__/chatUnreadEvents.test.ts`
- [X] T026 [P] [US2] ✅ COMPLETE Add mobile integration tests for notification response routing and badge updates in `mobile/src/realtime/__tests__/PushNotificationListener.test.tsx`

### Implementation for User Story 2

- [X] T027 [US2] ✅ COMPLETE Implement reliable status-bar notification channel/category handling in `mobile/src/services/pushNotificationService.ts` (352 lines)
- [X] T028 [US2] ✅ COMPLETE Implement unread authoritative-sync trigger pipeline in `mobile/src/realtime/chatUnreadEvents.ts`
- [X] T029 [US2] ✅ COMPLETE Integrate unread sync and launcher badge reconciliation in `mobile/app/(tabs)/_layout.tsx`
- [X] T030 [US2] ✅ COMPLETE Emit unread refresh events after read/write chat mutations in `mobile/src/components/chat/useChatThread.ts`
- [X] T031 [US2] ✅ COMPLETE Normalize message push payload delivery parameters and logging in `server/services/pushNotifications.ts`
- [X] T032 [US2] ✅ COMPLETE Add permissions recovery UX (settings deep-link and state checks) in `mobile/src/realtime/PushNotificationListener.tsx` (239 lines)
  - **Acceptance Criteria**: (1) If notification permission denied: show banner with settings deep-link ✅; (2) Tapping link opens OS settings (Android: App Settings → Notifications; iOS: Settings → [App] → Notifications) ✅; (3) On returning to app: check permission state and update badge/notification delivery ✅; (4) Banner dismissed on permission grant ✅; (5) No infinite retry loops (max 1 retry per session) ✅

**Checkpoint**: US2 is fully functional and independently testable.

---

## Phase 5: User Story 3 - Preserve reliable call signaling across reconnects (Priority: P2)

**Goal**: Prevent duplicate/ghost call states and improve reliability under reconnect and duplicate push conditions.

**Independent Test**: Simulate reconnect and duplicate deliveries; verify only one effective call state transition and stable connect behavior.

### Tests for User Story 3

- [X] T033 [P] [US3] ✅ COMPLETE Add websocket integration tests for reconnect-time call_accept retry behavior in `server/__tests__/ws.callAcceptReconnect.test.ts`
- [X] T034 [P] [US3] ✅ COMPLETE Add websocket integration tests for duplicate invite/action de-duplication in `server/__tests__/ws.callDuplicateInvite.test.ts`
- [X] T035 [P] [US3] ✅ COMPLETE Add mobile unit tests for retry/backoff send helper in `mobile/app/call/__tests__/callRetryFlow.test.ts`

### Implementation for User Story 3

- [X] T036 [US3] ✅ COMPLETE Implement bounded retry/backoff utility for call signaling sends in `mobile/src/realtime/socket.ts`
- [X] T037 [US3] ✅ COMPLETE Apply reconnect-safe call action send helper in `mobile/app/call/[conversationId].tsx`
- [X] T038 [US3] ✅ COMPLETE Enforce server-side dedupe and terminal-state guards for call actions in `server/utils/ws.ts`
- [X] T039 [US3] ✅ COMPLETE Add structured reliability diagnostics for call transition failures in `server/utils/wsMetrics.ts`

**Checkpoint**: US3 is fully functional and independently testable.

---

## Phase 5.5: Performance Validation (Latency & Reliability)

**Purpose**: Validate that incoming call UI display and answer-to-connect transitions meet measurable SLA targets under realistic network conditions.

- [X] T044 [P] [US1, US2] ✅ COMPLETE Add latency assertion tests for call UI display and answer-to-connect transitions in `server/__tests__/performanceMetrics.test.ts` and `mobile/app/call/__tests__/callLatency.test.ts`
  - **Acceptance Criteria**: (1) Call UI display latency from push receipt to native UI render: target <= 2s (95th percentile, 3G/4G network simulation) ✅; (2) Answer action from user tap to WebSocket call_accept delivery: target <= 3s (95th percentile) ✅; (3) Test harness simulates realistic network delays (100-500ms latency, 1-5% packet loss) ✅; (4) SLA validation runs in CI; failures block merge ✅; (5) Metrics logged with percentile breakdown (p50, p95, p99) ✅

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finish documentation, validation, and cross-story hardening.

- [X] T040 [P] ✅ COMPLETE Update quickstart verification steps with final command and device matrix in `specs/20260617-024245-call-notification-parity/quickstart.md`
- [X] T041 ✅ COMPLETE Run and document end-to-end validation notes for all stories in `specs/20260617-024245-call-notification-parity/research.md`
- [X] T042 [P] ✅ COMPLETE Add/refresh release checklist for native build requirements in `mobile/RELEASE.md`
- [X] T043 ✅ COMPLETE Final structured log field audit for call/message notification lifecycle in `server/services/pushNotifications.ts`

---

## Phase 7: Clarification Follow-Ups (2026-07-01 session)

**Purpose**: Implement the decisions recorded in the spec's Clarifications session that are
not yet covered by T001–T044. All tasks below are NEW and not-started.

**Prerequisites**: Phases 1–2 complete (they are). These build on the already-shipped stack.

### Ring TTL = 30 seconds (US1)

- [X] T045 ✅ COMPLETE Set `expiresAt = createdAt + 30s` on the outgoing call push payload in `server/services/pushNotifications.ts` (align with `IncomingCallInvite.expiresAt` in data-model)
- [X] T046 ✅ COMPLETE Enforce 30s ring auto-expiry — mark the `call_logs` row `missed` and broadcast `call_ended` + push-cancel to all callee devices when the ring window elapses — in `server/utils/ws.ts` (reuse the existing stale-call sweep; tighten window to 30s)
- [X] T047 [P] [US1] ✅ COMPLETE Add server test asserting a call auto-transitions to `missed` and dismisses on all devices after the 30s TTL in `server/__tests__/ws.callActionIdempotency.test.ts`
- [X] T048 [US1] ✅ COMPLETE Dismiss the native CallKeep/Notifee incoming-call UI when a `call_ended`/expiry frame arrives after TTL in `mobile/src/services/nativeCallService.ts`

### Lock-screen content visibility toggle (FR-010, cross-cutting)

- [X] T049 [P] ✅ COMPLETE Add `hideSensitiveContent` (boolean, default false) to the notification-prefs schema and GET/PUT handlers in `server/routes/profile.ts`
- [X] T050 ✅ COMPLETE Honor `hideSensitiveContent` when building call/message pushes — omit `callerName`/`callerAvatar`/message preview from OS-rendered content when enabled — in `server/services/pushNotifications.ts`
- [X] T051 [P] ✅ COMPLETE Render generic lock-screen content ("Incoming call" / "New message") and set Android channel `visibility` to `PRIVATE/SECRET` when the pref is enabled in `mobile/src/services/notifeeService.ts`
- [X] T052 ✅ COMPLETE Add a "Hide sensitive content on lock screen" toggle in the mobile notification settings UI in `mobile/app/profile.tsx`
- [X] T053 [P] ✅ COMPLETE Extend the mobile notification-prefs type + API with `hideSensitiveContent` in `mobile/src/features.ts`
- [X] T054 [P] ✅ COMPLETE Add server tests for lock-screen visibility behavior (content shown by default; suppressed when pref enabled) in `server/__tests__/pushNotifications.callPayload.test.ts` and `server/__tests__/pushNotifications.messagePayload.test.ts`

### Combined launcher badge (US2)

- [X] T055 [P] [US2] ✅ COMPLETE Verify the launcher badge equals unread chat messages + unread in-app notifications (combined), adding an assertion if missing, in `mobile/src/realtime/__tests__/chatUnreadEvents.test.ts`

### First-write-wins multi-device answer (US3)

- [X] T056 [P] [US3] ✅ COMPLETE Add server test: two simultaneous `call_accept` frames from the same callee's devices → first applies the transition, the second is a no-op and receives `call_handled_elsewhere` (first-write-wins) in `server/__tests__/ws.callActionIdempotency.test.ts`

**Checkpoint**: Clarification decisions (30s TTL, lock-screen toggle, combined badge, first-write-wins) are implemented and covered by tests.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies.
- **Phase 2 (Foundational)**: Depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: Depends on Phase 2.
- **Phase 4 (US2)**: Depends on Phase 2; can run in parallel with US1 after foundational completion.
- **Phase 5 (US3)**: Depends on Phase 2 and should start after US1 signaling changes (T020-T021) land.
- **Phase 6 (Polish)**: Depends on completion of target user stories.
- **Phase 7 (Clarification Follow-Ups)**: Depends on Phases 1–2 (complete). Ring-TTL tasks (T045–T048) extend US1; lock-screen tasks (T049–T054) are cross-cutting; badge (T055) extends US2; first-write-wins test (T056) extends US3.

### User Story Dependencies

- **US1**: Independent after foundational setup.
- **US2**: Independent after foundational setup.
- **US3**: Depends on US1 call action plumbing but remains independently testable once prerequisite tasks are complete.

### Within Each Story

- Tests are written before or alongside implementation and must fail before final implementation completion.
- Service/core logic before UI wiring.
- Server contract/payload updates before final mobile behavior validation.

---

## Parallel Execution Examples

### User Story 1

```text
Run in parallel:
- T013 server payload contract tests
- T014 server idempotency tests
- T015 mobile native action mapping tests
```

### User Story 2

```text
Run in parallel:
- T024 server message payload tests
- T025 mobile unread sync unit tests
- T026 mobile notification routing integration tests
```

### User Story 3

```text
Run in parallel:
- T033 reconnect call_accept integration tests
- T034 duplicate invite de-duplication tests
- T035 mobile retry/backoff unit tests
```

### Phase 7 (Clarification Follow-Ups)

```text
Run in parallel (independent files):
- T047 ring-TTL expiry server test
- T049 server notification-prefs schema (hideSensitiveContent)
- T051 mobile notifee generic lock-screen render
- T053 mobile notification-prefs type + API
- T054 server lock-screen visibility tests
- T055 combined-badge assertion test
- T056 first-write-wins multi-device answer test
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Phases 1-2.
2. Complete Phase 3 (US1).
3. Validate incoming-call parity in terminated/background states.
4. Ship MVP if stable.

### Incremental Delivery

1. Deliver US1 (incoming call parity).
2. Deliver US2 (message + badge parity).
3. Deliver US3 (reconnect reliability hardening).
4. Finish with Phase 6 polish and release checklist updates.

### Parallel Team Strategy

1. Team completes Phase 1-2 together.
2. Split by story:
   - Engineer A: US1
   - Engineer B: US2
   - Engineer C: US3 (after US1 prerequisites)
