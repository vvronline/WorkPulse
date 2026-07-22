# WorkPulse Release Smoke Test

**Task:** T003 â€” Add a documented release smoke-test checklist
**Status:** Active
**Depends on:** T002 (validation baseline)
**Last updated:** 2026-07-22

## Purpose

A short, repeatable check that a deployed WorkPulse build is functionally healthy across
its critical paths. **Every structural pull request** (workspace moves, deployment-boundary
splits, storage/Redis changes, etc.) must run this same checklist against the deploy target
and attach the completed results table (section 8) as pass/fail evidence.

This is a **functional release check**, not the automated validation baseline (that is the
`npm`/`docker` matrix in `docs/architecture/baselines/VALIDATION_BASELINE.md`). Run the
automated baseline first; run this smoke test after the artifact is deployed.

---

## 1. Preconditions

Fill these in for the run, then use them in every step below.

| Variable | Meaning | Example |
|---|---|---|
| `BASE_URL` | Deployed HTTP(S) origin | `https://staging.workpulse.app` |
| `WS_URL` | WebSocket origin + `/ws` path | `wss://staging.workpulse.app/ws` |
| `COLLAB_URL` | Collaboration origin + `/collab` path | `wss://staging.workpulse.app/collab` |
| `TENANT_A` | First synthetic tenant (slug + a login) | slug `smoke-a`, user `a-admin` |
| `TENANT_B` | Second synthetic tenant (slug + a login) | slug `smoke-b`, user `b-admin` |
| `BUILD_REF` | Git SHA / release tag being tested | `adb57128` |
| `ENV` | Target environment | `staging` |

Requirements:

- Two **synthetic** tenants (`TENANT_A`, `TENANT_B`) with at least one login each. Never
  use real customer tenants for cross-tenant rejection checks.
- Auth uses an **HttpOnly JWT cookie** (browser) or a **Bearer token** (CLI). REST clients
  below use `-b cookies.txt` after login; adapt to Bearer if your client stores the token.
- Redis + BullMQ should be enabled on any target running more than one replica (see the
  scaling plan). Note in section 8 whether Redis was enabled for the run.

> Endpoint references reflect the current codebase: health at `/api/health`
> (`server/index.ts`), tenant resolution in `middleware/tenant.ts` (`resolveTenant`),
> realtime WS at `/ws` (`server/utils/ws.ts`), collaboration at `/collab`
> (`server/utils/collaboration.ts`), and uploads served from `/uploads/...`.
> When T009 adds dedicated liveness/readiness endpoints, update section 2.

---

## 2. Liveness and readiness

| # | Check | How | Pass criteria |
|---|---|---|---|
| 2.1 | Process is up (liveness) | `curl -fsS $BASE_URL/api/health` | `200`, body `{"status":"ok",...}` |
| 2.2 | DB reachable + migrations current (readiness) | `curl -fsS "$BASE_URL/api/health?detail=true"` | `200`, `status":"ok"`, `migrations.minApplied >= migrations.expected`, `unreachableTenants: 0` |
| 2.3 | Degraded is visible | (informational) inspect 2.2 body | If any tenant is behind, endpoint returns `503 status":"degraded"` â€” that is a **fail** for release |

> `/api/health` pings the master DB; `?detail=true` sweeps every active tenant DB and
> reports per-tenant applied migration counts. Today this is one endpoint; T009 will split
> cheap liveness from deep diagnostics â€” keep load-balancer probes on the cheap path.

---

## 3. Web load and authentication

| # | Check | How | Pass criteria |
|---|---|---|---|
| 3.1 | Web app loads | Open `$BASE_URL/` in a browser | SPA shell renders, no render-blocking console errors; `index.html` + JS assets return `200` |
| 3.2 | Static assets served | Network tab / `curl -I $BASE_URL/` | HTML `200`; hashed `assets/*.js` `200` |
| 3.3 | Login works | Log in as `TENANT_A` user via the UI | Redirects to authenticated home; an **HttpOnly** `token` cookie is set |
| 3.4 | Session persists | Refresh the page | Stays authenticated (no bounce to login) |
| 3.5 | Logout works | Log out | Auth cookie cleared; protected route redirects to login |

CLI login (for later REST steps), saving the cookie jar:

```bash
curl -fsS -c cookies_a.txt -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
  -d '{"username":"a-admin","password":"<pw>","slug":"smoke-a"}'
```

