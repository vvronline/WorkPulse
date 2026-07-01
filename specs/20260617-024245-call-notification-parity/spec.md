# Feature Specification: Native Incoming Call & Notification Parity

**Feature Branch**: `20260617-024245-call-notification-parity`

**Created**: 2026-06-17

**Status**: Draft

**Input**: User description: "Show incoming call UI and answer without opening app (WhatsApp/Teams/Slack style), ensure message notifications appear in status bar, and keep app icon badge/dot accurate."

## Clarifications

### Session 2026-07-01

- Q: What is the incoming-call ring TTL before the invite auto-expires (missed)? → A: 30 seconds, then auto-mark missed + dismiss native UI (Teams-style).
- Q: If two of the callee's devices tap Answer simultaneously, which wins? → A: First device whose call_accept reaches the server wins; others get `call_handled_elsewhere` and dismiss (first-write-wins).
- Q: Should sensitive push content (caller name, message preview) show on the lock screen? → A: Show by default (WhatsApp/Teams-style); expose a per-user "hide sensitive content on lock screen" toggle.
- Q: Does the launcher badge count chat messages only or messages + in-app notifications? → A: Combined — unread chat messages + unread in-app notifications (matches existing TopBar behavior).
- Q: What are the "supported devices" for the success criteria? → A: Android 13+ and iOS 16+ (matches the implementation plan's target platform).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Answer incoming call from system UI (Priority: P1)

As a mobile user, I can see an incoming call screen when the app is backgrounded or terminated, and answer/reject directly from system UI.

**Why this priority**: Incoming call handling is core communication behavior and currently fails in key states.

**Independent Test**: Terminate app, trigger an incoming call, verify system call UI appears and answer action joins active call.

**Acceptance Scenarios**:

1. **Given** app process is terminated, **When** a call invite is sent, **Then** native incoming-call UI is displayed within 2 seconds.
2. **Given** native incoming-call UI is visible, **When** user taps Answer, **Then** app opens call session and media negotiation begins without manual app launch.
3. **Given** native incoming-call UI is visible, **When** user taps Decline, **Then** caller receives reject state and ringing stops on all devices.

---

### User Story 2 - Receive message notifications with launcher badge (Priority: P1)

As a mobile user, I receive message notifications in system status bar and see launcher dot/badge updates while app is foreground, background, or terminated.

**Why this priority**: Messaging reliability and unread visibility are baseline expectations.

**Independent Test**: Send messages to target user in all app states and verify status-bar notification plus badge increment/decrement behavior.

**Acceptance Scenarios**:

1. **Given** app is backgrounded, **When** message arrives, **Then** OS notification is shown in status bar.
2. **Given** unread messages exist, **When** user reads conversation, **Then** launcher badge count decreases without app restart.
3. **Given** user has disabled notification permission, **When** app opens permission prompt flow, **Then** (a) if user grants: system notification delivery enabled; (b) if user denies: one-time retry prompt shown on next app open, then settings deep-link offered; (c) state persists across app restarts (no repeated prompts within 24 hours); (d) in all cases, existing messages/calls remain functional (graceful fallback, no crashes).

---

### User Story 3 - Preserve reliable call signaling across reconnects (Priority: P2)

As a caller/callee, call signaling and state remain consistent even during websocket reconnects or device offline windows.

**Why this priority**: Existing delays/failures are tied to reconnect timing and call accept races.

**Independent Test**: Simulate transient network drops during ring/accept and verify idempotent state transitions with no duplicate/ghost call states.

**Acceptance Scenarios**:

1. **Given** callee taps Answer while socket is reconnecting, **When** retry window elapses, **Then** call_accept is delivered once and call transitions to connecting.
2. **Given** same push event is delivered multiple times, **When** handlers process it, **Then** single effective call session exists.
3. **Given** two of the callee's devices tap Answer simultaneously, **When** both call_accept frames reach the server, **Then** the first-arriving one applies the answer transition and the other device receives `call_handled_elsewhere` and dismisses its UI (first-write-wins).

---

### Edge Cases

- Call invite expires (caller ended call) before user answers from native UI.
- Ring TTL (30s) elapses with no answer → invite auto-marked missed and native call UI dismissed on all of the callee's devices.
- Duplicate push delivery and out-of-order push vs websocket events.
- Device with OEM battery optimization delays background handlers.
- User logged out or token expired when tapping Answer from native call UI.
- Multiple logged-in devices for same user receive same incoming call.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST present native incoming-call UI on Android/iOS when a call push is received while app is backgrounded or terminated.
- **FR-002**: Users MUST be able to answer or reject from native call UI without manually opening the app first.
- **FR-003**: System MUST bridge native answer/reject actions to existing server signaling (`call_accept`, `call_reject`, `call_end`) with idempotent retries.
- **FR-004**: System MUST display message notifications in OS status bar in foreground/background/terminated states (subject to user permissions and OS policy).
- **FR-005**: System MUST keep launcher/app-icon badge or notification dot synchronized with the authoritative combined unread count (unread chat messages + unread in-app notifications).
- **FR-006**: System MUST provide notification/call permissions onboarding and settings deep-link flows when required OS permissions are missing.
- **FR-007**: System MUST keep tenant/user isolation for all push-token registration, call signaling, and unread synchronization.
- **FR-008**: System MUST emit structured logs for push delivery attempts, incoming-call UI display, answer/reject actions, and failures with tenant/user/call context.
- **FR-009**: System MUST include integration and unit tests for call push handling, message notification routing, and unread badge synchronization.
- **FR-010**: System MUST show caller name and message preview on the lock screen by default, and MUST provide a per-user "hide sensitive content on lock screen" preference that, when enabled, renders generic content only ("Incoming call" / "New message") via the appropriate OS notification visibility settings (Android channel `visibility`, iOS notification content preview).

### Key Entities *(include if feature involves data)*

- **DeviceToken**: Per-user push destination with platform, tenant scope, last_seen, and validity state.
- **IncomingCallInvite**: Call invitation payload keyed by callId, conversationId, caller identity, tenant, TTL (30 seconds ring window — after which the invite auto-expires as missed and the native call UI is dismissed on all devices), and current lifecycle status.
- **NotificationBadgeState**: Derived combined unread count on device (unread chat messages + unread in-app notifications), synchronized with the server's authoritative unread totals.
- **NativeCallActionEvent**: Captured action from system call UI (answer/decline/end) with timestamps and delivery outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In test runs, >= 95% of valid incoming call pushes surface native incoming-call UI within 2 seconds on supported devices (Android 13+ and iOS 16+).
- **SC-002**: >= 95% of answer actions from native UI transition to call `connecting` within 3 seconds.
- **SC-003**: >= 99% of message pushes generate visible status-bar notifications when permission is granted.
- **SC-004**: Badge count divergence between the server authoritative combined unread total (messages + in-app notifications) and device launcher badge is <= 1 count for <= 5 seconds after read events. Steady-state: badge count MUST match the server authoritative combined unread total within 10 seconds of final read event; zero divergence is target.

## Assumptions

- Existing websocket signaling remains the canonical call negotiation channel; push is wake-up + entry path.
- Expo managed defaults are insufficient for full call parity; custom native build path is acceptable.
- Existing `call_logs`, `messages`, `message_reads`, and `device_tokens` tables are reused with additive changes only.
- Push providers (FCM/APNs) are already configured in production and can be extended with native-call-specific payload fields.
- "Supported devices" for all success criteria means Android 13+ and iOS 16+; older OS versions receive best-effort behavior without the parity guarantees.
