# Chat module

Owns messaging behavior (conversations, messages, reactions, pins, stars, etc.)
and its persistence boundary. This module is being migrated incrementally out
of `routes/chat.ts` (4,000+ lines / 51 routes); this README tracks progress.

## Current migrated slice

- `POST /api/chat/messages/:id/reactions`
- `POST /api/chat/messages/:id/pin`
- `GET /api/chat/conversations/:id/pinned`
- `POST /api/chat/messages/:id/star`
- `GET /api/chat/starred`
- `GET /api/chat/blocked`
- `POST /api/chat/users/:userId/block`
- `DELETE /api/chat/users/:userId/block`

The remaining chat endpoints (conversations, message CRUD, media jobs, polls,
calls, link previews, etc.) still live in `routes/chat.ts` and will
move incrementally. The public URL contract does not change: this router is
mounted inside the legacy chat router (`router.use("/", chatModuleRoutes)`).

## Layers

```text
chat.routes.ts -> chat.service.ts -> chat.repository.ts
```

- Routes own HTTP parsing/status codes and WebSocket fan-out (via
  `utils/ws.ts`) — kept at the route layer since it's a delivery
  side-effect, matching the reasoning that already applies to auditing.
- Service owns the business rules for this slice: message-not-found,
  deleted-message, and not-a-participant checks; add/remove toggling for
  reactions and stars; pin/unpin toggling; same-org validation and
  idempotent insert/delete for blocking.
- Repository owns all SQL in this module and never imports Express.
- Schema validates path params (`messageId`, `conversationId`, `userId`) and
  the request body (`emoji`) before service invocation.

## Tables read/written

- `messages`
- `message_reactions`
- `starred_messages`
- `blocked_users`
- `conversation_participants`
- `users` (display name lookups, org lookups)

## Cross-module dependencies

- WebSocket fan-out (`chat_reaction`, `chat_pin` events) is invoked from the
  route adapter via `utils/ws.ts`, same pattern as the attendance module.
- No dependency on other modules' repositories.
