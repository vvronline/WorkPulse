# Contract: Push Payloads for Call/Message Notifications

## Scope

Defines server -> mobile push payload contract used by FCM/APNs for incoming calls, chat messages, and general notifications.

## Incoming Call Payload (data fields)

```json
{
  "type": "incoming_call",
  "callId": "12345",
  "conversationId": "987",
  "callerId": "456",
  "callerName": "Alice Johnson",
  "callerAvatar": "/uploads/avatar-456.png",
  "callType": "voice",
  "tenantId": "12",
  "expiresAt": "2026-06-17T02:45:00.000Z",
  "dedupeKey": "call:12345"
}
```

### Delivery requirements
- High priority delivery
- Collapse key: `call-{callId}`
- TTL: 30 seconds (ring window; matches `IncomingCallInvite.expiresAt = createdAt + 30s`)
- Channel/category:
  - Android channel: `default` (guaranteed), optional specialized runtime channel
  - iOS category: `incoming-call`
- Lock-screen visibility: honors the target user's `hideSensitiveContent` preference (FR-010) — when enabled the payload omits `callerName`/`callerAvatar` from any OS-rendered content and the client posts a generic "Incoming call"

## Message Payload (data fields)

```json
{
  "type": "chat_message",
  "conversationId": "987",
  "messageId": "76543",
  "senderId": "456",
  "senderName": "Alice Johnson",
  "tenantId": "12",
  "dedupeKey": "msg:76543"
}
```

### Delivery requirements
- High priority delivery
- Collapse key: `msg-{messageId}`
- Badge hint may be set, but server unread API remains authoritative (badge = combined unread messages + notifications)
- Lock-screen visibility: honors the target user's `hideSensitiveContent` preference (FR-010) — when enabled the client renders a generic "New message" without sender name/preview

## Validation Rules

- Numeric IDs must parse as positive integers.
- `callType` must be `voice` or `video`.
- `tenantId` must match authenticated tenant context for target user.
- Unknown payload types are ignored with structured warning log.
