# Status Module (client v2)

> The **only** place client code should look for "what is this user's
> presence/status?". Imports from `./useStatus` (single hook) read the
> server-resolved effective state directly — never combine fields yourself.

## Why this exists

Mirrors `server/services/status/` (see `server/services/status/README.md`).
The old `UserStatusContext` combined manual status + idle detection + auto
statuses on the **client**, then broadcast guesses over WebSocket. The
chat client and the navbar then implemented different overrides on top.
The result was inconsistent UI: "Available" in the navbar, "Offline" in
chat, "in_call" stuck on a refresh, etc.

In v2 the server is the only source of truth:

```
server resolver  ──►  WS 'user_status' event  ──►  StatusContext  ──►  useStatus()
                ◄──   REST /api/me/status*    ◄──  user actions    ◄──  StatusPicker
```

## File layout

| File              | Role                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| `constants.js`    | Single source of truth for client-visible enums + UI metadata (labels, colors).     |
| `StatusContext.jsx` | React context. Holds the server-resolved state for the current user **and** an `idMap` of effective payloads keyed by `userId` so the rest of the app can look up any teammate. |
| `useStatus.js`    | The single hook everyone imports. Thin wrapper around `useContext`.                 |
| `__tests__/`      | Behaviour locked in next to the source.                                             |

## Public API

```js
const {
  // The current user
  effective,            // 'available' | 'busy' | 'dnd' | 'brb' | 'away' | 'in_call' | 'in_meeting' | 'offline'
  presence,             // 'online' | 'offline'
  manualStatus,         // 'available' | 'busy' | 'dnd' | 'brb' | null
  presencePreference,   // 'auto' | 'invisible'
  statusMessage,        // string | null
  statusMessageExpiresAt,
  // Mutators
  setManualStatus(status, { message, messageExpiresAt } = {}),
  setInvisible(boolean),
  // Lookups for OTHER users (online-set + per-user payloads merged from
  // every `user_status` event we've seen since mount).
  getPeerStatus(userId), // returns the full payload, or null
  peers,                 // Record<userId, payload>
} = useStatus();
```

## Conventions

- **NO direct DB / API calls outside `StatusContext.jsx`.** Everything else
  uses `useStatus()`.
- **NO client-side combination** of `manualStatus + activity + idle`.
  That's the server's resolver job.
- **Idle is sent as an activity ping**, not as a status. The server
  decides if you're away.
- **Updates from the server are append-only into `peers`.** A peer who
  goes offline gets a `presence: 'offline'` payload, but the entry is
  never deleted — that way chat / org list components can render
  "last seen" without a separate fetch.