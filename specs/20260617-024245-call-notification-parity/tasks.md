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

- [X] T001 Add native call and messaging dependencies in `mobile/package.json` and lock updates in `mobile/package-lock.json`
- [X] T002 Add Expo plugin and permissions config for call/notification parity in `mobile/app.config.ts`
- [X] T003 [P] Add mobile environment variable placeholders for push/call setup in `mobile/.env.example`
- [X] T004 [P] Add server environment variable placeholders for APNs/FCM call payload controls in `server/.env.example`
- [X] T005 Document custom-build prerequisites for call parity in `mobile/RELEASE.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement shared infrastructure required by all user stories.

**⚠️ CRITICAL**: No user story work starts before this phase is complete.

- [X] T006 Implement native call bridge service skeleton in `mobile/src/services/nativeCallService.ts`
- [X] T007 Implement background push handler entrypoint in `mobile/src/services/backgroundPushService.ts`
- [X] T008 [P] Wire app bootstrap to initialize native call + push background services in `mobile/app/_layout.tsx`
- [X] T009 [P] Extend mobile push notification service contract helpers for typed call/message payload normalization in `mobile/src/services/pushNotificationService.ts`
- [X] T010 Add server-side payload builder helpers (call/message/common metadata) in `server/services/pushNotifications.ts`
- [X] T011 Add idempotency helper for native call action events in `server/utils/wsIdempotency.ts`
- [X] T012 Add structured logging schema for push/call lifecycle events in `server/utils/logger.ts`

**Checkpoint**: Foundation complete; user stories can proceed.

---

## Phase 3: User Story 1 - Answer incoming call from system UI (Priority: P1) 🎯 MVP

**Goal**: Show native incoming-call UI while app is backgrounded/terminated and allow answer/reject from OS UI.

**Independent Test**: Terminate app, send incoming call push, verify native call UI appears, answer joins call, reject signals caller and stops ringing.

### Tests for User Story 1

- [X] T013 [P] [US1] Add server integration tests for incoming call push payload contract in `server/__tests__/pushNotifications.callPayload.test.ts`
- [X] T014 [P] [US1] Add server integration tests for call action idempotency (`answer`/`reject`) in `server/__tests__/ws.callActionIdempotency.test.ts`
- [X] T015 [P] [US1] Add mobile service unit tests for native call action mapping in `mobile/src/services/__tests__/nativeCallService.test.ts`

### Implementation for User Story 1

- [X] T016 [US1] Implement incoming call push -> native UI display flow in `mobile/src/services/backgroundPushService.ts`
- [X] T017 [US1] Implement native answer/reject callbacks and deep-link bridge in `mobile/src/services/nativeCallService.ts`
- [X] T018 [US1] Update call screen to accept native-entry params and auto-connect flow in `mobile/app/call/[conversationId].tsx`
- [X] T019 [US1] Add call action retry-on-reconnect helper usage in `mobile/src/realtime/socket.ts`
- [X] T020 [US1] Extend websocket handler for deduped native call actions in `server/utils/ws.ts`
- [X] T021 [US1] Extend call push payload fields (`expiresAt`, `dedupeKey`, caller metadata) in `server/services/pushNotifications.ts`
- [X] T022 [US1] Add call push observability logs with tenant/user/call context in `server/services/pushNotifications.ts`
- [X] T023 [US1] Add native call onboarding and permission prompt flow in `mobile/src/realtime/PushNotificationInitializer.tsx`

**Checkpoint**: US1 is fully functional and independently testable.

---

## Phase 4: User Story 2 - Receive message notifications with launcher badge (Priority: P1)

**Goal**: Ensure status-bar notifications and launcher badge/dot remain accurate in all app states.

**Independent Test**: Send messages with app foreground/background/terminated, verify status-bar visibility and badge increments/decrements without app restart.

### Tests for User Story 2

- [X] T024 [P] [US2] Add server integration tests for message push payload/channel behavior in `server/__tests__/pushNotifications.messagePayload.test.ts`
- [X] T025 [P] [US2] Add mobile unit tests for unread badge synchronization logic in `mobile/src/realtime/__tests__/chatUnreadEvents.test.ts`
- [X] T026 [P] [US2] Add mobile integration tests for notification response routing and badge updates in `mobile/src/realtime/__tests__/PushNotificationListener.test.tsx`

### Implementation for User Story 2

- [X] T027 [US2] Implement reliable status-bar notification channel/category handling in `mobile/src/services/pushNotificationService.ts`
- [X] T028 [US2] Implement unread authoritative-sync trigger pipeline in `mobile/src/realtime/chatUnreadEvents.ts`
- [X] T029 [US2] Integrate unread sync and launcher badge reconciliation in `mobile/app/(tabs)/_layout.tsx`
- [X] T030 [US2] Emit unread refresh events after read/write chat mutations in `mobile/src/components/chat/useChatThread.ts`
- [X] T031 [US2] Normalize message push payload delivery parameters and logging in `server/services/pushNotifications.ts`
- [X] T032 [US2] Add permissions recovery UX (settings deep-link and state checks) in `mobile/src/realtime/PushNotificationListener.tsx`

**Checkpoint**: US2 is fully functional and independently testable.

---

## Phase 5: User Story 3 - Preserve reliable call signaling across reconnects (Priority: P2)

**Goal**: Prevent duplicate/ghost call states and improve reliability under reconnect and duplicate push conditions.

**Independent Test**: Simulate reconnect and duplicate deliveries; verify only one effective call state transition and stable connect behavior.

### Tests for User Story 3

- [ ] T033 [P] [US3] Add websocket integration tests for reconnect-time call_accept retry behavior in `server/__tests__/ws.callAcceptReconnect.test.ts`
- [ ] T034 [P] [US3] Add websocket integration tests for duplicate invite/action de-duplication in `server/__tests__/ws.callDuplicateInvite.test.ts`
- [ ] T035 [P] [US3] Add mobile unit tests for retry/backoff send helper in `mobile/app/call/__tests__/callRetryFlow.test.ts`

### Implementation for User Story 3

- [ ] T036 [US3] Implement bounded retry/backoff utility for call signaling sends in `mobile/src/realtime/socket.ts`
- [ ] T037 [US3] Apply reconnect-safe call action send helper in `mobile/app/call/[conversationId].tsx`
- [ ] T038 [US3] Enforce server-side dedupe and terminal-state guards for call actions in `server/utils/ws.ts`
- [ ] T039 [US3] Add structured reliability diagnostics for call transition failures in `server/utils/wsMetrics.ts`

**Checkpoint**: US3 is fully functional and independently testable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finish documentation, validation, and cross-story hardening.

- [ ] T040 [P] Update quickstart verification steps with final command and device matrix in `specs/20260617-024245-call-notification-parity/quickstart.md`
- [ ] T041 Run and document end-to-end validation notes for all stories in `specs/20260617-024245-call-notification-parity/research.md`
- [ ] T042 [P] Add/refresh release checklist for native build requirements in `mobile/RELEASE.md`
- [ ] T043 Final structured log field audit for call/message notification lifecycle in `server/services/pushNotifications.ts`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies.
- **Phase 2 (Foundational)**: Depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: Depends on Phase 2.
- **Phase 4 (US2)**: Depends on Phase 2; can run in parallel with US1 after foundational completion.
- **Phase 5 (US3)**: Depends on Phase 2 and should start after US1 signaling changes (T020-T021) land.
- **Phase 6 (Polish)**: Depends on completion of target user stories.

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