> Non-GET `/api/*` requests require the `X-Requested-With` header (CSRF guard in
> `server/index.ts`).

---

## 4. Authenticated tenant resolution

| # | Check | How | Pass criteria |
|---|---|---|---|
| 4.1 | Tenant resolved from session | As logged-in `TENANT_A`, call `GET $BASE_URL/api/profile` (`-b cookies_a.txt`) | `200`; returned user/org belongs to `TENANT_A` |
| 4.2 | Correct DB routed | Inspect any tenant-scoped list (e.g. `GET /api/tasks`) | Data is `TENANT_A` data only; no `TENANT_B` rows |
| 4.3 | Unauthenticated is rejected | `curl -i $BASE_URL/api/profile` (no cookie) | `401` |

> `resolveTenant` prefers the JWT `tenant_id` claim (fast path), then subdomain/slug.
> Confirm the resolved tenant matches the login, not the host default.

---

## 5. Cross-tenant rejection (two synthetic tenants)

The most important isolation check. Log in as **both** synthetic tenants into separate
cookie jars (`cookies_a.txt`, `cookies_b.txt`).

| # | Check | How | Pass criteria |
|---|---|---|---|
| 5.1 | Capture a `TENANT_A` resource id | As A: `GET $BASE_URL/api/tasks -b cookies_a.txt` | Note an id, e.g. `TASK_A_ID` |
| 5.2 | B cannot read A's resource | As B: `GET $BASE_URL/api/tasks/$TASK_A_ID -b cookies_b.txt` | `404` or `403` â€” **never** `200` with A's data |
| 5.3 | B cannot write A's resource | As B: `PUT $BASE_URL/api/tasks/$TASK_A_ID -b cookies_b.txt` (+ `X-Requested-With`) | `404`/`403`; A's data unchanged |
| 5.4 | A still sees only A data | Re-run 5.1 as A | Unchanged; no leakage from B |

Any `200` that exposes another tenant's data in 5.2â€“5.3 is a **release blocker**.

---

## 6. Representative REST read and write

Use `TENANT_A`. Pick a durable, low-risk resource (tasks/notes).

| # | Check | How | Pass criteria |
|---|---|---|---|
| 6.1 | Read | `GET $BASE_URL/api/tasks -b cookies_a.txt` | `200`, JSON list |
| 6.2 | Write | `POST $BASE_URL/api/tasks -b cookies_a.txt` (`X-Requested-With`, JSON body) | `200/201`, returns created id |
| 6.3 | Read-back | `GET` the created id | `200`, matches what was written |
| 6.4 | Cleanup | Delete the smoke resource | `200/204` |

---

## 7. Realtime, collaboration, jobs, uploads, clients

### 7.1 WebSocket connection, delivery, and reconnect

| # | Check | How | Pass criteria |
|---|---|---|---|
| 7.1.1 | Connect | Open the web app as A; confirm a WS to `$WS_URL` in the Network tab | Connection `101 Switching Protocols`, stays open |
| 7.1.2 | Delivery | Two A sessions in the same conversation; send a chat message from one | Message appears in the other in near-real-time |
| 7.1.3 | Presence | Observe presence when the second session connects/disconnects | Online/offline updates propagate |
| 7.1.4 | Reconnect | Kill network / restart the socket (or bounce one replica) | Client reconnects automatically; missed messages resync; no duplicates (idempotent handlers) |

> WS auth uses the JWT cookie; realtime path is `/ws` (`server/utils/ws.ts`). On multi-replica
> targets, 7.1.2 must pass with the two sessions pinned to **different** replicas.

### 7.2 Collaboration document open and edit

| # | Check | How | Pass criteria |
|---|---|---|---|
| 7.2.1 | Open | Open a Daily Note / collaborative page as A | Yjs/Hocuspocus doc loads over `$COLLAB_URL` (`/collab`) |
| 7.2.2 | Edit + sync | Type in one session; open the same doc in a second A session | Edits converge in both within a second; no content loss |
| 7.2.3 | Persist | Reload the page | Latest content is loaded from the server |

### 7.3 Background job execution

| # | Check | How | Pass criteria |
|---|---|---|---|
| 7.3.1 | Scheduler alive | Check worker/API logs after boot | Job scheduler initialized (BullMQ when Redis present, else `setInterval` fallback) |
| 7.3.2 | On-demand job | Send a chat message with an attachment (triggers `chat-media-pipeline`) | Media is processed and the finalized attachment is retrievable |
| 7.3.3 | Scheduled job | Observe a periodic job (e.g. `stale-call-sweep` ~20s, or `autoClockOut` ~5m) in logs | Job runs without error across active tenants |

