# Chat module

Owns all **51** public `/api/chat` endpoints. As of 2026-09-02, no HTTP
endpoint registration remains in `server/routes/chat.ts`; that 11-line file
only composes the tenant/feature middleware and mounts the module's route
adapters.

## Migrated endpoints

- `POST /messages/:id/reactions`
- `POST /messages/:id/pin`
- `GET /conversations/:id/pinned`
- `POST /messages/:id/star`
- `GET /starred`
- `GET /blocked`
- `POST /users/:userId/block`
- `DELETE /users/:userId/block`
- `POST /conversations`
- `POST /conversations/group`
- `GET /conversations/:id/members`
- `POST /conversations/:id/pin`
- `POST /conversations/:id/favourite`
- `POST /conversations/:id/mute`
- `POST /conversations/:id/archive`
- `GET /ice-config`
- `GET /search`
- `GET /presence`
- `PUT /conversations/:id/group`
- `POST /conversations/:id/leave`
- `PUT /conversations/:id/participants/:userId/role`
- `POST /conversations/:id/transfer-owner`
- `GET /conversations`
- `GET /conversations/:id/messages`
- `POST /conversations/:id/read`
- `GET /conversations/:id/read-status`
- `POST /conversations/:id/messages`
- `POST /conversations/:id/files`
- `POST /media-jobs/:id/cancel`
- `POST /media-jobs/:id/retry`
- `PUT /messages/:id`
- `DELETE /messages/:id`
- `GET /search-messages`
- `POST /messages/:id/forward`
- `POST /conversations/:id/polls`
- `POST /polls/:id/vote`
- `GET /polls/:id`
- `GET /conversations/:id/files`
- `POST /conversations/:id/unread`
- `DELETE /conversations/:id/messages`
- `DELETE /conversations/:id`
- `POST /messages/:id/delivered`
- `POST /messages/:id/view`
- `GET /calls`
- `POST /calls/delete`
- `GET /calls/active`
- `GET /conversations/:id/calls`
- `POST /calls/:callId/reject`
- `POST /calls/:callId/accept`
- `POST /calls/:callId/end`
- `GET /link-preview`

## Layers and boundaries

```text
chat.routes.ts -> chat.*.routes.ts -> chat.service.ts -> chat.repository.ts
```

- The composition router retains `requireTenant` and `requireFeature("chat")`;
  every module endpoint retains `auth` and any original middleware.
- Route adapters retain HTTP parsing, status/response mapping, and delivery
  side effects: WebSocket fan-out, Redis unread updates, media jobs, storage,
  push cancellation, and status updates.
- The service applies chat workflows and is the only route-to-database path.
- `chat.repository.ts` owns every SQL statement and does not import Express.
- `chat.schema.ts` contains the shared parameter/body validation used by the
  extracted conversation and message actions; endpoint-specific validation
  remains unchanged at the HTTP boundary.

## Validation

- `modules/chat/__tests__/chat.module-composition.test.ts` pins all 51 method
  and path pairs and asserts that the legacy composition router registers none.
- `modules/chat/__tests__/chat.service.test.ts` covers existing service rules
  plus repository delegation for paginated and scoped searches.
- Run `npm test -- __tests__/chat.routes.test.ts modules/chat/__tests__/chat.service.test.ts modules/chat/__tests__/chat.module-composition.test.ts`,
  `npm run typecheck`, `npm run lint:deps`, and root
  `npm run check:guardrails`.
