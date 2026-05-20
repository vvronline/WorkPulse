# Status Service

> The **only** module allowed to read or write user-status fields.
> Every route, WebSocket handler, or background job that needs to mutate
> presence / manual status / activity MUST go through `StatusService`
> (exported from `./index.js`). Nothing else may run
> `UPDATE users SET user_status = …` or touch the Redis status keys.

---

## Why this exists

The original implementation stored three orthogonal concepts in a single
`users.user_status` column:

1. **Presence** — am I online (WS connected)?
2. **Manual status** — what did the user pick (available/busy/dnd/brb)?
3. **Activity** — am I in a call or meeting on _this device_?

That overload produced 14 documented bugs (see `docs/STATUS_MODEL.md`):
"Appear Offline" was lost on every reconnect, a call on Device A flipped
Device B to `in_call`, idle made the user permanently `away`, etc.

This service treats those three concepts as **separate** fields and
computes the "effective" status with a pure function.

---

## Module layout (one file = one responsibility)

| File              | Responsibility                                                            |
| ----------------- | ------------------------------------------------------------------------- |
| `constants.js`    | Enums, TTLs, idle thresholds. The single source of truth for valid values. |
| `resolver.js`     | **Pure** functions. No I/O. Easy to unit-test.                             |
| `repository.js`   | DB I/O only. Reads/writes `users` + `user_presence_sessions` + `user_status_events`.|
| `cache.js`        | Redis I/O only. Typed, prefixed keys.                                      |
| `broadcaster.js`  | WS broadcast of the unified `user_status` event.                           |
| `index.js`        | **`StatusService`** — public API that composes the four files above.       |
| `migration.js`    | Idempotent schema migration (called from `db.js`).                         |
| `__tests__/`      | Unit + integration tests next to source.                                   |

Lint/grep rule (manual for now): the strings `'user_status'`, `'user_status_text'`,
`UPDATE users SET user_status`, `setUserStatus`, `getUserStatus`,
`getUserStatuses` must appear **only** inside this folder (plus the
legacy dual-write paths during migration windows — clearly tagged with
`// LEGACY-DUAL-WRITE`).

---

## State model

```
┌───────────────────────────────┐  ┌───────────────────────────────┐  ┌───────────────────────────────┐
│  Presence (derived)           │  │  Manual status (preference)   │  │  Activity (per session)        │
│  online | offline             │  │  null|available|busy|dnd|brb  │  │  null|in_call|in_meeting       │
│  derived from open sessions   │  │  users.manual_status          │  │  user_presence_sessions.activity│
└──────────────┬────────────────┘  └──────────────┬────────────────┘  └──────────────┬────────────────┘
               │                                  │                                  │
               └─────────────────────┬────────────┴──────────────────────────────────┘
                                     ▼
                       ┌──────────────────────────────┐
                       │  Effective status (pure fn)  │
                       │  resolver.resolveEffective   │
                       └──────────────────────────────┘
```

### Precedence (resolver, in order)

1. If `presence_preference = 'invisible'` OR no open session → **`offline`** (presence=offline).
2. Else if any open session has `activity = 'in_call'` → **`in_call`**.
3. Else if any open session has `activity = 'in_meeting'` → **`in_meeting`**.
4. Else if `manual_status ∈ {dnd, busy, brb}` → that value.
5. Else if no input for `IDLE_AWAY_MS` → **`away`**.
6. Else → `manual_status || 'available'`.

The resolver is a pure function `(inputs) -> { effective, presence, source }`
making every transition predictable and grep-able.

---

## Public API (`StatusService`)

All methods are async and take a uniform context object:

```js
const ctx = { db, tenantId, actorUserId };
```

| Method                                                       | Purpose                                                |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `setManualStatus(ctx, { status, message, messageExpiresAt })` | User picked a manual status (or cleared it with null). |
| `setPresencePreference(ctx, 'auto' \| 'invisible')`           | "Appear Offline" toggle.                               |
| `openSession(ctx, { sessionKey, deviceLabel })`               | Called from WS connect.                                |
| `touchSession(ctx, sessionKey)`                               | Heartbeat / pong — refreshes activity timestamp.       |
| `closeSession(ctx, sessionKey)`                               | Called from WS disconnect.                             |
| `setSessionActivity(ctx, sessionKey, activity, refId?)`       | Call / meeting handler marks a session busy.           |
| `clearSessionActivity(ctx, sessionKey, activity?)`            | Call / meeting handler clears the activity.            |
| `getEffective(ctx, userId)`                                   | Resolve and return effective state for one user.       |
| `getEffectiveBulk(ctx, userIds)`                              | Same, for many.                                        |

Every mutator method:
1. Persists the change (via `repository`).
2. Updates the Redis cache (via `cache`).
3. Re-resolves the effective state.
4. Writes a `user_status_events` row.
5. Broadcasts a `user_status` WS event (via `broadcaster`).

A single call site, a single side-effect chain — no orphan code paths.

---

## How do I add a new activity type? (e.g. `presenting`)

1. Add `'presenting'` to `ACTIVITIES` in `constants.js`.
2. Add a precedence branch in `resolver.resolveEffective` (before `in_call`/`in_meeting` if it should win).
3. Add a row to the test table in `__tests__/resolver.spec.js`.
4. Call `statusService.setSessionActivity(ctx, sessionKey, 'presenting')` from the relevant handler.

Nothing else changes. The DB column is an open `TEXT` (validated against
`ACTIVITIES`) so no migration is needed.

---

## Debugging a "why am I showing X?" report

```sql
-- 1. Look at the user's open sessions + activity
-- NB: this is the presence-service table, distinct from the legacy
--     `user_sessions` table used by auth (max-2-devices enforcement).
SELECT id, session_key, device_label, connected_at, last_seen_at, activity
FROM user_presence_sessions
WHERE user_id = $1 AND disconnected_at IS NULL;

-- 2. Look at the user's prefs
SELECT manual_status, presence_preference, status_message, status_message_expires_at, last_activity_at
FROM users
WHERE id = $1;

-- 3. Recent transitions (with source)
SELECT to_state, source, session_key, created_at
FROM user_status_events
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 50;
```

The `source` column on every transition row makes "who set this?" answerable
in seconds: `'user'`, `'idle'`, `'call'`, `'meeting'`, `'session_open'`,
`'session_close'`, `'logout'`, `'clock_out'`, `'system'`.