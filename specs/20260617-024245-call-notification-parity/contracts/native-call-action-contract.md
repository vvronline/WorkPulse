# Contract: Native Call Action Bridge

## Scope

Defines mobile-native action callbacks -> app signaling bridge contract for Answer/Reject/End from OS call UI.

## Inbound Native Action Event

```json
{
  "eventId": "12345:789:answer:1718572100",
  "callId": 12345,
  "conversationId": 987,
  "action": "answer",
  "userId": 789,
  "tenantId": 12,
  "source": "connectionservice",
  "receivedAt": "2026-06-17T02:45:05.123Z"
}
```

## Action Mapping

| Native Action | App Bridge Action | WS/API Target |
|---------------|-------------------|---------------|
| `answer` | accept invite | `socket.send("call_accept", { callId, conversationId })` |
| `reject` | reject invite | `socket.send("call_reject", { callId, conversationId })` |
| `end` | terminate active call | `socket.send("call_end", { callId, conversationId })` |

## Idempotency and Ordering

- Deduplicate by `eventId` and fallback key `callId + userId + action`.
- If websocket unavailable, retry within bounded window (e.g. 4-5s) with backoff.
- If invite already terminal (`rejected`, `missed`, `expired`, `ended`), treat action as no-op and log reason.

## Error Contract

```json
{
  "eventId": "12345:789:answer:1718572100",
  "applied": false,
  "reason": "invite-expired"
}
```

## Observability Fields (required in logs)

- `tenantId`
- `userId`
- `callId`
- `conversationId`
- `action`
- `source`
- `applied`
- `failureReason` (if any)