> Job families: `autoClockOut`, `cleanupTokens`, `stale-call-sweep`, `sprint-lifecycle`,
> `inspector-prune`, `retention-cleanup`, `chat-media-pipeline` (see `ARCHITECTURE.md`).
> On scaled targets, confirm jobs run in the **worker** process, not per API replica.

### 7.4 Upload and authenticated download

| # | Check | How | Pass criteria |
|---|---|---|---|
| 7.4.1 | Upload | As A, upload an avatar (`POST /api/profile/avatar`) or a chat file | `200`; response returns a `/uploads/...` path |
| 7.4.2 | Authenticated download | `GET $BASE_URL<returned /uploads path> -b cookies_a.txt` | `200`, correct bytes/content-type |
| 7.4.3 | Unauthenticated download rejected | Same URL with no cookie | `401`/`403` (uploads are auth-gated) |
| 7.4.4 | Cross-tenant download rejected | Fetch A's `/uploads/tenant_A/...` path as B (`-b cookies_b.txt`) | `403`/`404` â€” path traversal + tenant/org isolation enforced |

> Uploads are stored per tenant/org (`/uploads/tenant_x/org_y/...`) and served with
> auth + path-traversal + tenant isolation. On multi-replica targets without shared object
> storage, note whether 7.4.2 works across replicas (Phase 2 moves uploads to object storage).

### 7.5 Desktop renderer loading

| # | Check | How | Pass criteria |
|---|---|---|---|
| 7.5.1 | App launches | Start the packaged desktop build (or `npm --prefix desktop start`) pointed at `$BASE_URL` | Window opens, renderer loads the web app, no white screen |
| 7.5.2 | Auth + realtime | Log in and open a chat | Login works over the remote origin; WS connects (`sameSite=none` cookie for desktop origin) |

### 7.6 Mobile API and WebSocket connectivity

| # | Check | How | Pass criteria |
|---|---|---|---|
| 7.6.1 | API reachable | Launch the mobile app with `EXPO_PUBLIC_API_BASE_URL=$BASE_URL/api`; log in | Login succeeds; authenticated screens load |
| 7.6.2 | WS reachable | With `EXPO_PUBLIC_WS_BASE_URL` set, open a chat | Realtime messages deliver; reconnect works after backgrounding |

---

## 8. Result record (attach to the PR)

Copy this block into the pull request and fill it in.

```text
Release smoke test
  Build ref:   <BUILD_REF>
  Environment: <ENV>            Base URL: <BASE_URL>
  Redis/BullMQ enabled: <yes/no>   Replica count: <n>
  Run by / date: <name / date>

  2  Liveness & readiness          [ PASS / FAIL ]  notes:
  3  Web load & auth               [ PASS / FAIL ]  notes:
  4  Authenticated tenant resolve  [ PASS / FAIL ]  notes:
  5  Cross-tenant rejection        [ PASS / FAIL ]  notes:   (blocker if FAIL)
  6  REST read & write             [ PASS / FAIL ]  notes:
  7.1 WS connect/deliver/reconnect [ PASS / FAIL ]  notes:
  7.2 Collaboration open & edit    [ PASS / FAIL ]  notes:
  7.3 Background job execution     [ PASS / FAIL ]  notes:
  7.4 Upload & auth download       [ PASS / FAIL ]  notes:   (blocker if FAIL)
  7.5 Desktop renderer loading     [ PASS / FAIL / N/A ]  notes:
  7.6 Mobile API & WS connectivity [ PASS / FAIL / N/A ]  notes:

  Overall: [ PASS / FAIL ]
```

Release blockers: any FAIL in **section 2, 5, or 7.4** (health/isolation) blocks the
release regardless of other results.

## 9. Notes and future updates

- When T009 lands, replace the single `/api/health` check in section 2 with the dedicated
  liveness, readiness, and diagnostics endpoints.
- When uploads move to object storage (Phase 2), update 7.4 to verify signed/authenticated
  object access instead of local-disk serving.
- When workers/migrations are extracted (Phase 3), update 7.3 to assert jobs run only in the
  worker process and that API startup runs no schedulers.
