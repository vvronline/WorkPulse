# ADR-0001: User Status Model

- **Status:** Accepted
- **Date:** 2026-05-20
- **Owner:** WorkPulse — status service
- **Related code:** `server/services/status/`, `client/src/status/` (forthcoming)

## Context

The original `users.user_status` column conflated three orthogonal concepts:

1. **Presence** — does the user have an open WebSocket connection?
2. **Manual status** — what did the user pick in the status menu (available / busy / dnd / …)?
3. **Activity** — is the user in a call or meeting on _this_ device?

Five different code paths (`PUT /api/chat/status`, WS `status_change`, WS connect,
`logout`, `clock_out`) all wrote into the same column. This produced 14 reproducible
bugs, including:

- "Appear Offline" was reset to "Available" on every WS reconnect because
  the disconnect path persisted `'offline'` and the connect path silently flipped
  it back to `'available'`.
- A call on Device A flipped Device B to `in_call` (the column was shared).
- Idle "away" persisted across reloads and stuck users in `away` permanently.
- Three different whitelists (REST, WS, DB CHECK) accepted different values,
  silently rejecting some client requests.
- Custom status messages were wiped to `null` on every auto-status transition.

See `server/services/status/README.md` for the full catalogue.

## Decision

Separate the three concepts and compute the user-facing "effective status" with a
pure function. Concretely:

| Concept                | Storage                                                  | Writer            |
| ---------------------- | -------------------------------------------------------- | ----------------- |
| Manual status          | `users.manual_status` (nullable enum)                    | StatusService only |
| Presence preference    | `users.presence_preference` ∈ `{auto, invisible}`        | StatusService only |
| Open sessions          | `user_presence_sessions` (one row per WS connect)        | StatusService only |
| Per-session activity   | `user_presence_sessions.activity` ∈ `{null,in_call,in_meeting}` | StatusService only |
| Transition history     | `user_status_events` (audit)                             | StatusService only |
| Effective status       | derived by `resolver.resolveEffective` (pure)            | — (computed)      |

All five legacy writer paths funnel through a single service
(`server/services/status/`) with a fixed side-effect chain:

```
mutate → persist → audit → cache → broadcast (→ legacy dual-write)
```

The service is organized as **one file per responsibility** (`constants`,
`resolver`, `repository`, `cache`, `broadcaster`, `index`) so any future engineer
can navigate by intent rather than by knowledge of internals.

## Consequences

**Positive**

- "Why does Alice show as Away?" answerable by a single SQL query against
  `user_status_events`.
- Activity is per-device — a crashed tab can't leave the user stuck in `in_call`.
- "Appear Offline" survives reconnects.
- Custom status messages are no longer wiped on auto-status transitions.
- Adding a new activity type (`presenting`, `recording`, …) is a 4-line change.
- The resolver is pure — every behaviour is covered by table-driven tests
  with no database dependencies.

**Negative / costs**

- One additional table (`user_presence_sessions`) and one event log
  (`user_status_events`). Both indexed for the dominant query
  (`WHERE user_id = … AND disconnected_at IS NULL`).
- A migration window during which both legacy `users.user_status` and the new
  fields are written. Mitigated by clearly tagging dual-write paths and
  removing them in step 7.

## Rollout (8 reversible PRs)

| # | Title                                                                  | Status |
| - | ---------------------------------------------------------------------- | ------ |
| 1 | `status: add v2 schema + StatusService skeleton (no callers)`           | **Done** |
| 2 | `status: route WS connect/disconnect + logout + clock-out via StatusService` | **Done** |
| 3 | `status: route call/meeting activity via StatusService`                 | **Done** |
| 4 | `status: emit unified 'user_status' WS event + REST surface + legacy shims` | **Done** |
| 5 | `status: client StatusContext + useStatus hook + activity-ping`         | **Done** |
| 6 | `status: migrate consumers; delete UserStatusContext; new StatusPicker`  | **Done** |
| 7 | `status: stop writing legacy column; drop legacy WS events + REST shims` | **Done** |
| 8 | `status: drop legacy users.user_status & users.user_status_text columns` | **Done** |

Each PR is independently revertable. Steps 1–6 maintain full backwards
compatibility (both legacy and new code paths produce identical visible
behaviour). Step 7 is the cutover; step 8 is the cleanup.

## Alternatives considered

1. **Keep the single column, add validation layer.** Rejected — the bugs are
   structural (one writer per concept is impossible when the storage is shared)
   and would re-appear in any extension.
2. **Store everything in Redis only.** Rejected — losing presence/activity on
   Redis flushes is unacceptable; we need durable audit anyway.
3. **Compute effective state client-side.** Rejected — exactly what the legacy
   code did (the chat client patched the server response, the navbar didn't),
   producing inconsistent UIs in different parts of the app.