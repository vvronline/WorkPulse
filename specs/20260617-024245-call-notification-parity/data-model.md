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
- `expiresAt` (timestamp, required)
- `status` (`ringing` | `answered` | `rejected` | `missed` | `expired`)

**Relationships**:
- Maps to existing `call_logs.id`
- References conversation participants for authorization

**Validation Rules**:
- Only participants can transition invite state
- Expired invite cannot move to answered
- Deduplicate repeated push/action events by `callId + action + userId`

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
- `serverUnreadTotal` (number, required)
- `deviceBadgeCount` (number, required)
- `lastSyncedAt` (timestamp, required)

**Relationships**:
- Derived from per-conversation unread counts (`messages`, `message_reads`, Redis cache)

**Validation Rules**:
- Never set negative counts
- Sync from authoritative server totals after read events and app foreground transitions

## State Transitions

### Call Invite State
`ringing -> answered -> ended`  
`ringing -> rejected`  
`ringing -> missed/expired`

Invalid transitions (must be rejected/idempotent no-op):
- `answered -> ringing`
- `rejected -> answered`
- `expired -> answered`

### Badge Sync State
`stale -> syncing -> synced`  
`synced -> stale` (on incoming message/read mismatch event)
