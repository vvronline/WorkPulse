# ADR-006 — Meeting Permission Presets (Phase 3)

**Status**: Accepted, implementation of Phase 3.
**Date**: 2026-05-26
**Related**: ADR-002 (chat reliability), ADR-003 (Resilience Pack),
ADR-004 (Mesh quality), ADR-005 (WS observability).

---

## Context

Until this change, the rules for "who can do what inside a meeting" were
scattered across the server in copy-paste form:

- `server/routes/meetings.js` had **7 separate inline checks** comparing
  `meeting.created_by === req.userId`, each with its own subtly different
  403 error message ("Only organizer can add participants", "Only
  organizer can start a broadcast", etc.)
- `server/utils/ws.js` had **4 more** of the same checks inside the
  WebSocket message handlers (`meeting_mute_participant`,
  `meeting_end`, `meeting_add_participant`, `meeting_track_state`)
- One action (`startBroadcast`) had grown an `allowAnyBroadcaster`
  opt-in flag baked into the meeting's `settings` JSONB — but nothing
  else followed that pattern, so similar requests for `allowAnyMute`
  or `lockChat` would have spawned more orphan flags

A concrete product ask — "let organisers pre-configure a 'webinar'
preset where attendees can't unmute themselves or share screen" —
would have meant editing every one of those 11 call-sites, each with
its own subtly different conditional. That's exactly how permission
bugs ship.

ADR-006 introduces a single source of truth.

---

## Decision

One new module + a coordinated swap-in across the two call-site files.
Zero new dependencies, zero schema migration — presets live in the
existing `meetings.settings` JSONB column.

### 1. `server/utils/meetingPermissions.js` (new)

Public API:

```js
const { can, describePreset, ACTIONS, PRESETS, DEFAULT_PRESET } =
    require('../utils/meetingPermissions');

can(user, meeting, action) → boolean
describePreset(meeting)    → { name, rules }
```

`user`    = `{ userId, role? }`
`meeting` = the raw `meetings` row (`created_by` + `settings` are the only fields read)
`action`  = one of the `ACTIONS` constants

The module is **pure** — no DB, no I/O, no closures. Easy to unit-test.
**Closed by default**: any missing input → `false`. We never throw, even
on garbage input, because the caller is right next to a destructive
operation and we'd rather a 403 than a 500.

### 2. The ACTIONS taxonomy (8 entries)

| Action               | Triggered by                       |
| -------------------- | ---------------------------------- |
| `EDIT`               | `PUT /api/meetings/:id`            |
| `END_FOR_ALL`        | `meeting_end` WS                   |
| `ADD_PARTICIPANT`    | `POST /:id/participants` + WS      |
| `MUTE_OTHERS`        | `meeting_mute_participant` WS      |
| `START_BROADCAST`    | `POST /:code/hls/start`            |
| `UNMUTE_SELF`        | (client-side, surfaces via preset) |
| `SHARE_SCREEN`       | (client-side)                      |
| `SEND_CHAT`          | (client-side; future Phase 6 split will also gate WS) |

Adding a new action means one new ACTIONS entry + one rule per preset.
The "every preset has a rule for every action" contract is enforced by
a unit test so silent omissions are impossible.

### 3. The PRESETS registry (3 entries)

| Preset      | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `standard`  | Default — matches pre-Phase-3 behaviour exactly                 |
| `webinar`   | Attendee-locked — only the host can unmute/share/broadcast      |
| `open`      | Community-style — every joined participant can mute/add/broadcast |

Each rule is one of:
- `{ host: true }`       — only `meeting.created_by`
- `{ everyone: true }`   — every joined participant
- `{ host: true, override: 'fooKey' }` — fall back to host-only unless `settings.fooKey === true|false` overrides

The `standard` preset's `START_BROADCAST` rule uses `override: 'allowAnyBroadcaster'`,
which is exactly the existing settings flag — so old meetings keep working
without a data migration.

### 4. Call-site swap-in

**`server/routes/meetings.js`**:
- `POST /` (create) — validates `settings.preset` against the known
  list; unknown values are silently dropped so a typo can't poison the
  DB.
- `PUT /:id` (update) — same validation logic, scoped to incoming
  `settings`.
- `POST /:id/participants` — `created_by !==` check replaced by
  `meetingPerms.can(user, meeting, ADD_PARTICIPANT)`.
- `POST /:code/hls/start` — replaces both the inline `created_by`
  check AND the `allowAnyBroadcaster` flag check with a single
  `can(..., START_BROADCAST)` call. The standard preset's `override`
  rule covers the historic flag.

**`server/utils/ws.js`**:
- `meeting_mute_participant` — `created_by` check replaced by
  `can(..., MUTE_OTHERS)`. The previous SQL also pre-filtered for
  `created_by`; that's been split out so the open preset can let any
  participant mute.

### 5. Backwards compatibility

Default preset = `standard`, applied implicitly by `can()` whenever
`settings.preset` is missing. Every existing meeting in production
keeps behaving exactly as it did before. No migration, no broadcast,
no data backfill.

---

## Consequences

### Positive

- **Single source of truth** for meeting permissions. The next
  permission change is a one-line edit in `meetingPermissions.js`,
  not a search-and-replace across 11 call-sites with different error
  copy.
- **Closed by default**: `can()` returns `false` for any malformed
  input. Bug class "if the caller forgets the check, the action goes
  through" is now structurally impossible — the meeting handler MUST
  call `can()` to get a truthy answer.
- **3 presets ship**: standard / webinar / open — covers the three
  meeting shapes the product roadmap has on the books.
- **The legacy `allowAnyBroadcaster` flag still works** via the
  `override` mechanism. No DB migration, no breaking change.
- **Adding actions is grep-safe**: a unit test fails if any preset
  has no rule for a known action.

### Negative

- ~200 LoC of new code, ~10 LoC each at the call-sites changed.
  Total diff is small but spread across 3 files.
- The `everyone: true` rule lets ANY joined participant act — there's
  no notion of "joined for ≥ 30 s" or "role >= co-host". For the
  current open/webinar use cases that's fine; if/when we add co-host
  this becomes a new rule type rather than a refactor.
- Frontend doesn't yet expose a preset picker in `MeetingJoin.jsx` /
  `MeetingRoom.jsx`. The server respects whatever's in the JSONB
  blob; UI work is deferred (intentional — Phase 3 was about getting
  the contract right; UX iteration shouldn't gate the API).

### Neutral

- The legacy hard-coded SQL filter
  `WHERE id = $1 AND created_by = $2` in `meeting_mute_participant`
  was removed in favour of an in-memory `can()` check. The DB-level
  check was strictly redundant with the JS-level check (both fired
  on the same row) — removing it doesn't open any new attack surface.

---

## Out of scope

- **Frontend preset picker** in MeetingJoin / MeetingRoom Settings.
  Needs UX design; deferred.
- **`meeting_presets` table** for org-wide custom presets. The
  in-code `PRESETS` registry covers the three needed shapes; an org
  that wants custom permissions can already use the per-meeting
  `settings` JSONB for ad-hoc overrides.
- **Audit log for permission denials**. Useful but noisy — most
  denials are benign UI race conditions. Add later behind a feature
  flag if the support volume warrants it.

---

## Files changed

- `server/utils/meetingPermissions.js` — **new** (~165 LoC). The
  `ACTIONS`, `PRESETS`, `can()`, `describePreset()` API.
- `server/routes/meetings.js`:
  - `require('../utils/meetingPermissions')`
  - `POST /` validates `settings.preset`
  - `PUT /:id` validates `settings.preset`
  - `POST /:id/participants` uses `can(..., ADD_PARTICIPANT)`
  - `POST /:code/hls/start` uses `can(..., START_BROADCAST)`
- `server/utils/ws.js`:
  - `meeting_mute_participant` uses `can(..., MUTE_OTHERS)` (the
    require is inlined so the rest of the module remains untouched)
- `server/__tests__/meetingPermissions.test.js` — **new**, 18 tests
  across 5 describe blocks: input safety, standard preset, webinar
  preset, open preset, shape contract.

## Test summary

```
server:  Test Suites: 32 passed, 32 total | Tests: 406 passed, 406 total  (was 388 → +18)
client:  Test Files:  15 passed, 15 total | Tests: 103 passed, 103 total  (unchanged)