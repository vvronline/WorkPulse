# Implementation Plan: React Native (Expo) Mobile App on Shared WorkPulse Backend

## Goal
Add a React Native mobile app (`mobile/`) that consumes the **existing** WorkPulse backend (`server/`) alongside the React web app (`client/`), with no backend rewrite. Multi-tenancy, RBAC, tasks, chat, leaves, and tracker work over the same REST + WebSocket API.

## Chosen Stack (locked)
- **Expo SDK** + **EAS Build** + **development builds** (NOT Expo Go — incompatible with `react-native-webrtc`).
- **Auth:** `Authorization: Bearer <jwt>` + `expo-secure-store`.
- **Navigation:** `expo-router` (file-based).
- **Data:** `@tanstack/react-query` + `axios`.
- **Push (later):** `expo-notifications` (abstracts FCM + APNs).
- **OTA:** `expo-updates` (JS-only hotfixes without store review — suits the v1.6.x rapid cadence).

```
        ┌────────────┐
        │  Backend   │  server/ (Express 5 + WS + Postgres + Redis)
        └──────┬─────┘
        ┌──────┴──────┐
        ▼             ▼
┌──────────────┐ ┌──────────────┐
│ React Web    │ │ Expo RN App  │
│ client/      │ │ mobile/ (new)│
└──────────────┘ └──────────────┘
```

---

## Phase 1 — Backend: dual auth (cookie + Bearer), non-breaking

### Task 1.1 — Accept Bearer token in HTTP auth middleware
- File: `server/middleware/auth.ts` (~L44)
- Change: read token from cookie first, then fall back to `Authorization: Bearer`.
  ```ts
  const token =
    req.cookies.token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);
  ```
- Web path unchanged (cookie still wins). No other logic touched.

### Task 1.2 — Return JWT in login response body
- File: `server/routes/auth.ts` (login handler)
- Change: in addition to `res.cookie("token", ...)`, include `token` in the JSON body so mobile can persist it. Keep cookie for web.
- Apply the same to register (auto-login) and `/refresh` if it issues a token.

### Task 1.3 — Accept token on WebSocket upgrade
- File: `server/utils/ws.ts` (~L212)
- Change: token resolution order = cookie → `?token=` query param → `Sec-WebSocket-Protocol`.
  ```ts
  const url = new URL(req.url, "http://x");
  const token =
    cookie.parse(req.headers.cookie || "").token ||
    url.searchParams.get("token") ||
    (req.headers["sec-websocket-protocol"] as string | undefined);
  ```
- Keep all existing CSWSH / rate-limit checks intact.

### Task 1.4 — Confirm CORS allows no-origin requests
- File: `server/index.ts` (~L151–170)
- Verify the origin helper returns `true` when `!origin` (RN sends no Origin). Already present — just confirm; add a regression note.

### Task 1.5 — Verify tenant resolution works for Bearer clients
- Tenant comes from JWT `tenant_id` claim (no Host needed) per existing middleware — confirm a Bearer request with no custom domain resolves the tenant from the token.

**Phase 1 acceptance:**
- `curl -X POST /api/auth/login` (with `X-Requested-With` header) returns `token` in body.
- `curl /api/tracker/status -H "Authorization: Bearer <jwt>"` → 200.
- WS connects with `wss://host/ws?token=<jwt>` and receives `user_status`.
- Web app login + chat still pass (cookie path unchanged).

> **Verified locally (2026-06-09):** all four checks pass against the dev stack. Notes:
> - Login/mutating requests require a CSRF header `X-Requested-With: WorkPulse` — the mobile API client must send it on every request.
> - The WebSocket path is **`/ws`** (not `/`). Connect to `wss://<host>/ws?token=<jwt>`.
> - Tenant resolution middleware (`server/middleware/tenant.ts`) also had to read the Bearer token (not just the cookie) so tenant context resolves before auth — fixed in `resolveFromJwt`.

---

## Phase 2 — Mobile scaffold (`mobile/`)

### Task 2.1 — Init Expo app
```powershell
cd D:\Learnings\WorkPulse
npx create-expo-app@latest mobile --template default
cd mobile
npx expo install expo-router expo-secure-store axios @tanstack/react-query expo-constants react-native-reanimated react-native-safe-area-context
```
- Add `mobile/` to the monorepo. Set `app.json` name/slug = `workpulse`.

### Task 2.2 — Config & environment
- File: `mobile/app.config.ts` — expose `API_BASE_URL` and `WS_BASE_URL` via `expo-constants` `extra` (per-tenant default + override field on login screen).
- File: `mobile/src/config.ts` — read base URLs; support a tenant/domain field so multi-tenant custom domains can be entered or selected.

