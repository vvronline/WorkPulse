# AINO — Scalability & Modularity Refactor Plan

> **Living document.** Update the checkboxes and the Progress Log as you go.
> Every task has an explicit **Verify** step — do not tick a box until its Verify passes.

**Created:** 2026-08-21
**Last updated:** 2026-08-27
**Owner:** Vishnu V R

**Status:** 🟢 **ALL REPOSITORY WORK IS COMPLETE.** Phases B, C, D (code), H and the guardrails
are done; A, E, F are code-complete with deploy steps outstanding; G is the ongoing rolling
refactor and is explicitly *not* a release blocker.

**Every remaining unchecked box is a dashboard/CLI action that cannot be performed from the
repository.** They are collected, in execution order, in
[🚀 Pre-Push & Deployment Runbook](#-pre-push--deployment-runbook).

**Next action:** work the pre-push runbook top to bottom. **Step 0 (set the Railway variables)
is blocking** — the app will not boot without it, and pushing to `master` auto-deploys.

> 🔴 **The app will not boot in production until `STORAGE_DRIVER=r2` and the three `R2_*`
> variables are set.** Set them *before* you push, because the push itself triggers the deploy.

> That guard is deliberate (A3.11): silently falling back to local disk would reintroduce the
> single-replica constraint this whole phase exists to remove.

> ⚠️ **A1.1–A1.3 (secret rotation) are deliberately deferred** until after the full
> implementation is pushed. The Postgres password and Firebase key exposed on 2026-08-21 are
> **still live** until then. Rotate before the first real tenant onboards — runbook Step 8.

---

## Table of Contents

1. [🚀 Pre-Push & Deployment Runbook](#-pre-push--deployment-runbook) ← **start here**
2. [Why](#why)
3. [Verified Baseline](#verified-baseline)
4. [Target Architecture](#target-architecture)
5. [Locked Decisions](#locked-decisions)
6. [Progress Dashboard](#progress-dashboard)
7. [Phase A — Free-Now Wins](#phase-a--free-now-wins)
8. [Phase B — Safety Net](#phase-b--safety-net)
9. [Phase C — Decompose the Entrypoint](#phase-c--decompose-the-entrypoint)
10. [Phase D — Stateless + Role Split](#phase-d--stateless--role-split)
11. [Phase E — PgBouncer & DB Scaling](#phase-e--pgbouncer--db-scaling)
12. [Phase F — Cloudflare Routing & Load Balancing](#phase-f--cloudflare-routing--load-balancing)
13. [Phase G — Feature Modules](#phase-g--feature-modules)
14. [Phase H — Observability](#phase-h--observability)
15. [Guardrails](#guardrails)
16. [Rollback Playbook](#rollback-playbook)
17. [Progress Log](#progress-log)
18. [Quick Reference — Verified Line Numbers](#quick-reference--verified-line-numbers)

---

# 🚀 Pre-Push & Deployment Runbook

> **Read this before `git push`.** Pushing to `master` triggers an automatic Railway build and
> deploy. There is no manual approval gate between the push and production.
>
> 📖 **Companion doc:** [`PRE_PUSH_DEPLOYMENT_RUNBOOK.md`](PRE_PUSH_DEPLOYMENT_RUNBOOK.md) is the
> longer operator checklist (PgBouncer canary, SPA publish, Worker rollout, per-role validation).
> **This section is the condensed version, cross-referenced to the task IDs in this plan** so you
> can see which phase each action closes out. **If you change one, change both.**

**Deploy trigger chain:**

```
git push origin master
   → GitHub Actions CI (repository-hygiene · server · client · edge-router · mobile → docker-build)
   → Railway watches the branch and builds the Dockerfile
   → Pre-deploy:  node migrate.js        ← FATAL on failure; deploy is aborted
   → Start:       node index.js
   → Health gate: GET /readyz            ← must return 200 within 300s or the deploy rolls back
   → Overlap 30s, drain 15s              ← zero-downtime swap
```

⚠️ **CI does not gate the Railway deploy.** GitHub Actions and Railway watch the branch
independently, so a red CI run does **not** stop the deploy. Run the local gate below and wait for
CI to go green **before** pushing.

---

## ⛔ STEP 0 — BLOCKING: set Railway variables FIRST

**Do this before pushing.** `validateEnvironment()` → `assertProductionStorage()` throws at boot
if these are missing, `/readyz` never returns 200, and the deploy fails its health check.

App service → **Variables**:

| Variable | Value | Why |
|---|---|---|
| `STORAGE_DRIVER` | `r2` | **A3.2.** Without it the app refuses to boot (A3.11) |
| `R2_ACCOUNT_ID` | *(same value as the GitHub secret)* | R2 endpoint |
| `R2_ACCESS_KEY_ID` | *(same value as the GitHub secret)* | R2 auth |
| `R2_SECRET_ACCESS_KEY` | *(same value as the GitHub secret)* | R2 auth |
| `R2_UPLOADS_BUCKET` | `aino-uploads` | Private bucket (ADR-004) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | **D3.1** — production hard-fails without it |
| `DIRECT_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | **E3.2** — pre-deploy migrations bypass PgBouncer |

Optional but recommended now that Phase H has landed:

| Variable | Value | Why |
|---|---|---|
| `METRICS_TOKEN` | `openssl rand -base64 32` | **H1.** Without it `/metrics` returns 404 in production. Use the *same* value on every service |
| `METRICS_TENANT_TOP_N` | `20` | H3 cardinality cap |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(collector URL)* | H4. **Omit to leave tracing off** |

Confirm the R2 API token has **Object Read & Write** on `aino-uploads`, and that the bucket has
**no public custom domain** (ADR-004 — it holds user content).

- [ ] **P0.1** All five `R2_*`/`STORAGE_DRIVER` variables set
- [ ] **P0.2** `REDIS_URL` and `DIRECT_DATABASE_URL` set
- [ ] **P0.3** `METRICS_TOKEN` set (or accept that `/metrics` stays dark)
- [ ] **P0.4** Verified with the name-only check in
      [`PRE_PUSH_DEPLOYMENT_RUNBOOK.md` §1.3](PRE_PUSH_DEPLOYMENT_RUNBOOK.md#13-configure-mandatory-variables-on-the-existing-workpulse-service)
      *(status 2026-08-27: only `REDIS_URL` of the 13 is actually set)*
- [ ] **P0.5** 🔴 **Full database backup taken** — Actions → *DB — Full Backup
      (manual)*. Dumps master **plus every tenant DB**; the older *A2 — Database
      Dump* covers only the default tenant and is **not** a substitute.
      Rolling back the image does not roll back the database.

> ⚠️ Never run `railway variables --kv` and paste the output: it prints raw secret
> values, and the multi-line `FIREBASE_SERVICE_ACCOUNT_KEY` also breaks any
> line-based filter you apply to it. Use `--json` and read only the key names.

---

## STEP 1 — Copy uploads to R2 (A3.8)

Must happen **before** the volume is detached. The R2 key format is byte-identical to the old disk
layout, so this is a straight copy with no transformation.

> 🔴 **`aws s3 sync` from a workstation only works if you can first download the volume**, and
> `railway volume files download` goes over `ssh.railway.com:22`, which is **blocked on the operator
> network**. Use the in-container copier instead — see
> [`PRE_PUSH_DEPLOYMENT_RUNBOOK.md` §1.5](PRE_PUSH_DEPLOYMENT_RUNBOOK.md#15-copy-the-existing-upload-volume-to-r2)
> for the full procedure. Pre-deploy is **not** an option: Railway does not mount volumes there.

Preferred (runs inside the Railway container, where the volume is a local directory):

```sh
# temporary Custom Start Command on the WorkPulse service
node scripts/migrate-uploads-to-r2.js --dry-run   # inspect, write nothing
node scripts/migrate-uploads-to-r2.js             # copy (idempotent, resumable)
node scripts/migrate-uploads-to-r2.js --verify    # exits non-zero if anything is missing
```

Alternative, only from a network that permits port 22:

```bash
railway volume files download / ./uploads-backup --concurrency 32
aws s3 sync ./uploads-backup s3://aino-uploads/ \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com \
  --exclude ".*" --exclude "*/.*"
```

*(Only `default`-tenant data exists — **330.5 MB** — so this is small and low-risk.)*

- [ ] **P1.1** Copy completed without error (`failed : 0`)
- [ ] **P1.2** `--verify` reports `Missing in R2: 0` and `Size mismatches: 0`
- [ ] **P1.3** Custom start command cleared and `/readyz` health check restored

---

## STEP 2 — Local gate (run every command; all must pass)

```powershell
# Guardrails — generated files, Railway config, GR5 statelessness, GR1 SQL, GR2 sizes, GR3 READMEs
npm run check:guardrails

cd server
npm run typecheck        # must be silent
npm run lint:deps        # must report 0 errors (warnings = the Phase G worklist)
npm test                 # expect 74 suites / 846 tests (verified 2026-08-27)
npm run build            # must copy the .sql assets
cd ..

node scripts/verify-docker-migrations.mjs   # proves migrations ship in the image
node scripts/a2-verify-baseline.mjs         # baseline complete + idempotent

cd client; npm run typecheck; npm test; npm run build; cd ..
node scripts/verify-spa-build.mjs client/dist
cd infra/cloudflare; npm test; cd ../..
```

- [ ] **P2.1** `check:guardrails` — all six guards pass
- [ ] **P2.2** Server typecheck clean · `lint:deps` **0 errors**
- [ ] **P2.3** **74 suites / 846 tests** pass *(verified 2026-08-27)*
- [ ] **P2.4** Build ships `dist/platform/db/migrations/*.sql` and `dist/platform/metrics/*`
- [ ] **P2.5** Client + edge-router tests pass
- [ ] **P2.6** Route snapshot shows **only** the intended `GET /metrics` addition

> 🔴 If the route snapshot fails, **read the diff before running `-u`**. A removal is a breaking
> API change; only an intentional addition should be accepted.

---

## STEP 3 — Push, then watch

```bash
git add -A
git commit -m "feat(scalability): Phase H observability + GR1/GR5 guardrails"
git push origin master        # ← this deploys
```

Watch **GitHub Actions** go green, then **Railway → Deployments → Logs**. Expect, in order:

```
Storage: using Cloudflare R2                (bucket: aino-uploads)
migrate.js: running master migrations...
Master migration applied                    master/0001_shards_and_storage
Migration runner: pre-squash DB detected — adopted catch-up migration without re-running it
migrate.js: success — exiting
Runtime dependencies ready (database + Redis)
Server running                              (port 5000)
```

- [ ] **P3.1** CI green on all jobs
- [ ] **P3.2** Pre-deploy `migrate.js` exited **0** (non-zero aborts the deploy — by design)
- [ ] **P3.3** Health check passed; the deploy is **Active**

🔴 **If the deploy fails at boot**, the cause is almost always Step 0. Look for
`STORAGE_DRIVER=local is not supported in production` or `REDIS_URL is required in production`.

---

## STEP 4 — Post-deploy verification

### 4a. Core (A2, A3.9, A4.8)

- [ ] **P4.1** `GET /healthz` → 200, reports the role
- [ ] **P4.2** `GET /readyz` → 200 with `database: ok`, `redis: ok`, `redisSubscriber: ok`
- [ ] **P4.3** `GET /api/internal/migration-status` (platform admin) → `{"expected":1,"minApplied":1}`
      *(`expected` drops 30 → 1: one `.sql` file replaced 30 array entries)*
- [ ] **P4.4** Log in — existing tasks/chats/notes/retrospectives intact
- [ ] **P4.5** **A3.9** — upload an avatar, a chat image and an org logo; each renders, and DevTools
      shows the `/uploads/...` request returning **302** to `r2.cloudflarestorage.com`
- [ ] **P4.6** **A4.8** — `SELECT * FROM shards;` returns the `primary` row; create a throwaway
      tenant → `shard_id` populates → hard-delete it → the `tenant_<id>/` R2 prefix is gone

### 4b. Observability (H1–H5)

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://www.aino.org.in/metrics | head -40
curl -i https://www.aino.org.in/metrics        # expect 404 — proves the guard works
```

- [ ] **P4.7** `/metrics` returns the exposition body **with** the token
- [ ] **P4.8** `/metrics` returns **404 without** the token *(fail-closed — verify, do not assume)*
- [ ] **P4.9** `aino_http_request_duration_seconds` shows **route templates** (`/api/tasks/:id`),
      not concrete ids. **If you see raw ids, stop and fix it** — cardinality damage persists for
      the whole retention window
- [ ] **P4.10** Distinct `tenant` label values ≤ `METRICS_TENANT_TOP_N + 2`
- [ ] **P4.11** Load `infra/observability/alerts.yml` + `prometheus.yml` into Prometheus;
      all three role targets are `UP`

---

## STEP 5 — Detach the volume 🔥 *(A3.10b — this is what unblocks replicas)*

Only after P4.5 passes.
Railway → app service → **Settings → Volumes** → detach `workpulse-volume`.

- [ ] **P5.1** Volume detached
- [ ] **P5.2** App still Online; uploads still work (now served only from R2)
- [ ] **P5.3** 📅 **Diary a reminder: delete the volume after one week.** Keep it detached-but-
      undeleted until then as a cheap rollback

---

## STEP 6 — Prove horizontal scaling (D5) 🔴 DO NOT SKIP

This is the gate that decides whether the whole refactor actually worked.

- [ ] **P6.1** **D5.2 / A3.9** — scale `web` to 2 replicas; upload a file on one instance and
      download it through the other
- [ ] **P6.2** **D5.1** — scale `realtime` to 2; pin a caller and callee to **different** instances
      and place a call. Verify: media connects · offer-first replay works · ICE arrives ·
      reconnect within 15s · **no false meeting-leave event**
- [ ] **P6.3** **D5.3** — scale `worker` to 2; confirm each BullMQ repeatable job fires **once**,
      not once per replica (watch `aino_job_runs_total`)
- [ ] **P6.4** Under load, `aino_db_pool_evictions_total` stays flat and
      `aino_db_pool_connections{state="waiting"}` stays at 0

> If P6.2 fails the symptom is **silent**: the call simply never connects and nothing logs an
> error. Check `aino_redis_up{connection="subscriber"}` first.

---

## STEP 7 — Role split & infrastructure (F1, E1.1, E3.2, F3c, F5b, F4, F6)

Optional for the first deploy — `ROLE=all` is fully supported and is the safe default. Do these
when you actually need to scale a tier independently.

- [ ] **P7.1** **F1** — create `aino-web` / `aino-realtime` / `aino-worker` from the same image,
      differing only by `ROLE`. Helper: `scripts/setup-railway-roles.ps1` (dry-run first).
      Keep the current service at `ROLE=all` until the split passes Step 6
- [ ] **P7.2** Every service has `REDIS_URL` and the same `METRICS_TOKEN`
- [ ] **P7.3** Confirm no service has a **manual dashboard override** of the health-check path —
      a dashboard value silently wins over `railway.json` (D4.5)
- [ ] **P7.4** **E1.1** — deploy PgBouncer (`infra/pgbouncer/`, `edoburu/pgbouncer`),
      **transaction mode**, `default_pool_size ≈ 20`. Point `DATABASE_URL` at it and keep
      `DIRECT_DATABASE_URL` on Postgres
- [ ] **P7.5** **E3.2** — confirm the pre-deploy command uses `DIRECT_DATABASE_URL`, so app pods
      never run DDL
- [ ] **P7.6** **F3c/F5b** — publish the SPA to the public R2 bucket, set `SERVE_SPA=false`,
      attach the custom domain, confirm `cf-cache-status: HIT` on hashed assets while
      `index.html`/`sw.js` stay `no-store`
- [ ] **P7.7** **F2** — Cloudflare path rules: `/api/*`, `/uploads/*` → web · `/ws`, `/collab` →
      realtime · everything else → the SPA R2 origin.
      🔴 **Private uploads must never route directly to public R2**
- [ ] **P7.8** **F4** — Cloudflare WAF + edge rate limiting (fires *before* the app limiters)
- [ ] **P7.9** **F6** — replica counts: web on CPU/p95 · realtime on WS connections (cap ~5k/pod,
      drain slowly) · **worker on `aino_queue_depth`, not CPU**
- [ ] **P7.10** **H6** — run the k6 load test and confirm the thresholds hold:
      `k6 run -e BASE_URL=https://www.aino.org.in infra/observability/k6/load-test.js`

---

## STEP 8 — 🔐 Rotate the deferred secrets (A1.1–A1.3)

**These credentials have been live and exposed since 2026-08-21.**
Do this **before onboarding the first real tenant**.

- [ ] **P8.1** **A1.1** — rotate the Postgres password (Railway → Postgres → rotate credentials).
      Update `DATABASE_URL`/`DIRECT_DATABASE_URL` (reference variables update themselves)
- [ ] **P8.2** **A1.2** — Firebase: GCP Console → IAM → Service Accounts →
      `firebase-adminsdk-fbsvc@aino-86bb6.iam.gserviceaccount.com` →
      **delete key `43a25c39680d69b7f6633722f4bf0d2b5a2bd33a`** → create new →
      update `FIREBASE_SERVICE_ACCOUNT_KEY`
- [ ] **P8.3** **A1.3** — remove/disable `DATABASE_PUBLIC_URL` unless actively needed; it exposes
      Postgres to the internet and is published into the app env
- [ ] **P8.4** Verify: app Online · push notifications still deliver ·
      `railway variables --kv` no longer lists `DATABASE_PUBLIC_URL`

---

## 🔙 Emergency rollback

| Symptom | Action |
|---|---|
| Won't boot: `STORAGE_DRIVER=local is not supported` | Set `STORAGE_DRIVER=r2` + the `R2_*` vars (Step 0) |
| Won't boot: `REDIS_URL is required in production` | Set `REDIS_URL`; it is mandatory (D3.1 / ADR-006) |
| Pre-deploy migration failed | The deploy already aborted and the old version is still live. Fix, then redeploy |
| Uploads 404/500 | `STORAGE_DRIVER=local` + re-attach the volume (this is why Step 5 keeps it for a week) |
| Calls fail across replicas | Scale realtime back to 1; check `aino_redis_up{connection="subscriber"}` |
| Jobs run twice | Scale worker to 1; check the BullMQ leader lease |
| Any code regression | `git revert` and push — the `_migrations` ledger keeps the old names, so the previous runner resumes with zero data loss |
| `/metrics` leaking publicly | Unset `METRICS_TOKEN` → the endpoint goes dark in production |

---

## Why

Current pain, with evidence gathered from the codebase on 2026-08-21:

| Problem | Evidence |
|---|---|
| God entrypoint | `server/index.ts` = **726 lines** — env validation, CSP, CORS, static SPA, `/uploads` auth serving, 7 rate limiters, 30+ route mounts, health, **business logic** (`autoClockOut` at L496–560), bootstrap, WS, shutdown |
| Fat routers, no layering | `routes/chat.ts` **4,473 L / 51 routes / 333 inline SQL**; `routes/tenants.ts` 1,844; `routes/tracker.ts` 1,620; `routes/admin.ts` 1,403 |
| `utils/` junk drawer | 35 files mixing infra, transport (`ws.ts` **3,782 L**) and domain logic |
| Schema as one function | `db.ts` **2,166 L**; `migrationRunner.ts` **1,631 L** with 30 hand-maintained `MIGRATIONS[]` entries |
| **Cannot run 2 replicas** | Local-disk uploads pinned to a Railway volume (see A3) |
| **Calls break across replicas** | In-process WebRTC signal buffers (see D1) |
| **Migrations race on boot** | No advisory lock — `grep advisory` in `server/**` returns **0 matches** (see E3) |
| **Connection budget blowout** | 10 master + 10 pools × 8 = **90 conns/instance** vs ~100 `max_connections` (see E1) |
| **LRU thrash from tenant #11** | `TENANT_MAX_POOLS = 10` (see E2) |
| No proxy control | Railway edge only — no path routing, no edge cache, no WAF (see F) |

**Good patterns already in the repo — copy these, don't invent:**
- `server/services/status/` → `repository.ts` / `resolver.ts` / `cache.ts` / `broadcaster.ts` / `constants.ts` / `README.md` / `__tests__/`
- `server/routes/tasks/` → split by concern + `_helpers/`

---

## Verified Baseline

Captured 2026-08-21 via Railway CLI + live health endpoint.

```
Railway project: renewed-fascination (1be6f4e9-6e54-4594-ad4b-8fd691fb9b02)
Environment:     production · EU West
Services:
  WorkPulse  ● Online · https://www.aino.org.in · 1 replica
             volume: workpulse-volume 330 MB / 500 MB @ /app/server/uploads
  Redis      ● Online   (REDIS_URL set ✓)
  Postgres   ● Online

/api/health?detail=true →
  {"expected":30,"minApplied":30,"tenants":{"default":30,"master":30}}

TENANTS: only `default` (+ legacy master). ZERO customer tenants.
Migrations: 30 entries in MIGRATIONS[] (migrationRunner.ts:46)
Disk uploads: ONLY routes/chat.ts, routes/profile.ts, routes/branding.ts
              (routes/admin.ts:1071 already uses memoryStorage — no change needed)
Cloudflare:  already fronts cdn.aino.org.in → R2 bucket (desktop OTA)
R2 creds:    R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
             → GitHub secrets only, NOT yet on Railway
TURN:        Cloudflare TURN, DISABLE_PUBLIC_TURN=true — managed, already scales
```

### 🔑 Platform admin lives in the MASTER DB — you cannot be locked out

Traced through the auth code:

| Fact | Evidence |
|---|---|
| `platform_users` is a **master DB** table | `db.ts:211` |
| Login reads it from master | `auth.ts:159` — `SELECT * FROM platform_users WHERE username = $1 OR email = $1` |
| The `default` tenant only holds a **mirror** row | `auth.ts:493-499` — auto-`INSERT` on login when missing, password hash copied from master |
| `user_directory` is auto-re-registered | `auth.ts:503-506` |
| Nuclear fallback if master is ever empty | `auth.ts:275` — first `/api/auth/register` re-bootstraps platform admin, guarded by `pg_advisory_xact_lock(1)` |

➡️ **Recreating the `default` tenant DB is safe.** It touches only the mirror; the next login rebuilds it.
➡️ **A2 never touches the master DB.**

---

## Target Architecture

```
                    Cloudflare  (already yours — WAF, TLS, cache, PATH ROUTING)
                         │
      ┌──────────────────┼──────────────────┬─────────────────┐
      │ /api/*           │ /ws, /collab     │ /assets/*, /*   │
      ▼                  ▼                  ▼
  aino-web           aino-realtime      cdn.aino.org.in
  ROLE=web           ROLE=realtime      R2 (SPA + uploads)
  2–4 replicas       1–2 replicas       $0 egress, no Node
      │                  │
      └────────┬─────────┘         aino-worker (ROLE=worker, 1 replica)
               │                          │
        ┌──────┴──────────────────────────┴──────┐
        │  Redis  ·  PgBouncer  ·  Postgres      │
        └────────────────────────────────────────┘
```

**One Docker image, three roles** selected by the `ROLE` env var. That alone is ~80% of scalability.

> **No Caddy service.** Railway's proxy routes by *hostname*, not path — so Cloudflare (already in
> front of DNS, $0) does the path routing instead. Confirmed with owner: Railway is cheap and
> simple to maintain, so we stay on it.

---

## Locked Decisions

Write each of these to `docs/adr/` during Phase B.

| # | Decision | Rationale |
|---|---|---|
| ADR-001 | **Keep DB-per-tenant** | Strongest isolation; `tenants.db_host` + `getTenantPool(dbName, dbHost)` already make it shardable. Switching to RLS would mean auditing 333 SQL statements in `chat.ts` alone. The O(n) problems are solved by PgBouncer + parallel `forEachTenant`, not by changing the model. |
| ADR-002 | **Cloudflare for path routing, no Caddy service** | Railway routes by hostname only. Cloudflare is already in front, costs $0, adds no new hop. |
| ADR-003 | **R2 folder prefixes, NOT per-tenant buckets** | See detail below. |
| ADR-004 | **Two buckets split by access pattern** | `aino-releases` (public, `cdn.aino.org.in`) vs `aino-uploads` (**private**, presigned only). User content must never share a bucket that has a public custom domain. |
| ADR-005 | **Squash 30 migrations → one baseline** | Zero customer tenants; this is the cheapest it will ever be. |
| ADR-006 | **Redis mandatory in production** | The silent in-memory fallback (`redis.ts:41`) fragments rate limits + presence across replicas *invisibly*. |
| ADR-007 | **Stay on Railway** | Owner confirmed: cheap + simple. All phases target standard Docker + env config, so nothing here creates lock-in. |

### ADR-003 detail — why prefixes beat per-tenant buckets

Checked against Cloudflare's published R2 limits:

| R2 limit | Impact |
|---|---|
| Max buckets/account: 1,000,000 | Permits it numerically… |
| **Custom domains: 100 per bucket** | …but each bucket needs its own binding |
| **Bucket mgmt ops: 50/sec** | Bucket creation sits in the tenant-provisioning path |
| **REST API: 1,200 req / 5 min account-wide** | Per-bucket CORS/lifecycle/config changes share one budget across all tenants |
| Objects per bucket: **unlimited** | No scale reason to split |

Decisive point: **CORS, lifecycle and public-access settings are per-bucket.** One retention-policy
change would mean iterating N buckets through a 1,200-per-5-min budget. With prefixes it is one
lifecycle rule with a prefix filter.

**Isolation comes from presigned URLs, not bucket boundaries** — a client only ever receives a 60s
signature for one specific key and can never enumerate another tenant's prefix.

**Chosen layout** (reuses the existing `uploadPath.ts` scheme verbatim):

```
aino-uploads/                          ← new bucket, PRIVATE
└── tenant_<tenantId>/
    └── org_<orgId>/
        ├── avatars/   chat/   branding/   notes/   exports/
```

| Bucket | Contents | Access | Domain |
|---|---|---|---|
| `aino-releases` *(exists)* | desktop installers, OTA manifests | **public** | `cdn.aino.org.in` |
| `aino-uploads` *(new)* | all user content | **private**, presigned only | none |

Per-tenant guarantees without per-tenant buckets:
- **Isolation** → presigned URLs + the `tenant_<id>` path assertion already in `index.ts:261`
- **Usage metering** → `tenants.max_storage_mb` already exists; sum object sizes by prefix
- **Tenant deletion** → `deleteTenant()` gains a prefix-delete call (A4.5)
- **Data residency** → per-*jurisdiction*, not per-tenant

**Escape hatch (built in A4.4):** `tenants.storage_bucket` (nullable, defaults to `aino-uploads`).
Mirrors the `db_host` pattern — if one tenant ever needs EU-only residency, override that column.
**Prefixes now do not foreclose buckets later.**

---

## Progress Dashboard

| Phase | Scope | Effort | Status |
|---|---|---|---|
| **A** | Free-now wins (secrets, squash, R2, shards) | 1 wk | 🟡 **Implementation complete; rollout pending** — A2.1–A2.9 ✅ · A3.1/A3.3–A3.7/A3.10a–A3.12 ✅ · A4.1–A4.7 ✅ · **A1.1–A1.3, A3.2/A3.8/A3.9/A3.10b, A4.8 ⬜** |
| **B** | Safety net (route snapshot, dep-cruiser, CI) | 2 d | 🟢 **Complete** — B1–B5 ✅ |
| **C** | Decompose `index.ts` → <60 lines | 4 d | 🟢 **Complete** — C1–C7 ✅ · index.ts 45 lines |
| **D** | Stateless + role split → **unlocks replicas** | 1 wk | 🟡 **Implementation complete; staging gate pending** — D1–D4 ✅ (incl. D4.5 as config-as-code) · D5 ⬜ *(runbook Step 6)* |
| **E** | PgBouncer + DB scaling | 3 d | 🟡 **Repository complete; Railway rollout pending** — E1.2/E1.3/E2/E3.1/E4 ✅ · E1.1/E3.2 ⬜ · E5 deferred |
| **F** | Cloudflare routing + LB | 2 d | 🟡 **Repository ready; live routing pending** — edge/static CI ✅ · F1/F2/F4/F6 and final SPA cutover ⬜ |
| **G** | Feature modules (rolling) | 2–3 wk | 🟡 **In progress, not a release blocker** — attendance slices G4.1–G4.4a ✅ |
| **H** | Observability (continuous, start in C) | ongoing | 🟢 **Repository complete** — H1–H6 ✅ · Prometheus/OTLP wiring ⬜ *(runbook Step 4b)* |
| **GR** | Guardrails | — | 🟢 **Complete** — GR1–GR8 ✅ (GR1 and GR5 landed 2026-08-27) |

```
A → B → C → D → E → F → G (rolling) → H (continuous)
└ before 1st tenant ┘   └ unlocks replicas ┘
```

**All repository work is done.** What remains is the deploy sequence in the
[Pre-Push & Deployment Runbook](#-pre-push--deployment-runbook), plus Phase G, which is a rolling
code-quality refactor that does not block scaling.

Legend: ⬜ Not started · 🟡 In progress · ✅ Done · ⛔ Blocked

**Checkbox semantics:**
- `[x]` means implemented and verified, or explicitly superseded with no remaining action.
- `[ ] ⚙️ DEPLOY` means the repository implementation is ready but a Railway/Cloudflare/live-app
  action is still required. These remain unchecked until verified in production.
- **Every remaining `[ ]` in this document is one of those deploy actions** (or a Phase G module
  migration) and is mirrored as a `P*` item in the runbook.

---

## Phase A — Free-Now Wins

> ⏰ **Do this before onboarding the first real tenant.** Zero customer tenants makes all of it
> nearly free; every month of delay turns each item into a data-migration project.

### A1 — Rotate leaked secrets 🔴 DEFERRED TO POST-DEPLOY

**Status:** ⬜ 1 of 4 complete — A1.4 verified; A1.1–A1.3 intentionally deferred by owner.

`railway variables` printed full secret values into a terminal transcript on 2026-08-21.

> **Owner decision 2026-08-21:** rotate only after the whole implementation is deployed and
> pushed, so credentials change once. **A1.4 is already verified**; A1.1–A1.3 are dashboard
> actions to run at that point. Until then, treat both secrets as compromised —
> **do not onboard a real tenant first.**

- [ ] **A1.1** Rotate the Postgres password — Railway → Postgres → rotate credentials.
      *(The exposed value was the `DATABASE_PUBLIC_URL` password; rotate regardless of whether you
      still recognise it.)*
- [ ] **A1.2** Rotate the Firebase service-account key — GCP Console → IAM → Service Accounts →
      `firebase-adminsdk-fbsvc@aino-86bb6.iam.gserviceaccount.com` → **delete key
      `43a25c39680d69b7f6633722f4bf0d2b5a2bd33a`** → create new → update
      `FIREBASE_SERVICE_ACCOUNT_KEY` on Railway.
- [ ] **A1.3** Remove/disable `DATABASE_PUBLIC_URL` (Railway TCP proxy) unless actively needed —
      it exposes Postgres to the internet and is published into the app env.
- [x] **A1.4** ✅ **VERIFIED 2026-08-21** — `.env` is ignored (`.gitignore:57 **/.env`) and
      `git log --all -- .env` returns **0 commits**. No secret was ever committed.

**Verify:** app still Online after rotation · push notifications still deliver ·
`railway variables --kv` no longer lists `DATABASE_PUBLIC_URL`.

> ⚠️ Never run `railway variables` with unredacted output again. Use
> `railway variables --kv | Select-String -NotMatch 'SECRET|PASS|KEY|TOKEN'`.

---

### A2 — Squash 30 migrations → single baseline

**Status:** ✅ **COMPLETE — A2.1 through A2.9 resolved, implemented and verified.**

**The master DB is NEVER touched in this task.** Tenant schema only.

> 🔴 **FINDING 2026-08-21 — `initTenantSchema()` is INCOMPLETE.**
> Ran `node scripts/analyze-migration-coverage.mjs`: of 143 DDL objects created by the 30
> migrations, **26 exist ONLY in `MIGRATIONS[]`** and are *never* created by
> `initTenantSchema()` (`db.ts:431`). Verified by direct grep — `db.ts` contains **zero**
> references to any of them:
>
> | Missing from `initTenantSchema()` | Feature it breaks |
> |---|---|
> | `device_tokens` + 3 indexes | **Push notifications** (10 usages in `pushNotifications.ts`/routes) |
> | `webauthn_credentials`, `device_credentials` + 2 indexes | **Biometric login** (15 usages in `auth.ts`) |
> | `mfa_reset_tokens` + 2 indexes, and `users.mfa_*` (5 cols) | **MFA / 2FA** |
> | `users.biometric_login_enabled` | Biometric opt-in flag |
> | `sprint_burndown_snapshots` + index | Sprint burndown charts |
> | `sprint_retro_votes` + index | Retro voting |
> | `tasks.cycle_started_at`, `tasks.lead_started_at` | Cycle/lead-time metrics |
> | `idx_users_org_active`, `idx_audit_logs_actor_created`, `idx_audit_logs_entity_created` | Query performance |
>
> *(`above` in the raw output is a false positive — it matched a code comment.)*
>
> **Consequences:**
> 1. **A2.4 cannot be generated from `initTenantSchema()` alone.** The completed implementation
>    generates the catch-up SQL from the actual migration sources (`migrationRunner.ts` plus
>    `services/status/migration.ts`) and verifies all 26 missing objects. A `pg_dump` is optional
>    backup tooling, not an implementation dependency.
> 2. **Pre-existing latent bug:** any tenant created today gets its schema from
>    `initTenantSchema()` first — push notifications, biometric login and MFA tables only
>    appear later when the migration sweep runs. A2 *fixes* this permanently.
> 3. This is strong independent justification for the squash: one baseline file removes the
>    entire `initTenantSchema()`-vs-`MIGRATIONS[]` drift class of bug.

> ✅ **RESOLVED 2026-08-21 — no database access needed.**
> The workstation network permits HTTPS/443 only (`:21659` and `:22` refused), so instead of
> `pg_dump` the baseline is **generated from source code** by
> `scripts/a2-generate-baseline.mjs`, which reads `db.ts`, `migrationRunner.ts` and
> `services/status/migration.ts`. Everything applies **on the next deploy** —
> `migrate.ts` runs the sweep automatically. `scripts/a2-dump-databases.sh` and the
> `a2-database-dump.yml` workflow remain available for optional backups.

**Tooling — all implemented and syntax-checked 2026-08-21:**
- `scripts/analyze-migration-coverage.mjs` — ✅ **run**, produced the finding above
- `scripts/a2-dump-databases.sh` — optional read-only backup utility; self-verifies
- `.github/workflows/a2-database-dump.yml` — runs that script on a GitHub runner
  (open egress + `pg_dump` 16), uploads a private 7-day artifact

- [x] **A2.1** ✅ **Superseded — no live master dump is required for this implementation.**
      The design changed from drop/recreate to in-place legacy adoption, so the master DB and
      `platform_users` are never altered. The optional dump workflow remains available for backup.
- [x] **A2.2** ✅ **Superseded by the no-drop design.** Platform-admin preservation is guaranteed
      structurally: the master DB is untouched, and four legacy-adoption tests prove the catch-up
      is recorded without executing destructive SQL on the existing `default` DB.
- [x] **A2.3** ✅ **Superseded — no tenant restore artifact is required for rollback.**
      `default` is not dropped or recreated; rollback is `git revert`, while all 30 legacy ledger
      rows remain intact for the previous runner.
- [x] **A2.4** ✅ Generated `server/platform/db/migrations/0002_migration_catchup.sql` —
      **170 SQL statements, 55 KB**, produced by `scripts/a2-generate-baseline.mjs` from
      `migrationRunner.ts` + `services/status/migration.ts`. All 26 previously-missing objects
      verified present.
- [x] **A2.5** ✅ Rewrote `utils/migrationRunner.ts`: **1,668 → 331 lines**. `MIGRATIONS[]` is gone;
      it now loads `platform/db/migrations/*.sql` in filename order. `_migrations` bookkeeping,
      `expectedMigrationCount` (now derived from the directory) and
      `scrubPlatformAdminsFromCustomerTenants` are preserved unchanged.
- [x] **A2.6** ✅ **No drop/recreate needed — `default` data is preserved.**
      Added a **legacy-adoption** guard: a DB carrying all 30 pre-squash migration names records
      the catch-up as applied *without executing it*. Critical, because the file contains
      `DROP TABLE IF EXISTS sprint_retrospectives` + recreate, which would delete live rows.
      Fresh tenant DBs execute it normally.
- [x] **A2.7** ✅ Not applicable — nothing is dropped, so the platform-admin mirror row is
      never lost. (`auth.ts:493` would rebuild it anyway.)
- [x] **A2.8** ✅ **Build now ships the SQL.** `tsc` ignores `.sql`, so
      `server/scripts/copy-sql-assets.mjs` copies `platform/db/migrations/*.sql` into `dist/` and
      **fails the build** if none are found. Wired into `npm run build`.
- [x] **A2.9** ✅ CI guards added: `scripts/verify-docker-migrations.mjs` (proves the image will
      contain the migrations) and `scripts/a2-verify-baseline.mjs` (completeness + idempotency),
      both in `.github/workflows/ci.yml`.

**Verified locally:**
- `npm run typecheck` — clean
- `npm test` — **53 suites / 692 tests pass** (up from 52/663; +29 new migration tests)
- `npm run build` → `dist/platform/db/migrations/0002_migration_catchup.sql` present
- Docker path simulation: `dist/utils/../platform/db/migrations` resolves ✓

**Verify after deploy:**
- `/api/health?detail=true` → `{"expected":1,"minApplied":1,"tenants":{"default":1,"master":1}}`
  *(`expected` drops 30 → 1: one `.sql` file replaces 30 array entries)*
- Deploy logs show `pre-squash DB detected — adopted catch-up migration without re-running it`
- Login works; existing tasks/chats/notes/retrospectives intact

**Rollback:** `git revert` the commit. The `_migrations` ledger keeps the old 30 names, so the
previous runner resumes with zero data loss.

---

### A3 — Uploads → Cloudflare R2 🚀 *unblocks replicas*

**Status:** 🟡 **IMPLEMENTATION COMPLETE; PRODUCTION ROLLOUT PENDING.**
Completed: A3.1, A3.3–A3.7, A3.10a–A3.12. Pending deploy: A3.2, A3.8, A3.9, A3.10b.

The Railway volume is what pins you to exactly **1 replica**. Highest-value single change in the plan.

- [x] **A3.1** ✅ **DONE 2026-08-21** — `aino-uploads` bucket created.
      Confirm it has **no public custom domain** (ADR-004) before A3.7 presigning work.
- [ ] **A3.2** ⚙️ **DEPLOY STEP** — add to Railway service vars: `STORAGE_DRIVER=r2`,
      `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
      `R2_UPLOADS_BUCKET=aino-uploads`. *(Values already exist as GitHub secrets.)*
      🔴 **The app now refuses to boot in production without these** — see A3.11.
- [x] **A3.3** ✅ Declared `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` in
      `server/package.json` (both were already installed transitively — relying on that was fragile).
- [x] **A3.4** ✅ Created `server/platform/storage/`: `types.ts` (the `StorageAdapter` contract),
      `keys.ts` (key/URL builders + `urlToKey`), `r2Adapter.ts`, `localAdapter.ts` (dev),
      `index.ts` (driver factory + `assertProductionStorage`).
- [x] **A3.5** ✅ `utils/uploadPath.ts` is now a thin compatibility layer over
      `platform/storage/keys.ts`. **Key format unchanged** —
      `tenant_<tenantId>/org_<orgId>/<kind>/<filename>` — so every `avatar`, `logo_url` and
      `file_url` already in a tenant DB stays valid with **no data migration**.
      `fs.mkdirSync` and `UPLOADS_ROOT` removed.
- [x] **A3.6** ✅ Swapped `multer.diskStorage` → `multer.memoryStorage()` + `adapter.put()`.
      🔴 **Scope corrected 2026-08-21 — there are FOUR upload sites, not three**, plus three
      more filesystem readers the original plan missed:
      - `routes/chat.ts` — L74 storage, L80 `getUploadDir`, L1753 `getUploadUrl`, **L2324 `fs.unlink`**
      - `routes/profile.ts` — L39 storage, L69 `UPLOADS_ROOT`, L89, **unlinks at L99/L108/L432**
      - `routes/branding.ts` — L52 storage, L88 `safeLogoPath`, L158, **unlinks at L185/L196/L216**
      - **`routes/tasks/comments.ts` — L36 storage, L40, L105 unlink, L130** ← missed originally
      - **`routes/public.ts` — L120 `UPLOADS_ROOT`, L168 `res.sendFile`** (share links) ← reader
      - **`services/chatMediaPipeline.ts` — L78 `path.join`, L84 `createReadStream`, L193
        `fs.existsSync`** ← BullMQ worker reads uploaded media off disk
      *(`routes/admin.ts:1071` already uses `memoryStorage` — no change.)*
- [x] **A3.7** ✅ Replaced the static handler (`index.ts`) with **presign + 302 redirect**.
      Every existing authorization check (tenant prefix, org prefix, chat-participant lookup)
      runs **before** signing; TTL 60s; `Cache-Control: private, no-store`. Local dev streams
      the buffer instead, since `LocalAdapter.getSignedUrl()` returns null.
- [ ] **A3.8** ⚙️ **DEPLOY — copy the existing 330 MB volume into `aino-uploads`.**
      No transformation is needed because the R2 key format is byte-identical to the old disk
      layout, but the copy itself must still happen before the volume is detached. Verify object
      count and checksum samples; exact command is in the deploy checklist.
- [ ] **A3.9** ⚙️ **DEPLOY STEP** — smoke test: upload an avatar, a chat image and an org logo;
      confirm each renders and that a 302 to `r2.cloudflarestorage.com` is returned.
- [x] **A3.10a** ✅ Volume dependency removed in code: `entrypoint.sh` no longer runs as root
      (its whole purpose was the volume `chown`), `Dockerfile` drops `su-exec` and switches to
      `USER appuser` at build time, `docker-compose.yml` gained the `STORAGE_DRIVER`/`R2_*` vars.
- [ ] **A3.10b** ⚙️ **DEPLOY — detach `workpulse-volume` in Railway after A3.8/A3.9 pass.**
      Keep it detached but undeleted for one week as rollback, then delete it permanently.
- [x] **A3.11** ✅ **Boot guard** — `assertProductionStorage()` runs in `index.ts` before listen.
      `STORAGE_DRIVER=local` in production is now a **fatal startup error**, because a local
      directory cannot be shared between replicas. Missing R2 credentials also fail at boot
      rather than on the first upload.
- [x] **A3.12** ✅ Migrated the three filesystem readers the original plan missed:
      `routes/public.ts` (share-link logo — streams bytes so the sandbox CSP headers still apply),
      `services/chatMediaPipeline.ts` (BullMQ worker; checksum now reads from storage — essential
      because the worker becomes its own process in Phase D), and all six `fs.unlink` call sites.

**Verified locally:**
- `diskStorage` / `UPLOADS_ROOT` / `getUploadDir` — **0 occurrences** in the working tree
- `npm run typecheck` clean · **55 suites / 739 tests pass** (+47 new storage tests)
- Production guard proven by test: `STORAGE_DRIVER=local` + `NODE_ENV=production` → throws

**Verify after deploy:** scale to 2 replicas → upload on one, download from the other.

**Rollback:** set `STORAGE_DRIVER=local` and re-attach the volume.
Keep it **detached but undeleted for 1 week** before permanently removing.

---

### A4 — Shard-ready tenancy *(free at 0 tenants, painful at 50)*

**Status:** 🟡 **IMPLEMENTATION COMPLETE; LIVE VERIFICATION PENDING (A4.8).**

- [x] **A4.1** ✅ Added the `shards` table (`id`, `name`, `host`, `port`, `capacity`,
      `tenant_count`, `is_active`, `region`) in
      `platform/db/migrations/master/0001_shards_and_storage.sql`.
- [x] **A4.2** ✅ Seeded shard `primary`. `host = ''` is a sentinel meaning "same host as
      `DATABASE_URL`", so the row survives a managed-database hostname change.
- [x] **A4.3** ✅ `createTenant()` calls `pickShard()` (least-loaded active shard with spare
      capacity) and writes `db_host` + `shard_id`, then bumps `tenant_count`.
      Returns null pre-migration → `db_host` stays NULL → identical single-host behaviour.
- [x] **A4.4** ✅ Added nullable `tenants.storage_bucket` — the ADR-003 escape hatch.
- [x] **A4.5** ✅ `deleteTenant(hardDelete)` now calls `deletePrefix('tenant_<id>/')`.
      Best-effort + loudly logged: without it, every avatar/attachment/logo would be orphaned in
      R2 after a deletion request, accruing cost and retaining customer data.
- [x] **A4.6** ✅ 🔴 **Fixed a latent bug found while wiring A4.3:** `createTenant()` ran
      `initTenantSchema()` but **never ran the migrations**, so a brand-new tenant was missing
      `device_tokens`, `webauthn_credentials` and `users.mfa_*` until an unrelated sweep happened
      to fire — i.e. push notifications silently did not work for new tenants. It now runs
      `runTenantMigrations()` inline.
- [x] **A4.7** ✅ Added `runMasterMigrations()` (separate `master/` directory, names prefixed
      `master/` in `_migrations` so they can never collide with tenant migrations) and wired it
      into `migrate.ts` **before** the tenant sweep.
- [ ] **A4.8** ⚙️ **DEPLOY — verify the master migration and placement flow live.** Confirm
      `shards.primary` exists; create a throwaway tenant and verify `shard_id` populates; hard-delete
      it and verify the matching R2 prefix is gone.

**Verify after deploy:** deploy logs show `Master migration applied master/0001_shards_and_storage`;
`SELECT * FROM shards` returns the `primary` row; create a throwaway tenant → `shard_id` populates
→ delete it → the R2 prefix is gone.

---

## 🚀 Phase A Deploy Checklist

Everything below is a dashboard/CLI action that cannot be done from the repo.
**Follow in order** — step 1 is required for the app to boot at all.

### 1. Railway env vars (BLOCKING — app won't start without these)

App service → **Variables**:

| Variable | Value |
|---|---|
| `STORAGE_DRIVER` | `r2` |
| `R2_ACCOUNT_ID` | *(same value as the GitHub secret)* |
| `R2_ACCESS_KEY_ID` | *(same value as the GitHub secret)* |
| `R2_SECRET_ACCESS_KEY` | *(same value as the GitHub secret)* |
| `R2_UPLOADS_BUCKET` | `aino-uploads` |

Confirm the R2 API token has **Object Read & Write** on `aino-uploads`, and that the bucket has
**no public custom domain** (ADR-004 — it holds user content).

### 2. Copy existing objects (330 MB)

The key format is byte-identical to the old disk layout, so this is a straight copy — no
transformation. Run from any machine with the volume contents and `aws` CLI:

```bash
aws s3 sync ./uploads s3://aino-uploads/ \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com \
  --exclude ".*"
```

*(Only `default`-tenant data exists, so this is small and low-risk.)*

### 3. Deploy and watch the logs

Expect, in order:
```
Storage: using Cloudflare R2                      (bucket: aino-uploads)
Master migration applied                          master/0001_shards_and_storage
Migration runner: pre-squash DB detected — adopted catch-up migration without re-running it
```

### 4. Verify

- `GET /api/health?detail=true` → `{"expected":1,"minApplied":1,...}`
- Log in — existing tasks/chats/notes/retrospectives intact
- Upload an avatar, a chat image, an org logo → each renders
- DevTools → the `/uploads/...` request returns **302** to `r2.cloudflarestorage.com`
- `SELECT * FROM shards;` → one `primary` row

### 5. Delete the volume 🔥 *(this is what unblocks replicas)*

Railway → app service → **Settings → Volumes** → detach + delete `workpulse-volume`.
Keep it detached-but-undeleted for a week if you want a cheap rollback.

### 6. Prove it scales

Set replicas = 2. Upload a file on one instance, download it from the other.
*(Note: WebRTC calls across replicas still need **D1** — the signal buffers are
in-process until then.)*

### 7. Rotate the deferred secrets (A1.1–A1.3)

Postgres password, Firebase key `43a25c39…`, and disable `DATABASE_PUBLIC_URL`.
**Do this before onboarding the first real tenant.**

---

## Phase B — Safety Net

Prerequisite for the refactor phases. Smaller than usual because there is no production traffic to protect.

**Status:** ✅ **COMPLETE — B1 through B5 implemented and verified.**

- [x] **B1** ✅ **Route-snapshot test** — `platform/routeInventory.ts` walks the Express router
      stack; `__tests__/routes.snapshot.test.ts` snapshots **449 endpoints** across all 30 routers.
      🔴 **Express 5 removed `layer.regexp`**, and a matcher only accepts its exact mount path, so
      prefixes cannot be reverse-engineered. `instrumentExpress()` therefore records each mount at
      `use()` time (Express 5 also gives every Router its *own* `use`, so the factory is wrapped
      rather than a prototype).
      **Proven to work:** deleting the `/api/giphy` mount made the test fail with an exact diff.
- [x] **B2** ✅ `dependency-cruiser` v18 + `.dependency-cruiser.cjs` encoding the layering
      contract; `npm run lint:deps`. Errors: `no-circular`, `platform-is-independent`,
      `repository-no-express`, `no-cross-module-repository`, `not-to-dev-dep`.
      Warnings record the **10 route files that still import `db.ts` directly** — the exact Phase G
      worklist. Found 2 genuine pre-existing cycles (`migrationRunner ↔ tenantManager`,
      `status/broadcaster → ws → status`), excluded as documented debt so *new* cycles still fail.
- [x] **B3** ✅ Split CI into parallel `server` / `client` jobs (`mobile` was already separate).
      Wall-clock is now `max(server, client)` instead of the sum. Added the `lint:deps` step and
      fixed `docker-build`, which still referenced the deleted `lint-and-test` job.
- [x] **B4** ✅ Coverage wired up (`test:ci`, `test:coverage`, `collectCoverageFrom`,
      json-summary + lcov, uploaded as a CI artifact).

      **Baseline 2026-08-21 — statements 28% · branches 20.2% · functions 28.5% · lines 29.6%**

      | Area | Statements |
      |---|---|
      | `platform/` | **72.4%** |
      | `middleware/` | 65.3% |
      | `services/` | 60.4% |
      | `utils/` | 30.2% |
      | `routes/` | **22.9%** ← the 12,110-statement bulk Phase G targets |

- [x] **B5** ✅ Wrote `docs/adr/ADR-001..007` + an index README. Each records Context / Decision /
      Consequences / Alternatives, with the evidence that drove it.

**Verified:** `npm run lint:deps` exits 0 · route snapshot committed and proven to catch a dropped
route · coverage baseline recorded.

---

## Phase C — Decompose the Entrypoint

**Goal: `server/index.ts` 726 → under 60 lines. Zero behaviour change.**

**Status:** ✅ **COMPLETE — `index.ts` is 45 lines; `app.ts` is 61 lines; all C1–C7 done.**

```
server/
├── index.ts                    # pick role, delegate. ~40 lines
├── app.ts                      # buildApp() → express app, no listen()
├── bootstrap/
│   ├── env.ts                  # validate + freeze typed config
│   ├── crashHandlers.ts        # index.ts L32-41
│   ├── migrations.ts           # bootstrap() + advisory lock (E3)
│   └── shutdown.ts             # graceful shutdown, shared by all 3 roles
├── http/
│   ├── middleware/
│   │   ├── security.ts         # helmet + full CSP block (L96-160)
│   │   ├── cors.ts             # L179-210
│   │   ├── rateLimits.ts       # rlOpts + 7 limiters (L370-401)
│   │   ├── staticSpa.ts        # L165-177  (deleted in F3)
│   │   └── uploadServing.ts    # presign redirect (from A3.7)
│   ├── routes.ts               # ONE mountRoutes(app) — all 30+ app.use()
│   └── health.ts               # /healthz, /readyz, /api/health
└── roles/
    ├── web.ts  ·  realtime.ts  ·  worker.ts
```

- [x] **C1** ✅ Created `bootstrap/{env,crashHandlers,migrations,shutdown}.ts`. Environment loading
      runs before modules that capture `process.env`; handlers are idempotent; shutdown owns
      jobs → Redis → tenant pools → master-pool cleanup.
- [x] **C2** ✅ Created `http/middleware/{security,cors,rateLimits,staticSpa,uploads,errors}.ts`.
      Preserved ordering and CSP requirements for MediaPipe, Leaflet, GIPHY and draw.io; the
      tenant/org/chat upload-authorization boundary moved intact as one module.
- [x] **C3** ✅ Created `http/routes.ts` as the complete route map. Webhooks have a dedicated
      pre-CSRF mount; all normal API mounts are centralized in their original order.
- [x] **C4** ✅ Moved `autoClockOut`, `autoClockOutForDb`, `autoClockOutUser` and `cleanupTokens`
      to `services/attendance/autoClockOut.ts`. Roles/jobs no longer import HTTP composition for
      attendance business logic.
- [x] **C5** ✅ Created `app.ts` with `buildApp()` (61 lines), returning a fresh Express app and
      never listening. A compatibility singleton remains for the existing Supertest suites.
- [x] **C6** ✅ Created `roles/{all,web,realtime,worker,index}.ts`; `index.ts` dispatches on
      `ROLE`. `ROLE=all` remains the default. Phase D subsequently enabled the split roles;
      Railway staging validation remains D5.
- [x] **C7** ✅ Converted all touched route and middleware dependencies in `app.ts` and
      `http/routes.ts` to imports. The single documented exception is `routes/giphy.ts`, which
      still uses raw `module.exports` and therefore has no TypeScript default export. Lifecycle
      modules intentionally keep lazy `require()` where it prevents early env evaluation or a
      documented circular import.

**Verified:** Phase C route snapshot unchanged (**449 endpoints**) · middleware-order tests prove webhook
CSRF exemption and normal CSRF enforcement · role-dispatch tests pass · **58 suites / 752 tests**
pass · typecheck clean · dependency-cruiser 0 errors · build + SQL asset checks pass ·
`index.ts` **45 lines** (<60) · `app.ts` **61 lines**.

---

## Phase D — Stateless + Role Split 🚀 *unlocks replicas*

### D1 — Redis-backed WebRTC signal store 🔴 CRITICAL

**Status:** ✅ **IMPLEMENTED AND TESTED; cross-replica staging soak remains D5.**

Without this, a caller on instance A and a callee on instance B **never connect** — the buffered
SDP offer lives in a local `Map` and is never replayed. It fails *silently*.

`sendToUser` already fans out via Redis `ws:broadcast` (`ws.ts:3884`) — the **buffers** do not.

- [x] **D1.1** ✅ Created `realtime/signalStore.ts`: tenant-scoped Redis keys, 60s TTL,
      atomic Lua append/drain, latest-offer replacement, bounded ordered ICE and exactly-once drain.
- [x] **D1.2** ✅ Removed `_callSignalBuffers`; every call buffer/replay/terminal clear now uses
      Redis with `tenantId` in the key.
- [x] **D1.3** ✅ Removed `_meetingSignalBuffers`; per-target/per-sender mesh offers and ICE now
      drain atomically from Redis.
- [x] **D1.4** ✅ Added `meetingLeaveStore.ts`: local timers use token-owned Redis leases, so a
      rejoin on replica B cancels cleanup scheduled on replica A.
- [x] **D1.5** ✅ Removed `_membershipCache`; `membershipCache.ts` provides tenant-scoped Redis
      membership decisions with a 10s local L1. DB errors still fail closed.
- [x] **D1.6** ✅ Local Maps exist only inside the adapters as non-production L1/development
      fallback. Redis is the production source of truth. `ws.ts` contains zero call/meeting/
      membership state Maps.

### D2 — Role split

**Status:** ✅ **IMPLEMENTED; Railway service creation and two-replica verification remain D5.**

- [x] **D2.1** ✅ `ROLE=web`: bootstrap + HTTP only; never imports/starts jobs or WS.
- [x] **D2.2** ✅ `ROLE=realtime`: bootstrap + HTTP upgrade + awaited Redis Pub/Sub subscription
      + WS + collaboration; no background workers.
- [x] **D2.3** ✅ `ROLE=worker`: bootstrap + awaited `initJobs()` + tiny `/healthz`/`/readyz`
      probe server; no application API or WS listener.
- [x] **D2.4** ✅ Production refuses `setInterval` fallback. Development fallback runs only in
      `worker|all`; when Redis exists it requires a token-owned, renewing Redis leader lease.

### D3 — Redis mandatory in production

**Status:** ✅ **COMPLETE.**

- [x] **D3.1** ✅ `validateEnvironment()` hard-fails when production lacks `REDIS_URL`.
      `initRedis()` is now awaitable and PINGs command + subscriber connections before bootstrap
      completes.
- [x] **D3.2** ✅ `attachFailFast` logs fatal and exits after repeated production connection loss;
      development keeps the graceful fallback. WS Pub/Sub now subscribes only after readiness.

### D4 — Health + proxy correctness

**Status:** ✅ **COMPLETE — D4.1–D4.5 done; `/readyz` is enforced as config-as-code.**

- [x] **D4.1** ✅ `GET /healthz` is dependency-free and reports role/time.
- [x] **D4.2** ✅ `GET /readyz` checks master DB + Redis PING and requires Pub/Sub readiness for
      realtime/all roles. Worker readiness also checks initialized jobs.
- [x] **D4.3** ✅ Removed the O(tenants) detail sweep from public health; moved it to authenticated
      `GET /api/internal/migration-status` (platform-admin only).
- [x] **D4.4** ✅ `trust proxy` changed from 1 to 2 for Cloudflare + Railway.
- [x] **D4.5** ✅ Health check points at `/readyz` **as config-as-code**: `railway.json`
      declares `"healthcheckPath": "/readyz"` (plus `preDeployCommand: node migrate.js`,
      `overlapSeconds: 30`, `drainingSeconds: 15`), and `scripts/verify-railway-config.mjs`
      **fails CI** if that ever regresses. Because the file is in the repo, every service cloned
      from it inherits the setting — no dashboard step, and no per-service drift.
      ⚙️ Still confirm in the dashboard that no service carries a **manual override** of the
      health-check path, since a dashboard value wins over `railway.json`.

### D5 — Gate 🔴 DO NOT SKIP

- [ ] **D5.1** Staging at 2 replicas: place a call between two users pinned to **different**
      instances — media must connect.
- [ ] **D5.2** Upload a file on instance A, download it from instance B.
- [ ] **D5.3** Confirm scheduled jobs fire **exactly once** across all replicas.

### Phase D Railway staging checklist

1. Create/clone three services from the same image:
   - `aino-web`: `ROLE=web`
   - `aino-realtime`: `ROLE=realtime`
   - `aino-worker`: `ROLE=worker`
   - Keep the current service at `ROLE=all` until the split passes.
2. Every service must have `REDIS_URL`; production now refuses to boot without it.
3. Point Railway health checks to `/readyz`; liveness monitoring may use `/healthz`.
4. Confirm `/readyz` reports DB + Redis; realtime additionally reports subscriber readiness;
   worker reports jobs readiness.
5. Scale realtime to 2 replicas. Pin caller/callee to different instances and verify:
   offer-first replay, ICE delivery, reconnect within 15s, no false meeting-leave event.
6. Scale worker to 2. Confirm each BullMQ repeatable job fires once, not once per replica.
7. Scale web to 2. Upload on one instance and download through another (also closes A3.9/D5.2).
8. Only after all checks pass, retire `ROLE=all` and mark D4.5/D5 complete.

---

## Phase E — PgBouncer & DB Scaling

**Status:** 🟡 **REPOSITORY COMPLETE; PGBOUNCER PROVISIONING AND LIVE VERIFICATION PENDING.**

- [ ] **E1.1** Deploy PgBouncer as a Railway service (`edoburu/pgbouncer`), **transaction mode**.
- [x] **E1.2** ✅ Transaction-mode compatibility audit complete: no `LISTEN/NOTIFY`, temporary
      tables, SQL `PREPARE/DEALLOCATE`, or session-level `SET`. Existing advisory locks are
      `pg_advisory_xact_lock` inside explicit transactions; `pg` uses unnamed prepares.
- [x] **E1.3** ✅ App pools shrunk: configurable `MASTER_POOL_SIZE` default 4;
      `TENANT_POOL_SIZE` default 3.
      PgBouncer holds the real server-side connections (`default_pool_size ≈ 20`).
- [x] **E2.1** ✅ Raised `TENANT_MAX_POOLS 10 → 100` — removes the hard growth
      wall where every request past tenant #11 evicts a pool.
- [x] **E2.2** ✅ Added pool hits/misses/hit-rate, evictions, busy evictions, peak pool count and
      total/per-pool waiting gauges; exposed at authenticated `/api/internal/db-pool-stats`.
      **Alert if eviction rate > 0 in steady state** — that is the thrash signal.
- [x] **E3.1** ✅ Wrapped per-tenant migrations in a transaction-scoped
      `pg_advisory_xact_lock(hashtext(...))` on the SAME pool client as the DDL. Fail-fast mode
      propagates migration errors so the transaction rolls back rather than committing partial DDL.
- [ ] **E3.2** **Better:** move migrations out of `bootstrap()` into a Railway **pre-deploy
      command** so app pods never run DDL. Keep the advisory lock as belt-and-braces.
      ✅ Repository support is ready: `migrate.ts` prefers `DIRECT_DATABASE_URL` when set;
      Railway pre-deploy configuration remains pending.
- [x] **E4** ✅ `forEachTenant` now uses tested `platform/forEachBounded()` with configurable
      `TENANT_FOREACH_CONCURRENCY` default 5.
- [ ] **E5** *(defer until needed)* `DATABASE_REPLICA_URL` + a `readQuery()` on the repository
      layer for `/api/export`, `/api/search`, and admin dashboards.
      Cheap **because** Phase G centralises SQL into repositories.

**Verify:** total Postgres connections stay flat as replicas scale · boot sweep time drops ~5×.

**PgBouncer deployment assets:** `infra/pgbouncer/{Dockerfile,README.md}` plus the safe dry-run/apply
script `scripts/setup-pgbouncer-railway.ps1`. Railway inspection confirms no PgBouncer service
exists yet; the pinned image manifest is reachable. Do not mark E1.1/E3.2 complete until staging
traffic passes through it and direct migration connectivity is configured.

**Repository verification:** `MASTER_POOL_SIZE=4`, tenant pool `3`, cache `100`, bounded concurrency
`5`; authenticated pool metrics; tenant + master transaction-scoped advisory locks; direct
migration URL support; PgBouncer image manifest reachable; typecheck/lint/build pass; **65 suites /
775 tests pass**.

---

## Phase F — Cloudflare Routing & Load Balancing

**Status:** 🟡 **REPOSITORY READY; CLOUDFLARE/RAILWAY CUTOVER PENDING.**

- [ ] **F1** Split the Railway service into `aino-web` / `aino-realtime` / `aino-worker`
      (same repo + Dockerfile, differing only by `ROLE`).
- [x] **F1a** ✅ Added safe dry-run/apply helper `scripts/setup-railway-roles.ps1`; it creates the
      three services and sets only non-secret role variables. Shared secrets/domains remain a
      deliberate dashboard step.
- [ ] **F2** Cloudflare path rules:
      `/api/*`, `/uploads/*` → web · `/ws`, `/collab` → realtime ·
      everything else → public SPA R2 origin. **Private uploads never route directly to public R2.**
- [x] **F2a** ✅ Added tested `infra/cloudflare/` Worker router with `legacy` instant-rollback mode,
      `split` routing, WebSocket pass-through, origin recursion protection and cache headers.
      Fixed collaboration auth to use the HttpOnly upgrade cookie (the client can never read it)
      and added the same cross-site WebSocket origin checks used by `/ws`.
- [x] **F3a** ✅ Added manual `.github/workflows/web-release.yml`: builds and tests the client,
      verifies every `index.html` reference, uploads immutable assets first, and promotes
      `manifest.json`/`sw.js`/`index.html` last. Uses a separate public `R2_WEB_BUCKET`.
- [x] **F3b** ✅ Added `SERVE_SPA=false` cutover flag. Express static/fallback remains available
      as rollback until the live Cloudflare/R2 soak passes; deleting the code is intentionally
      deferred to a cleanup release.
- [ ] **F3c** ⚙️ **DEPLOY — create/configure the public SPA bucket/domain, publish the first SPA,
      set `SERVE_SPA=false`, and verify the Worker serves all client routes.**
- [ ] **F4** Cloudflare WAF + edge rate limiting (fires *before* your app limiters).
- [x] **F5a** ✅ Repository cache policy: Worker marks hashed/static asset paths immutable 1y;
      `index.html`, `sw.js`, manifest no-store. Service worker is now network-first for navigation,
      cache-first only for hashed `/assets/*`, and never caches API/uploads/WS/collab.
- [ ] **F5b** ⚙️ **DEPLOY — attach the SPA custom domain and confirm `cf-cache-status: HIT` for
      hashed assets while HTML/SW remain no-cache.**
- [ ] **F6** Set replica counts and scaling signals:

| Pool | Policy | Scale on | Notes |
|---|---|---|---|
| `web` | round-robin | CPU > 60% or p95 latency | Stateless after D → scale freely |
| `realtime` | session affinity | WS conns/pod (cap ~5k) | Drain slowly on deploy |
| `worker` | n/a | BullMQ queue depth | Scale on backlog, not CPU |

**Verify:** `/assets/*` served by Cloudflare (`cf-cache-status: HIT`) ·
WS reconnects survive a web-pod restart.

**Repository verification:** edge router **8/8 tests**; collaboration cookie/origin **4/4 tests**;
client **21 files / 167 tests**; server **66 suites / 779 tests**; client/server typecheck pass;
client build + `verify-spa-build.mjs` pass; CI/workflow files contain no tabs; Railway role script
dry-run passes.

---

## Phase G — Feature Modules *(rolling)*

**Status:** 🟡 **IN PROGRESS — first attendance slice migrated and verified.**

Adopt the pattern already proven in `services/status/`:

```
server/modules/<feature>/
├── <feature>.routes.ts       # HTTP only: validate → service → respond
├── <feature>.service.ts      # business rules, orchestration, transactions
├── <feature>.repository.ts   # ALL SQL for this feature
├── <feature>.schema.ts       # zod request/response schemas
├── README.md                 # what it owns + its boundaries
└── __tests__/
```

**The layering law** (dep-cruiser; escalate warn → error as each module lands):

```
routes → service → repository → db
```

- Route files may **not** contain SQL
- Repositories may **not** import express, `req`, or `res`
- Module A may **not** import module B's *repository* — only B's *service*
- Shared primitives live in `platform/`

**Migration order — one module per PR, highest pain first:**

- [ ] **G1** `chat` — **4,473 L / 51 routes / 333 SQL**. Split into `messages`, `conversations`,
      `media`, `reactions`
- [ ] **G2** `realtime/ws` — **3,782 L** → `server.ts`, `registry.ts`, `fanout.ts`,
      `signalStore.ts` (from D1), `handlers/{chat,calls,meetings,presence,status}.ts`
- [ ] **G3** `tenancy` — 1,844 L / 37 routes
- [ ] **G4** `attendance` (tracker) — incremental migration in progress.
      - [x] **G4.1** ✅ Created `modules/attendance/{routes,service,repository,schema,types}.ts`
        plus README and module tests. Moved overtime request/list, theme get/update, weekly,
        task-summary, history and analytics (**8 routes**) behind route → service → repository
        layers; public `/api/tracker/*` paths unchanged.
      - [x] **G4.2** ✅ Moved status and widgets into the attendance service/repository, including
        target-triggered atomic auto-clock-out, local-day aggregation, leave/punctuality metrics,
        and audit handoff. Also moved manual-request listing plus date entry read/guarded delete.
        All **13 read/adjacent routes** now live in the module; `tracker.ts` reduced
        **1,621 → 1,023 lines**.
      - [ ] **G4.3** Move clock-in/out/break write workflows and verification policy.
        - [x] **G4.3a** ✅ Moved break start/end transactions into repository/service layers.
      - [ ] **G4.4** Move manual-entry CRUD and remove the tracker grandfather exception.
        - [x] **G4.4a** ✅ Extracted shared create/edit validation, break normalization, timezone
          conversion and work-mode normalization into `attendance.schema.ts`; both legacy write
          handlers now use the same tested schema. Tracker reduced further to **~925 lines**.
- [ ] **G5** `admin` — 1,403 L / 37 routes. **Split platform-admin vs tenant-admin**
      (conflated today)
- [ ] **G6** `db.ts` (2,166 L) — move `initTenantSchema()` into `platform/db/schema/*.sql`
- [ ] **G7** Reorganise `utils/` (35 files) by responsibility:

| New home | Moved from `utils/` |
|---|---|
| `platform/logging/` | `logger.ts` |
| `platform/security/` | `password.ts`, `encryption.ts`, `cookie.ts` |
| `platform/db/` | `tenantManager.ts`, `migrationRunner.ts` |
| `platform/mail/` | `mailer.ts` |
| `platform/audit/` | `audit.ts`, `platformAudit.ts` |
| `platform/storage/` | `uploadPath.ts` *(already moved in A3)* |
| `realtime/` | `ws.ts`, `wsHandlers/`, `wsIdempotency.ts`, `wsValidate.ts`, `wsMetrics.ts`, `collaboration.ts`, `coturn.ts`, `hlsBroadcast.ts` |
| `domain/time/` | `timeCalc.ts`, `timezone.ts`, `workDays.ts`, `attendance.ts` |
| `domain/approvals/` | `approver.ts`, `impersonationApproval.ts` |
| `domain/billing/` | `planCatalog.ts` |

- [ ] **G8** Remaining routers: leaves, notes, calendar, meetings, projects, …

**Verify per PR:** `routes.snap` unchanged · dep-cruiser clean for that module · `README.md` written

---

## Phase H — Observability *(start during C, run continuously)*

**Status:** ✅ **REPOSITORY COMPLETE — H1–H6 implemented and tested.**
Live Prometheus/collector wiring is a deploy step (see the pre-push runbook).

All app-side code lives in `server/platform/metrics/`; all external
configuration lives in `infra/observability/`.

- [x] **H1** ✅ `prom-client` `/metrics` on **all three roles** — web/realtime via `app.ts`,
      worker via its probe server (the worker owns queue depth and job duration, so it must be
      scrapable even though it serves no application traffic).
      🔒 **Token-guarded and fail-closed:** requires `Authorization: Bearer $METRICS_TOKEN`;
      with no token set it is **disabled in production** and open in development. Unauthorized
      requests get **404, not 401**, so a caller cannot confirm the endpoint exists.
      Default labels `role` + `instance_id` on every series.
- [x] **H2** ✅ Implemented every metric in the original list, plus job outcome:
      `aino_http_request_duration_seconds` (**by route TEMPLATE**, never the raw URL) ·
      `aino_http_requests_total` by `status_class` · `aino_db_pool_connections{state}` ·
      `aino_db_tenant_pools` · `aino_db_pool_evictions_total{kind}` · `aino_db_pool_hit_rate` ·
      `aino_queue_depth{queue,state}` · `aino_job_duration_seconds` · `aino_job_runs_total` ·
      `aino_ws_connections` · `aino_redis_up{connection}` · `aino_redis_keyspace_hit_rate`.
      Gauges are scrape-time `collect()` callbacks, not timers, so an unscraped replica does no
      work. **Queue depth is read with ONE pipelined command on the shared Redis client** —
      instantiating seven `Queue` objects to observe them would undo Phase E's connection budget.
- [x] **H3** ✅ `platform/metrics/tenantLabel.ts` — top-N (default 20) plus one `other` bucket,
      recomputed every 60s from a **decaying** counter so a burst cannot pin a tenant and cold
      tenants are evicted from the bookkeeping map. `master` is always its own label. Applied
      **only** to the HTTP histogram. See **ADR-008**.
      🔴 A test caught a real bug here: the initial `lastRefresh = 0` made the *first* observation
      look like the refresh window had elapsed, promoting a brand-new tenant on sight — exactly the
      unbounded behaviour the module exists to prevent.
- [x] **H4** ✅ Opt-in OpenTelemetry (`platform/metrics/tracing.ts`), enabled only when
      `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local dev and CI pay nothing. Auto-instruments
      HTTP/Express/`pg`/`ioredis` and adds `request.id` (same value as `x-request-id` and the pino
      `reqId`, so a log pivots to its trace), a **bucketed** `tenant_id`, and `enduser.id`.
      `/healthz`, `/readyz` and `/metrics` are excluded — they fire constantly on every replica.
      Spans are flushed in `bootstrap/shutdown.ts`.
- [x] **H5** ✅ `infra/observability/alerts.yml` — **10 rules in 6 groups** covering availability,
      latency, database, workers, realtime and schema drift. Includes every alert the plan asked for:
      p95 latency · readiness/`up` failures · pool `waiting > 0` · queue-depth growth
      (`deriv() > 0`) · migration drift.
      Drift needs a gauge, so `migrationMetrics.ts` samples it — **on the worker role only**, every
      5 minutes, because that sweep is O(tenants) and D4.3 deliberately removed it from `/readyz`.
- [x] **H6** ✅ `infra/observability/k6/load-test.js` — ramped 100 tenants × 50 VUs with a hold at
      peak (pool eviction and backlog only appear in steady state). Its thresholds **mirror the H5
      alert rules**, so a passing run means the same conditions would not have paged.
      **Run after each phase.**

**Verify:** `curl -H "Authorization: Bearer $METRICS_TOKEN" https://<host>/metrics` returns the
exposition body on all three roles · `aino_db_pool_evictions_total` and
`aino_db_pool_connections{state="waiting"}` stay flat under k6 load.

**Repository verification:** typecheck clean · build ships `dist/platform/metrics/*` ·
**73 suites / 838 tests pass** (+25 new: 8 tenant-label, 5 endpoint/auth, 5 HTTP-cardinality,
7 job/queue) · route snapshot updated with exactly **one** intentional addition (`GET /metrics`),
zero removals · dependency lint 0 errors.

---

## Guardrails

Stop the rot from coming back.

- [x] **GR1** ✅ Enforced in CI as an **error**, in two halves because one tool cannot do both:
      - **Imports** (dependency-cruiser): added 4 error rules scoped to migrated modules —
        `module-routes-no-direct-db`, `module-service-no-direct-db`, `module-routes-no-repository`
        (routes may not skip the service layer) and `module-repository-no-service` (layers point
        one way only). Cross-module repository imports were already an error.
        Also **widened `lint:deps`** to cruise `app.ts`, `roles`, `bootstrap`, `http`, `modules` and
        `realtime`, which were previously not linted at all. Still **0 errors**.
      - **SQL text** (`scripts/check-no-sql-in-routes.mjs`): dependency-cruiser reasons about
        imports and cannot see a SQL string literal. Migrated `modules/**` routes must be clean;
        legacy `routes/**` debt is pinned per file in `scripts/sql-in-routes-baseline.json`
        (**1,156 lines across 48 files**) and may only **shrink**, like the GR2 ratchet.
      **Proven:** adding `SELECT id FROM users` to `attendance.routes.ts` failed the guard; the
      legacy warn rules still list the 10 route files Phase G has left to migrate.
- [x] **GR2** ✅ File-size ratchet in CI fails any new `.ts` over **600 lines**. Current oversized
      files are pinned to exact ceilings in `scripts/check-server-file-sizes.mjs`; their allowlist
      may only shrink as Phase G splits them.
- [x] **GR3** ✅ CI requires `README.md` in every first-level `server/modules/*` directory.
      The guard is active now and will enforce table ownership + public service boundaries as
      Phase G creates modules.
- [x] **GR4** ✅ Route-snapshot test is permanent and enforced in CI. It snapshots **453
      endpoints** and was manually proven to fail with an exact diff when `/api/giphy` was removed.
- [x] **GR5** ✅ **Statelessness enforced in CI**, in two halves:
      - **Dynamic** — `__tests__/statelessness.crossInstance.test.ts` (**8 tests**). Each "replica"
        is loaded in its own `jest.isolateModules` registry, so their module-level Maps are
        genuinely separate objects, exactly like two processes; they share only one fake Redis.
        State in Redis is therefore visible across instances and state in a `Map` is not.
        Covers: offer-first call replay A→B, ordered exactly-once ICE, per-sender meeting mesh
        offers, tenant isolation on a shared call id, meeting-leave lease cancelled on B for a
        timer scheduled on A, shared membership decisions, **upload on A / download on B**, and the
        A3.11 production local-disk boot guard.
        🔴 **Chose this over booting two real containers**: it needs no Docker, Redis or network in
        CI, runs in ~1s, and catches the identical class of bug.
      - **Static** — `scripts/check-statelessness.mjs` greps the realtime layer for module-level
        `Map`/`Set` state and asserts `_callSignalBuffers` / `_meetingSignalBuffers` /
        `_membershipCache` never return. Legitimately-local state (the socket registry, `setTimeout`
        handles, Redis-backed L1 caches) is allowlisted **with written justification**.
      **Both proven by negative test:** forcing `signalStore` back to in-process Maps failed exactly
      the 4 cross-replica tests; adding a `_callSignalBuffers` Map failed the static guard.
- [x] **GR6** ✅ `docs/adr/ADR-001..008` plus `docs/adr/README.md` committed for every locked
      architectural decision made so far. New decisions must add or supersede an ADR.
      **ADR-008** (2026-08-27) records the Phase H choices: bounded metric cardinality and
      fail-closed `/metrics` access.
- [x] **GR7** ✅ `ARCHITECTURE.md`, README stack tables, environment examples and the governing
      constitution were updated alongside Phases A–F. Future phase PRs must keep doing this.
- [x] **GR8** ✅ Generated Graphify outputs were removed from all five locations (85 tracked
      files), recursively gitignored/Docker-ignored, and guarded by the dependency-free
      `npm run check:generated` CI job. A forced tracked probe was proven to fail the guard.

---

## Rollback Playbook

| Phase | Rollback |
|---|---|
| A1 | Secrets are additive — re-add if something breaks |
| A2 | Restore the A2.3 `default` dump. **Master untouched**, so login always works |
| A3 | `STORAGE_DRIVER=local` + re-attach the volume. Keep it detached-but-undeleted for 1 week |
| A4 | Columns are nullable/defaulted — no rollback needed |
| C | Pure code moves — `git revert` the PR |
| D1 | Feature-flag `SIGNAL_STORE=memory\|redis` |
| D2 | Set every service back to `ROLE=all` (keep the legacy combined path for one release) |
| E1 | Point `DATABASE_URL` back at Postgres directly and restore the pool sizes |
| F3 | Re-enable `express.static` (keep the code behind a flag for one release) |
| H | Unset `METRICS_TOKEN` to darken `/metrics`; unset `OTEL_EXPORTER_OTLP_ENDPOINT` to stop tracing. Both are additive and neither affects request handling |

---

## Known Limits Out of Scope

- **WebRTC mesh ceiling.** Meetings use a mesh (`useMeetingMesh.ts`, `meeting_subscribe` fan-out) —
  O(n²) connections, unusable past ~6 participants **regardless of backend scaling**. Cloudflare
  TURN handles relay fine. When 10+ participants are needed, add a **LiveKit/mediasoup SFU** as a
  separate service. Not urgent, and not fixable by any work in this plan.

---

## Progress Log

Append an entry per work session. Newest at the top.

| Date | Phase/Task | What changed | Verified by |
|---|---|---|---|
| 2026-08-27 | **PRE-PUSH RUNBOOK** | Added the ordered **Pre-Push & Deployment Runbook** at the top of this document. Documents the trigger chain and calls out that **CI does not gate the Railway deploy** — both watch `master` independently, so a red CI run does not stop a deploy. Collapses every remaining unchecked task from Phases A/D/E/F into 9 ordered steps with ~40 `P*` checkboxes, a "Step 0 is blocking" warning (the app cannot boot without the R2 vars, and pushing *is* deploying), and a symptom→action rollback table. Added the Phase H variables to `docs/RAILWAY_DEPLOYMENT.md` and `docker-compose.yml`. | Runbook cross-checked against every `[ ]` remaining in the plan; `verify-railway-config.mjs` confirms the documented trigger chain matches `railway.json` |
| 2026-08-27 | **GR1 + GR5 COMPLETE** | **GR5:** statelessness enforced two ways. Dynamic — `statelessness.crossInstance.test.ts` runs each "replica" in its own `jest.isolateModules` registry sharing one fake Redis, so Redis-backed state crosses the boundary and a `Map` cannot (**8 tests**: call replay, ordered exactly-once ICE, mesh offers, tenant isolation, leave-lease cancel A→B, membership, upload A→download B, prod local-disk guard). Chose this over booting two containers: no Docker/Redis/network, ~1s, same bug class. Static — `check-statelessness.mjs` greps for module-level state and pins the Phase D removals, with justified allowlist entries. **GR1:** 4 new dep-cruiser **error** rules for migrated modules; `lint:deps` widened to also cruise `app.ts`/`roles`/`bootstrap`/`http`/`modules`/`realtime`; plus `check-no-sql-in-routes.mjs`, since dep-cruiser cannot see SQL literals — modules clean, legacy debt pinned at **1,156 lines / 48 files**, shrink-only. Added `npm run check:guardrails`. | **Negative-tested both:** reverting `signalStore` to Maps failed exactly the 4 cross-replica tests; a `_callSignalBuffers` Map failed the static guard; SQL added to `attendance.routes.ts` failed the SQL guard · `lint:deps` **0 errors** on the wider surface |
| 2026-08-27 | **H COMPLETE** | Phase H implemented in `server/platform/metrics/` + `infra/observability/`. `/metrics` on all 3 roles, **fail-closed** (bearer token; 404 not 401; disabled in prod when unset). 15 custom metric families: HTTP duration **by route template**, pool gauges/evictions/hit-rate, queue depth, job duration+outcome, WS connections, Redis health/hit-rate, migration drift. Gauges are scrape-time callbacks, and queue depth uses **one pipelined command on the shared client** so Phase E's connection budget is untouched. H3 top-N tenant labels (ADR-008). H4 opt-in OTel with `request.id` + bucketed `tenant_id`. H5 10 alert rules. H6 k6 test whose thresholds mirror the alerts. Drift sampling is **worker-only** to avoid re-adding the O(tenants) sweep D4.3 removed. Also shrank `jobs.ts` 878→870 and tightened its ratchet. | 🔴 A test caught a real bug: `lastRefresh = 0` promoted a brand-new tenant on first sight — the exact cardinality bomb H3 exists to prevent · typecheck clean · **73 suites / 838 tests** (+25) · route snapshot **+1 intentional** (`GET /metrics`), 0 removals · build ships `dist/platform/metrics/*` |
| 2026-08-21 | **G4.1–G4.2 attendance reads** | Created attendance module layers + README. Extracted 13 routes: overtime request/list, theme get/update, weekly, task-summary, history, analytics, status, widgets, break start/end, manual-request list and date entry read/delete. All module SQL is in repository; service owns aggregation/transactions/orchestration; route owns HTTP/audit. `tracker.ts` 1,621 → 1,023 lines. | route snapshot unchanged · tracker + module tests **49/49** · dep lint 0 attendance violations |
| 2026-08-21 | **Repository hygiene** | Removed 85 tracked generated `graphify-out` files across root/client/desktop/mobile/server. Added recursive ignore rules, Docker exclusion and CI tracked-file guard. | present tracked artifacts **0** · present graphify dirs **0** · negative forced-add test fails · clean guard passes |
| 2026-08-21 | **F REPOSITORY READY** | Added tested Cloudflare Worker with `legacy` rollback and corrected split routing (`/uploads` stays on authenticated web). Added atomic SPA-to-R2 workflow (assets first, shell last), build verifier, safe network-first SW, `SERVE_SPA` rollback flag, local `/collab` proxy, Railway role dry-run helper. Fixed collaboration auth to use HttpOnly cookie and added Origin validation. | Edge **8/8** · collaboration **4/4** · client **21/167** · server **66/779** · SPA verifier PASS |
| 2026-08-21 | **E REPOSITORY COMPLETE** | PgBouncer transaction-mode audit passed (no LISTEN/NOTIFY/temp tables/named prepares/session SET; locks are transaction-scoped). Master pool default 4; tenant pool 3; cache 100. Added hit/miss/eviction/wait metrics + authenticated endpoint, bounded fan-out=5, tenant/master advisory locks on one client, `DIRECT_DATABASE_URL` migration path, PgBouncer Docker/README and safe Railway dry-run script. | PgBouncer image manifest reachable · typecheck/lint/build PASS · **65 suites / 775 tests** |
| 2026-08-21 | **D IMPLEMENTATION COMPLETE** | Realtime reliable-delivery state moved from process Maps to tenant-scoped Redis: atomic Lua call/meeting append+drain, Redis membership cache with L1, distributed meeting-leave leases. Redis startup is awaited and mandatory in prod; Pub/Sub subscription is awaited. Split web/realtime/worker roles enabled; worker has probes. Production interval fallback prohibited; dev fallback uses a token-owned leader lease. Added `/healthz`, `/readyz`, authenticated migration-status; proxy trust=2. | zero `_callSignalBuffers`/`_meetingSignalBuffers`/`_membershipCache` · typecheck/lint/build PASS · **63 suites / 767 tests** · route snapshot now **452 endpoints** (+3 intentional) |
| 2026-08-21 | **C COMPLETE** | `index.ts` **776 → 45 lines** and `app.ts` is a 61-line composition root. Extracted bootstrap/env/crash/shutdown, all HTTP middleware, centralized route map, health, attendance jobs and five process-role modules. `ROLE=all` preserves current behavior; split roles are scaffolded but gated until D. Added role-dispatch and middleware-order tests. | route snapshot unchanged (**449 endpoints**) · typecheck clean · dependency lint 0 errors · build PASS · **58 suites / 752 tests** |
| 2026-08-21 | **B COMPLETE** | Safety net in place. **Route snapshot locks 449 endpoints** — required writing `platform/routeInventory.ts` with `instrumentExpress()`, because Express 5 removed `layer.regexp` and matchers only accept their exact mount path, so prefixes are otherwise unrecoverable. Verified by deleting `/api/giphy` and watching CI diff it. dependency-cruiser encodes the layering contract (5 error rules; 10 warnings = the Phase G worklist; 2 pre-existing cycles documented as debt). CI split server/client — also fixed `docker-build`, which still pointed at the deleted `lint-and-test` job. Coverage baseline captured. 7 ADRs written. | `typecheck` clean · `lint:deps` exit 0 · **56 suites / 743 tests** · coverage 28% stmts / 20.2% br |
| 2026-08-21 | **A3 + A4 IMPLEMENTATION COMPLETE** | Uploads → R2. New `platform/storage/` (types/keys/r2Adapter/localAdapter/factory). **4** `diskStorage` sites converted (plan said 3 — `tasks/comments.ts` was missed) plus 3 filesystem readers (`public.ts`, `chatMediaPipeline.ts`, 6 `fs.unlink` sites). `/uploads` now presign+302. Boot guard rejects `STORAGE_DRIVER=local` in prod. Volume dependency removed from Dockerfile/entrypoint; **live R2 copy, smoke test, volume detach and shard verification remain unchecked deploy tasks**. A4: `shards` table + `pickShard()` + `tenants.storage_bucket` + `deletePrefix` on tenant delete + `runMasterMigrations()`. 🔴 Also fixed: `createTenant()` never ran migrations, so new tenants silently lacked push/biometric/MFA tables. | `typecheck` clean · **55 suites / 739 tests** (+47) · 0 `diskStorage`/`UPLOADS_ROOT`/`getUploadDir` in tree · build ships both migration dirs |
| 2026-08-21 | **A2 COMPLETE** | Squash shipped, deploy-driven. `0002_migration_catchup.sql` (170 stmts) generated from source — no DB access needed. `migrationRunner.ts` **1,668 → 331 lines**. **Legacy-adoption guard** added so the existing `default` DB records the catch-up *without executing it* (the file drops+recreates `sprint_retrospectives` — would have destroyed live data). `copy-sql-assets.mjs` makes the build ship `.sql` or fail. 2 CI guards added. | `npm run typecheck` clean · migration suite + full suite pass; latest full run **56 suites / 743 tests** · build ships SQL · Docker path simulated |
| 2026-08-21 | **A1.4** | ✅ Verified `.env` git-ignored (`.gitignore:57`) and never committed (0 commits). A1.1–A1.3 deferred to post-deploy per owner. | `git check-ignore -v .env`, `git log --all -- .env` |
| 2026-08-21 | **A2 discovery (resolved)** | 🔴 Discovered `initTenantSchema()` was incomplete — 26 of 143 migration DDL objects existed ONLY in `MIGRATIONS[]`. The initial `pg_dump` plan was superseded: the completed implementation generates the catch-up from the migration source, verifies all 26 objects, and uses in-place legacy adoption. | `node scripts/analyze-migration-coverage.mjs`; `node scripts/a2-verify-baseline.mjs` PASS |
| 2026-08-21 | **A2 optional backup tooling** | Added `scripts/a2-dump-databases.sh` and `.github/workflows/a2-database-dump.yml` as optional read-only backup tooling. They are not required by the completed migration-squash deployment. | Structural lint: 6 if/6 fi, 2 for/2 done, even quotes, no tabs in YAML |
| 2026-08-21 | **A2 network block (resolved)** | The workstation allowed HTTPS/443 only, so direct `pg_dump`/SSH was unavailable. Resolved by making the implementation fully deploy-driven and generating the catch-up from source; no live DB connection is needed to build or test it. | Generated SQL + 29 migration tests + Docker asset verification |
| 2026-08-21 | — | Plan created. Baseline captured: 0 customer tenants, 30 migrations, Redis live, 330 MB volume. Confirmed the platform admin lives in the **master DB** (`db.ts:211`, `auth.ts:159`) → A2 is safe. | `railway status`, `/api/health?detail=true` |

---

## Quick Reference — Verified Line Numbers

Snapshot taken 2026-08-21. Re-check after each phase.

| What | Where |
|---|---|
| Entrypoint (726 L) | `server/index.ts` |
| Crash handlers | `index.ts:32-41` |
| Helmet + CSP | `index.ts:96-160` |
| `express.static` SPA | `index.ts:165-177` |
| CORS | `index.ts:179-210` |
| `/uploads` auth serving | `index.ts:261-340` |
| Rate limiters | `index.ts:370-401` |
| Route mounts | `index.ts:411-459` |
| Health + O(n) sweep | `index.ts:461-493` |
| `autoClockOut` (business logic!) | `index.ts:496-560` |
| `bootstrap()` | `index.ts:640-669` |
| Shutdown | `index.ts:689-725` |
| `trust proxy` = 1 → needs 2 | `index.ts:92` |
| Master pool `max: 10` | `db.ts:34` |
| `platform_users` table (master) | `db.ts:211` |
| `initTenantSchema()` | `db.ts:431` |
| `MIGRATIONS[]` (30 entries) | `utils/migrationRunner.ts:46` |
| `MAX_POOLS = 10` | `utils/tenantManager.ts:51` |
| `createTenant` / `deleteTenant` / `forEachTenant` | `tenantManager.ts:280 / 355 / 478` |
| `clients` Map | `utils/ws.ts:79` |
| `pendingMeetingLeaves` | `utils/ws.ts:108` |
| `_membershipCache` | `utils/ws.ts:136` |
| `_callSignalBuffers` | `utils/ws.ts:223` |
| `_meetingSignalBuffers` | `utils/ws.ts:339` |
| `ws:broadcast` publish | `utils/ws.ts:3884` |
| Redis fail-fast fallback | `redis.ts:41` |
| `setInterval` job fallback | `jobs.ts:487-530` |
| Platform-admin mirror insert | `routes/auth.ts:493-499` |
| `user_directory` re-register | `routes/auth.ts:503-506` |
| Bootstrap-admin fallback | `routes/auth.ts:275` |
| Disk uploads (3 files only) | `chat.ts:74`, `profile.ts:45`, `branding.ts:52` |
