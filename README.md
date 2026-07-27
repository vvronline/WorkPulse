# AINO

A multi-tenant, enterprise-grade workforce platform that combines **time tracking, agile project management, leave & approval workflows, real-time chat & video calls, calendar, and a hierarchical notes wiki** into one application — with a desktop client (Electron), responsive web UI, and managed Postgres deployment on Railway.

> AINO is what you get when you stop juggling Jira + Slack + Zoom + Google Calendar + Notion + Workday + a punch-clock spreadsheet. One login, one source of truth, one app for the whole team.

---

## 🧭 Table of contents

- [Feature highlights](#-feature-highlights)
- [Architecture overview](#-architecture-overview)
- [Tech stack](#-tech-stack)
- [Roles & permissions model](#-roles--permissions-model)
- [Multi-tenancy](#-multi-tenancy)
- [Local development (Docker)](#-local-development-docker)
- [Production deployment (Railway)](#-production-deployment-railway)
- [Desktop app (Electron)](#-desktop-app-electron)
- [API documentation](#-api-documentation)
- [Project structure](#-project-structure)

---

## ✨ Feature highlights

### ⏱️ Attendance & Time Tracking
- **Clock in / out** with work-mode selection (Office / Remote / Hybrid).
- **Break tracking** — every break shaves the floor-hours total so the daily total reflects real working time, not desk time.
- **Live timer & 8-hour progress** on the dashboard so people can self-pace.
- **Manual entry** for missed days, with manager approval workflow + audit trail.
- **Overtime requests** routed to managers; auto-rolls into payroll exports.
- **Daily auto-carry-forward** of incomplete tasks from the previous working day.
- **Weekly / monthly / quarterly analytics** — punctuality %, average floor time, attendance heat map, productivity trend.
- **Holiday calendar** maintained per org, included in attendance calculations.

### 🗂️ Agile Project Management (Tasks, Sprints, Insights)
**Tasks**
- **Kanban board** with **drag-and-drop**, optimistic updates, and column-by-column WIP limits.
- **Backlog** view with filter, sort, bulk-import to active sprint, story-point planning poker style.
- **Service Desk** tab — bug reports / feature requests / access issues that mirror into a triageable backlog for org admins.
- Rich-text descriptions, **acceptance criteria checklists**, attachments, threaded comments with **@mentions** (notification + email), labels (org-wide), priority, due dates, assignment.
- **Dependencies** (`blocks` / `relates` / `duplicates` / `clones`) and **parent-child links** for Epic → Story rollups.
- **Blocker badges** with reason text — surface roadblocks on the card without changing status.
- **Activity log** per task — every status change, edit, mention, dependency, etc. is timestamped and attributable.
- **Global cross-task search** (titles + descriptions, scoped to your visibility).

**Sprints**
- Per-team sprint cadence configured in admin (start date + duration in weeks). Current + next sprint **auto-materialise** so admins never have to pre-create them.
- **Lifecycle**: `planned → active → completed`. "Start sprint" auto-completes any other active sprint on the team, captures a baseline burndown snapshot.
- **Complete sprint** with **rollover** — incomplete tickets either go to the backlog or directly to the next sprint. Velocity is captured as completed story points.
- **Sprint stats** rollup — by workflow state, by work item type, by assignee — surfaced inline on the board header.

**Agile Configuration (per-tenant)**
- **Estimation scale**: Fibonacci, Linear (1–10), T-shirt (XS–XXL), Hours, None, or fully custom — with custom unit label (`SP`, `pts`, `hrs`, …).
- **Work Item Types**: ship with Story / Bug / Task / Epic; tenants can add (Spike, Tech Debt, Discovery, …) with custom colours, icons, default status.
- **Workflow States**: ship with To Do / In Progress / In Review / Done across 4 categories (open / in_progress / in_review / done). Tenants add states (Triage, QA, Blocked, …) with category, colour, **WIP limit**, initial / terminal flags.
- **Feature flags**: turn off any of Story Points, Epics, Dependencies, Acceptance Criteria, Blockers, WIP Limits, Retrospectives, Require-Estimate-For-Sprint per tenant.
- **Definition of Done** template stored at org level, prepended to new tickets.
- **Role-based edit access** — only `super_admin / platform_admin / hr_admin / manager / team_lead / scrum_master` can change agile config; everyone else sees a read-only view.

**Sprint Insights** (`/sprint-insights`)
A dedicated reporting view so the day-to-day Sprint board stays focused on planning:
- **Burndown chart** — actual remaining points vs ideal line, daily snapshots.
- **Velocity chart** — last 6 completed sprints.
- **Cumulative Flow Diagram** — stacked area showing how tickets flow through workflow categories over the sprint.
- **Cycle & Lead Time** — per-ticket cycle time (work-start → done) and lead time (created → done) with avg / median / p90 stats.
- **Retrospective editor** — Went well / To improve / Action items (checklist with owner + due date) / Team mood (1–5 emoji vote) / Summary.

### 🏖️ Leave Management
- **Leave policy editor** per org / per role — accruals, carry-forward caps, blackout dates, requires-approval flag.
- **Apply for leave** with category (Sick / Annual / Personal / Compensatory / Bereavement / Maternity / Paternity / Custom).
- **Approval queue** for managers (inline approve / reject with reason; bulk-approve).
- **Leave balance** auto-computed from policy + accruals, surfaced on the leave-apply form.
- **Withdraw leave** (employee) and **revoke** (manager) flows with notifications.
- **Per-user holiday calendar** integration.

### 💬 Real-time Chat
- 1:1 and group conversations with **persistent history**, presence indicators, typing indicators, **read receipts**, **edit / delete / forward** of messages.
- **Reactions**, **threading** via inline replies, **pinned messages**, **starred messages** (personal bookmarks).
- **File sharing** with previews; **shared-files** drawer per conversation for quick re-find.
- **Polls** (single or multi-vote) inline in conversations.
- **@mentions** trigger desktop notifications, email, and a notification-centre entry.
- **Search** across conversations + messages + files.
- **Pin / favourite** conversations to the top of the list.

### 📞 Audio / Video Calls
- **WebRTC** 1:1 and small-group calls bootstrapped from any chat.
- **Picture-in-Picture (PiP)** mini-window so calls keep going as you navigate AINO.
- **Global incoming-call banner** on every page; ringer respects user notification preferences.
- **Call history** per conversation + global; **active-call resume** on reload.
- **Coturn TURN/STUN** support included in `infra/coturn` for private deployments.

### 📅 Meetings (scheduled)
- Schedule meetings with **conflict detection** against participants' calendars, recurring patterns, automatic invites.
- **Meeting room** page with shared video grid, screen-sharing, layout presets.
- **HLS broadcast mode** for large all-hands (one presenter, many viewers) — relays to a tenant-internal HLS endpoint.

### 📆 Calendar
- Unified calendar surface for **leaves, meetings, holidays, deadlines, custom events**.
- Color-coded by event type, week / month / agenda views.
- Drag-and-drop to reschedule; click-to-create.
- Two-way deep-linking with Notes (calendar item → linked note page → linked tasks).

### 📝 Notes (hierarchical wiki)
- **Per-user + per-team + per-org** note hierarchy. Drag-and-drop tree, infinite nesting.
- **Block-style editor** with rich text, code blocks, tables, embeds.
- **@mentions** of people (notification) and **#links** to tasks / meetings / events.
- **Page history** snapshots with restore.
- **Daily Note prefill** (today's tasks + meetings + leaves auto-populated).
- **1:1 prefill** (last meeting summary + open action items with that direct report).
- **Convert text to task** in one click (creates a backlog ticket, links it back).
- **Sprint embed** — live-rendered current sprint summary inside any note.
- **Time-summary widget** — your week's logged hours rendered inline.

### 🔔 Notifications
- **Notification centre** with unread badge, mark-all-read, filtering by type (mention / leave / approval / task / system).
- **Multi-channel** — in-app, email (templated, throttled), desktop (Electron), and WebSocket push.
- **Per-user preferences** — silence categories, set quiet hours, choose ringer sound.
- **Org-wide announcements** with scheduled publish + acknowledgement tracking.

### 👥 Organisation Management
- **Departments → Teams → Members** hierarchy with drag-and-drop reorganisation.
- **Org chart** view with manager / direct-report relationships.
- **Bulk user import** from CSV / Excel with dry-run preview + per-row error reporting.
- **Invite codes** with expiry + per-code role + max-use limits.
- **Open / closed registration** toggle per tenant.
- **Role change requests** — employees can request promotions; admins approve / reject with reason.

### 🛡️ Admin & Platform
- **Tenant-aware admin panel** for org-level admins (manage own org).
- **Platform Admin** super-tier (`platform_admin`) for managing **multiple tenants** — create, suspend, reactivate, hard-delete, impersonate (with audit trail), seed, view per-tenant stats, set custom domains, toggle feature flags, set per-tenant limits.
- **Audit logs** for every privileged action (cross-org platform admin events also surfaced).
- **Pay-period management** with payroll-hours export (CSV / XLSX) per period.

### 🔐 Security
- **HttpOnly + Secure + SameSite=strict** cookies for JWT — no XSS token theft.
- **CSRF protection** via custom `X-Requested-With` header check.
- **CORS** dynamic same-origin allowlist + explicit env-var override.
- **bcrypt** password hashing, configurable cost.
- **Forced password change** on first login + on admin reset.
- **Token versioning** — admin-triggered force-logout invalidates every active session for a user.
- **Rate limiting** on auth endpoints, configurable per-route.
- **PostgreSQL parameterised queries everywhere** — zero string-concat SQL.
- **Multi-tenant DB isolation** — every tenant has its own database, the request-scoped `req.db` pool guarantees no cross-tenant leakage.
- **Impersonation** is fully audited and visible to the impersonated org's super-admin.

### 🎨 User Experience
- **Light / dark themes** with auto OS detection + manual override; theme persists per user.
- **Responsive layouts** down to 320 px (phone). Sidebar collapses, kanban falls back to vertical stack on small screens.
- **Drag-and-drop** everywhere it makes sense (tasks, files, org chart, notes tree).
- **Keep-alive** routing — heavy pages (Tasks / Chat / Notes / Calendar) stay mounted in the background so navigation is instant and call / chat state never drops on a tab switch.
- **Picture-in-Picture** for meetings.
- **Custom tooltip system** that escapes overflow / stacking contexts (no clipping inside scrolling cards).
- **Profile avatars** with crop + fallback initials.
- **Global search** (`/api/search`) — finds tasks, notes, meetings, conversations, people in one box.
- **Electron desktop app** with system tray, native notifications, deep-link handling, auto-update.

---

## 🏗️ Architecture overview

```
                                  ┌─────────────────────────────┐
                                  │        Browser / Desktop    │
                                  │   React + Vite + Electron   │
                                  └──────────────┬──────────────┘
                                                 │ HTTPS + WSS
                                                 ▼
            ┌────────────────────────────────────────────────────────────────┐
            │                  Express server (Node.js)                      │
            │                                                                │
            │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐   │
            │  │ REST routes  │  │ WebSocket    │  │ Background jobs    │   │
            │  │ (40+ files)  │  │ (chat, calls,│  │ (carry-forward,    │   │
            │  │              │  │  presence)   │  │  burndown, mailer) │   │
            │  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘   │
            │         │                 │                    │               │
            │  ┌──────▼─────────────────▼────────────────────▼───────────┐  │
            │  │          Tenant resolver (subdomain / header)           │  │
            │  └──────┬──────────────────────────────────────────────────┘  │
            │         │ req.db = pool for THIS tenant's DB                  │
            └─────────┼──────────────────────────────────────────────────────┘
                      │
            ┌─────────▼────────────────────────────────────────────────┐
            │  PostgreSQL  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
            │              │ master   │  │ tenant_a │  │ tenant_b │ …  │
            │              │  DB      │  │   DB     │  │   DB     │    │
            │              └──────────┘  └──────────┘  └──────────┘    │
            └────────────────────────────────────────────────────────────┘

            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │ Redis (opt)  │   │ Coturn       │   │ S3 / Volume  │
            │ presence,    │   │ TURN/STUN    │   │ uploads,     │
            │ sprint cache │   │ for WebRTC   │   │ avatars      │
            └──────────────┘   └──────────────┘   └──────────────┘
```

**Key patterns**
- **Tenant-per-database** — each customer organisation gets its own PostgreSQL database. Cross-tenant queries are physically impossible (no shared tables). Master DB only holds the tenant registry + platform-level audit logs.
- **Versioned migration runner** (`server/utils/migrationRunner.js`) tracks applied migrations per-tenant in a `_migrations` table; sweep on boot brings every tenant up to the current schema.
- **Idempotent schema bootstrap** — `initTenantSchema()` runs `CREATE TABLE IF NOT EXISTS` everywhere; safe to re-run.
- **Defaults seeder** — `seedAgileDefaults()` runs after migrations to give every tenant a complete agile setup with zero manual SQL.
- **Lazy-loaded React routes** — heavy pages (Insights, AgileSettings, Meetings, Admin) live in their own chunks so the initial bundle stays fast.
- **Keep-alive routing** — chat, meetings, calendar, tasks stay mounted across navigations to preserve in-flight WebRTC / WebSocket state.

---

## 🛠️ Tech stack

| Layer | Tools |
|-------|-------|
| **Frontend** | React 18, React Router 6, Vite, lucide-react icons, highlight.js, axios, NProgress |
| **Editor / blocks** | TipTap-style rich text (custom), `@dnd-kit` for drag-and-drop |
| **Realtime** | Native WebSocket, WebRTC (with optional Coturn for TURN/STUN) |
| **Streaming** | HLS broadcast mode for large meetings |
| **Backend** | Node.js + Express, Pino structured logging, bcrypt, jsonwebtoken |
| **Database** | PostgreSQL 16 (multi-tenant — one DB per organisation) |
| **Cache** | Redis (optional — used for presence, active-sprint, rate limiting) |
| **Background jobs** | Node `cron`-style scheduler in `server/jobs.js` |
| **Email** | Nodemailer with SMTP / Gmail OAuth2 transport, throttled by user |
| **Container** | Single Dockerfile builds both server + client; `entrypoint.sh` handles uploads volume permissions |
| **Reverse proxy / TLS** | Caddy (local), Railway-managed (production) |
| **Desktop** | Electron with `electron-builder`, system tray, auto-updater |
| **Tests** | Jest with 24 test suites / 289 tests covering routes, middleware, utilities |

---

## 🎭 Roles & permissions model

Six roles, level-graded — each role inherits everything below it:

| Level | Role | Scope |
|-------|------|-------|
| 6 | `platform_admin` | Cross-tenant — manages every organisation, can create / suspend / impersonate orgs |
| 5 | `super_admin` | Org-wide — full admin within one tenant |
| 5 | `hr_admin` | Org-wide — HR-focused (users, leaves, payroll) within one tenant |
| 4 | `manager` | Cross-team — approves leaves, manual entries, overtime; sees reports' data |
| 3 | `team_lead` / `scrum_master` | One team — manages sprints, agile config, team membership |
| 1 | `employee` | Self — own tasks, leaves, profile |

Additional flags:
- **`has_reports`** — any user with at least one direct report gets manager-tier views (even if their role is below `team_lead`).
- **`must_change_password`** — gates every route until the user changes their password (after admin reset / first login).
- **Service Desk overrides** — service-desk-mirrored tasks can be cross-team-assigned by org admins.

---

## 🏢 Multi-tenancy

- **One PostgreSQL database per organisation**, plus a master DB for the tenant registry. Cross-tenant SQL queries are physically impossible — there are no shared tables.
- Tenant resolution by subdomain (`acme.workpulse.app`) **or** explicit `X-Tenant-Slug` header (used by the Electron app).
- **Per-tenant uploads** — every file (avatars, chat attachments, task attachments, meeting recordings) is stored under `uploads/tenant_<tenantId>/org_<orgId>/<kind>/<file>`. The static-file middleware in `server/index.js` cross-checks the `tenant_X` segment of the requested URL against the caller's resolved tenant **and** the `org_X` segment against the caller's org_id — a request from tenant A for `/uploads/tenant_B/...` is rejected with 403 even if the file path is guessed correctly. Helper: `server/utils/uploadPath.js`.
- **Per-tenant feature flags** — toggle Story Points, WIP limits, Retrospectives, etc. without touching code.
- **Per-tenant limits** — max users, max tasks, max storage; enforced at write time.
- **Per-tenant audit log** plus a master audit log for platform-level events.
- **Tenant impersonation** for support — fully audited, banner shown to impersonated org's super-admin, exit button always visible.

---

## 🐳 Local development (Docker)

The recommended way to run AINO locally is through Docker Compose, which handles PostgreSQL automatically.

> **Note:** The dev config files below are gitignored and must be created manually.

### 1. Create dev config files

**`.env.dev`** (project root):
```env
DB_PASSWORD=devpassword123
JWT_SECRET=local-dev-jwt-secret-change-me
CORS_ORIGIN=http://localhost
```

**`Caddyfile.dev`** (project root):
```
localhost {
    @ws { path /ws }
    reverse_proxy @ws workpulse-dev:5000
    reverse_proxy workpulse-dev:5000
    tls internal
}
```

**`docker-compose.dev.yml`** (project root):
```yaml
services:
  postgres-dev:
    image: postgres:16
    container_name: workpulse-postgres-dev
    restart: unless-stopped
    environment:
      POSTGRES_DB: workpulse_dev
      POSTGRES_USER: workpulse
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - ./data/postgres-dev:/var/lib/postgresql/data
    networks: [workpulse-dev]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U workpulse -d workpulse_dev"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  workpulse-dev:
    build: .
    container_name: workpulse-app-dev
    restart: unless-stopped
    depends_on:
      postgres-dev:
        condition: service_healthy
    expose: ["5000"]
    environment:
      - PORT=5000
      - NODE_ENV=development
      - USE_HTTPS=false
      - DATABASE_URL=postgresql://workpulse:${DB_PASSWORD}@postgres-dev:5432/workpulse_dev
      - JWT_SECRET=${JWT_SECRET}
      - CORS_ORIGIN=${CORS_ORIGIN:-http://localhost}
    volumes:
      - ./server/uploads:/app/server/uploads
    networks: [workpulse-dev]

  caddy-dev:
    image: caddy:2-alpine
    container_name: workpulse-caddy-dev
    restart: unless-stopped
    depends_on: [workpulse-dev]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile.dev:/etc/caddy/Caddyfile:ro
      - caddy_dev_data:/data
      - caddy_dev_config:/config
    networks: [workpulse-dev]

volumes:
  caddy_dev_data:
  caddy_dev_config:

networks:
  workpulse-dev:
    driver: bridge
```

### 2. Start the application

```bash
docker-compose -f docker-compose.dev.yml --env-file .env.dev up -d --build
```

The app will be available at **https://localhost** (self-signed cert via Caddy).

### 3. Stop the application

```bash
docker-compose -f docker-compose.dev.yml down
```

### 4. Promote yourself to super admin

After registering your first user:

```sql
UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';
```

Log out and back in to see the **Admin** tab.

---

## ☁️ Production deployment (Railway)

AINO is deployed on [Railway](https://railway.com) — a managed platform that handles PostgreSQL, HTTPS, persistent storage, and auto-deploys on every push to `master`.

See the full step-by-step guide in **[RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md)**.

**Quick summary:**
1. Create a Railway project → add PostgreSQL plugin → add app service from GitHub repo
2. Set env vars: `JWT_SECRET`, `NODE_ENV=production`, `PORT=5000`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `USE_HTTPS=false`
3. Set health check path to `/api/health` and port to `5000`
4. Add a persistent volume at `/app/server/uploads` (Hobby plan+)
5. Generate a domain — Railway handles HTTPS automatically
6. Push to `master` to deploy

**Schema migrations are zero-touch** — on every boot, `initDB()` runs the idempotent schema bootstrap, then `sweepAllTenants()` walks every tenant DB and applies any pending entries from the versioned migration registry. New tenants are auto-seeded with default work item types, workflow states, and agile config.

---

## 🖥️ Desktop app (Electron)

A native Windows / macOS / Linux desktop client lives in `desktop/`.

**Features**
- System tray icon with show / quit / status indicators.
- Native notifications (call ringer, mention, leave-approval).
- **Auto-updater** via electron-builder + GitHub Releases (or Railway-served release manifest).
- Custom title bar with window controls on Windows.
- Deep-link handling — opening a `workpulse://meeting/abc123` URL focuses (or starts) the app and joins the meeting.
- HTTPS proxy bypass for self-hosted internal Coturn.

**Build**
```bash
cd desktop
npm install
npm run build           # builds installers in desktop/dist
npm run release         # uploads to GitHub Releases (requires GH_TOKEN)
```

The web client and the desktop app share the same codebase — `VITE_ELECTRON=1` flips a few behaviours at build time (no NProgress bar, custom title bar, etc.).

---

## 📚 API documentation

Full HTTP API reference is in **[API_DOCUMENTATION.md](API_DOCUMENTATION.md)**.

The server exposes ~40 route files under `/api/*`. Highlights:

| Module | Routes | Purpose |
|--------|--------|---------|
| `/api/auth` | login, register, refresh, forgot/reset password | JWT cookie auth |
| `/api/tracker` | clock in/out, breaks, history, analytics | Time tracking |
| `/api/tasks` | CRUD, comments, history, dependencies, AC, blockers | Task management |
| `/api/sprints` | CRUD, lifecycle, stats, burndown, velocity, cumulative-flow, cycle-time, retrospective | Agile reporting |
| `/api/agile` | settings, work item types, workflow states, permissions | Per-tenant agile config |
| `/api/leaves` | apply, withdraw, summary, balances | Leave management |
| `/api/manager` | approvals, team analytics, member overview | Manager workflows |
| `/api/leave-policy` | policies, balances, holidays | HR config |
| `/api/chat` | conversations, messages, reactions, polls, files | Real-time chat |
| `/api/meetings` | schedule, join, conflicts, HLS broadcast | Video meetings |
| `/api/calendar` | events CRUD | Unified calendar |
| `/api/notes` | hierarchy, history, mentions, prefills, embeds | Notes wiki |
| `/api/notifications` | feed, mark-read, announcements | Notification centre |
| `/api/org` | departments, teams, members, sprint config, org chart | Org structure |
| `/api/admin` | users, roles, audit logs, invites, registration mode | Org-level admin |
| `/api/admin/tenants` | platform-tier tenant CRUD, impersonate, stats | Multi-tenant admin |
| `/api/serviceDesk` | tickets, stats | Internal helpdesk |
| `/api/profile` | self-edit, avatar, password, notification prefs | Account |
| `/api/export` | analytics, leaves, tasks, payroll-hours (CSV/XLSX) | Reporting exports |
| `/api/search` | global cross-entity search | Find anything |

All write endpoints require the `X-Requested-With: WorkPulse` header (CSRF guard) and the JWT cookie.

---

## 🧱 Project structure

```
WorkPulse/
├── client/                       React + Vite SPA (web + Electron renderer)
│   ├── src/
│   │   ├── pages/                Top-level route pages
│   │   ├── components/           Reusable UI (navbar, modals, charts, agile pickers, …)
│   │   ├── *Context.jsx          Global state (Auth, Theme, Chat, Call, Meeting, AgileConfig, …)
│   │   └── api.js                Single axios client with all endpoint wrappers
│   └── public/
├── server/                       Node + Express API
│   ├── routes/                   ~40 route modules (one per domain)
│   ├── middleware/               auth, RBAC, tenant resolver, rate limit, agile editor gate
│   ├── utils/                    logger, mailer, ws, audit, migrationRunner, tenantManager
│   ├── db.js                     PostgreSQL pool + tenant pool registry + initTenantSchema
│   ├── jobs.js                   Background jobs (carry-forward, burndown snapshot, …)
│   ├── redis.js                  Optional Redis cache (presence, sprint cache)
│   └── __tests__/                Jest test suites (24 files / 289 tests)
├── desktop/                      Electron wrapper for native installers
│   ├── main.js                   Main process — windows, tray, deep links, updater
│   └── preload.js                Renderer ↔ main IPC bridge
├── infra/coturn/                 Self-hosted TURN/STUN server config
├── docs/CALLS.md                 WebRTC call architecture deep-dive
├── docker-compose.yml            Production-style local stack
├── docker-compose.dev.yml        (gitignored) — dev stack with hot reload
├── Dockerfile                    Single-stage build for both client + server
├── entrypoint.sh                 Container entrypoint — fixes uploads-volume perms, runs server
├── ARCHITECTURE.md               Internal architecture deep-dive
├── API_DOCUMENTATION.md          Full HTTP API reference
└── RAILWAY_DEPLOYMENT.md         Step-by-step production deploy guide
```

---

## 🤝 Contributing

PRs welcome. The test suite must stay green:

```bash
cd server && npm test          # 289 tests, ~12 s
cd ../client && npx vite build # ensures the client compiles
```

When adding a schema change, append a new entry to `server/utils/migrationRunner.js#MIGRATIONS` — never reorder or rename existing entries.

---

## 📄 License

Proprietary — internal use within authorised organisations only.