### Task 2.3 — Secure auth store
- File: `mobile/src/auth/tokenStore.ts` — `getToken/setToken/clearToken` via `expo-secure-store`.
- File: `mobile/src/auth/AuthContext.tsx` — mirror `client/src/AuthContext.tsx` API surface (`user`, `login`, `logout`, `loading`).

### Task 2.4 — API client (mirror web)
- File: `mobile/src/api.ts` — axios instance:
  - `baseURL` from config.
  - Request interceptor: inject `Authorization: Bearer <token>` + `x-timezone-offset` + `X-Requested-With: WorkPulse` (CSRF header required by backend).
  - Response interceptor: on 401 → clear token, route to login.
- Reuse response shape `{ data, error, total, page }` from existing backend.

### Task 2.5 — Shared types
- Import DTO types from `server/types` / `client/src/types` via a relative path or a small `mobile/src/types` re-export. No duplication of shapes.

### Task 2.6 — Navigation shell
- `expo-router` layout: auth stack (login) + app tabs (Dashboard, Tasks, Chat, Leaves, Profile). Gate on `AuthContext`.

**Phase 2 acceptance:** login on device/simulator stores token; authenticated tab loads real data from backend.

---

## Phase 3 — Core features (REST, parallelizable after Phase 2)

| Task | Screen | Endpoints |
|------|--------|-----------|
| 3.1 | Tracker (clock in/out, breaks) | `GET /api/tracker/status`, `POST /start`, `POST /end`, `PUT /break-start`, `PUT /break-end` |
| 3.2 | Tasks list + detail | `GET /api/tasks`, task detail/comments endpoints |
| 3.3 | Leaves (request, balance, history) | `POST /api/leaves/request`, `GET /balance`, `GET /history` |
| 3.4 | Profile + avatar upload | `GET/PUT /api/profile`, `POST /avatar` (use `expo-image-picker`) |
| 3.5 | Notifications | `GET /api/notifications`, `PUT /:id/read` |

- Use React Query for caching, pull-to-refresh, optimistic updates.

---

## Phase 4 — Realtime (WebSocket: chat + presence)

### Task 4.1 — WS client
- File: `mobile/src/realtime/socket.ts` — connect `wss://<host>/ws?token=<jwt>`, exponential-backoff reconnect, ping/pong matching server's 25s heartbeat, app-state aware (reconnect on foreground).

### Task 4.2 — Chat
- Conversations list + message thread; send via WS `chat_message`, typing `chat_typing`, read `chat_read`. File attach via `POST /api/chat/conversations/:id/files`.

### Task 4.3 — Presence
- Subscribe to `user_status` broadcasts; show online/away states.

---

## Phase 5 — Native builds (EAS)

### Task 5.1 — Dev build
```powershell
npm install -g eas-cli
cd mobile; eas login; eas build:configure
eas build --profile development --platform android   # + ios
```
- Install dev build on device; enables native modules + fast refresh.

### Task 5.2 — `expo-updates` (OTA) wired for JS hotfixes.

---

## Phase 6 — Push notifications (optional, later)

### Task 6.1 — Backend
- Migration: `device_tokens (user_id, token, platform, created_at)`.
- Route: `POST /api/profile/device-token` to register Expo push token.
- File: `server/jobs.ts` — dispatch Expo push on events (task assigned, leave approved, `call_incoming`).

### Task 6.2 — Mobile
- `expo-notifications`: request permission, register token on login, handle foreground + tap-to-route.

---

## Phase 7 — WebRTC calls/meetings (optional, last)

### Task 7.1 — Add native WebRTC
- `npx expo install react-native-webrtc` + config plugin → rebuild dev build.
- Reuse existing coturn TURN infra + `call_signal` / `meeting_signal` WS events (no backend change).
- Port signaling logic from `client` CallOverlay/Meeting to RN peer connections.

---

## Cross-cutting concerns
- **Multi-tenancy:** tenant always derived from JWT claim → works without custom-domain Host header. Allow a tenant/domain entry on login for custom-domain orgs.
- **Token expiry:** 8h, no rotation. Implement `/api/auth/refresh` for mobile OR force re-login on 401.
- **Timezones:** send `x-timezone-offset` header from device (matches web contract).
- **No web regression:** every backend change is additive (cookie path preserved).

## Verification (end-to-end)
1. Backend dual-auth: Bearer REST + WS token param pass; web cookie flow unchanged.
2. Mobile: login → tracker clock-in → create task → request leave → send chat message → receive presence update.
3. EAS dev build installs and runs on a physical device.
4. (If done) push received on background; (if done) 1:1 call connects via TURN.

## Open decisions to confirm before coding
1. Mobile MVP scope: **REST-only first** (tracker/tasks/leaves/chat) vs include calls now? (Recommend REST-first.)
2. Push notifications in v1 or deferred? (Recommend deferred to Phase 6.)
3. Custom-domain handling on login: dropdown of known orgs vs free-text domain entry?
