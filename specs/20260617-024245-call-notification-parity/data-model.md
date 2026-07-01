# Data Model - Native Incoming Call & Notification Parity

## Entity: DeviceToken

**Purpose**: Target device endpoint for push delivery.

**Fields**:
- `user_id` (number, required)
- `tenant_id` (number | null, required)
- `device_token` (string, required, unique per user/token)
- `platform` (`ios` | `android` | `web`, required)
- `last_seen_at` (timestamp, required)
- `created_at` (timestamp, required)

**Relationships**:
- Many `DeviceToken` records per `User`

**Validation Rules**:
- Reject empty/blank token
- Platform must be allowlisted
- Tenant scope must match authenticated user context

## Entity: IncomingCallInvite

**Purpose**: Normalized representation of incoming-call push payload and ring lifecycle.

**Fields**:
- `callId` (number, required)
- `conversationId` (number, required)
- `callerId` (number, required)
- `callerName` (string, required)
- `callerAvatar` (string | empty)
- `callType` (`voice` | `video`, required)
- `tenantId` (number | null, required)
- `expiresAt` (timestamp, required) — set to `createdAt + 30 seconds` (ring TTL per clarification 2026-07-01)
- `status` (`ringing` | `answered` | `rejected` | `missed` | `expired`)

**Relationships**:
- Maps to existing `call_logs.id`
- References conversation participants for authorization

**Validation Rules**:
- Only participants can transition invite state
- Expired invite cannot move to answered
- Deduplicate repeated push/action events by `callId + action + userId`
- Ring TTL is 30 seconds; on expiry the invite auto-transitions to `missed` and the native call UI is dismissed on ALL of the callee's devices
- **First-write-wins**: when multiple devices of the same callee answer, only the first `call_accept` to reach the server applies the `answered` transition; later ones are idempotent no-ops and their devices receive `call_handled_elsewhere`

## Entity: NativeCallActionEvent

**Purpose**: Captures OS UI actions and bridge outcome.

**Fields**:
- `eventId` (derived key, e.g. `callId:userId:action:sourceTimestamp`)
- `callId` (number, required)
- `userId` (number, required)
- `tenantId` (number | null, required)
- `action` (`answer` | `reject` | `end`, required)
- `source` (`callkit` | `connectionservice` | `notification-action`, required)
- `receivedAt` (timestamp, required)
- `applied` (boolean, required)
- `failureReason` (string | null)

**Relationships**:
- Belongs to one `IncomingCallInvite`

**Validation Rules**:
- Ignore duplicate `eventId`
- Require authenticated user + tenant context before applying

## Entity: NotificationBadgeState

**Purpose**: Effective unread count mirrored on launcher badge/dot.

**Fields**:
- `userId` (number, required)
- `tenantId` (number | null, required)
- `serverUnreadTotal` (number, required) — combined total: unread chat messages + unread in-app notifications (clarification 2026-07-01)
- `deviceBadgeCount` (number, required)
- `lastSyncedAt` (timestamp, required)

**Relationships**:
- Derived from per-conversation unread counts (`messages`, `message_reads`, Redis cache) PLUS unread `notifications` rows

**Validation Rules**:
- Never set negative counts
- Sync from authoritative server totals after read events and app foreground transitions
- Badge = unread messages + unread notifications; both sources reconcile to the same combined value the `TopBar` displays

## Entity: LockScreenVisibilityPreference

**Purpose**: Per-user control over whether sensitive push content (caller name, message preview) renders on the lock screen (FR-010, clarification 2026-07-01).

**Fields**:
- `userId` (number, required)
- `tenantId` (number | null, required)
- `hideSensitiveContent` (boolean, required, default `false`)

**Relationships**:
- One per `User`; stored with the user's existing notification preferences

**Validation Rules**:
- Default is `false` (content shown, WhatsApp/Teams-style)
- When `true`, server/client render generic content only ("Incoming call" / "New message") via Android channel `visibility=private/secret` and iOS content-preview suppression
- Preference is device-independent (applies to all of the user's devices)

## State Transitions

### Call Invite State
`ringing -> answered -> ended`  
`ringing -> rejected`  
`ringing -> missed/expired` (auto-fires when the 30s ring TTL elapses with no answer)

Invalid transitions (must be rejected/idempotent no-op):
- `answered -> ringing`
- `rejected -> answered`
- `expired -> answered`
- second `ringing -> answered` from a different device of the same callee (first-write-wins; the loser becomes a no-op + `call_handled_elsewhere`)

### Badge Sync State
`stale -> syncing -> synced`  
`synced -> stale` (on incoming message/read mismatch event)
