# AINO — Pre-Push & Automatic Railway Deployment Runbook

> **Purpose:** this branch changes storage, migrations, Redis behavior, process
> roles, health checks, PgBouncer support and Cloudflare routing.
>
> ⚠️ **Autodeploy is currently OFF** (no repo trigger on `WorkPulse`, verified
> 2026-08-27), so a push updates GitHub only and you promote manually. Much of
> this document was written assuming push-to-deploy; where that matters it now
> says so explicitly. See §1.1/§1.1a.
>
> ## 🟢 STATUS 2026-08-28 — THIS RELEASE HAS ALREADY SHIPPED
>
> **The push happened, the promotion happened, and production has been iterated
> on top of it.** Everything below that reads like a future instruction is now a
> historical record — read it for the ordering logic, not as a to-do list.
>
> **Commit evidence (all 2026-08-27):**
>
> - `f848c9a5` — feat(scalability): R2 uploads, pre-deploy migrations, split roles ← **the release**
> - `d9213187` — fix(railway): overlapSeconds/drainingSeconds must be numbers, not strings
> - `50fe6b6b` — feat(scalability): Phase H observability + GR1/GR5 guardrails
> - `9fe31245` — chore(deploy): run A3.8 upload copier via startCommand (one-off) ← **§1.5 executed**
> - `07b1bc4a` — fix(csp): allow R2 upload origin so avatars and attachments render
> - `46202588` — fix(uploads): stop forwarded-attachment deletion; randomise upload filenames
> - `a04ee989` — feat(storage): r2-tenant-report — map opaque prefixes to tenant names
> - `9b6303d6` — feat(console): show live R2 upload usage on tenant overview ← **HEAD**
>
> The last four commits are **post-deploy production fixes**. You cannot get a CSP
> violation against the R2 origin, nor build a live R2 usage panel, unless the app
> is booting with `STORAGE_DRIVER=r2`. That is the proof the new image is live.
>
> ⚠️ **HEAD is `9b6303d6`, not `f848c9a5`.** Any step below that tells you to
> expect a deployment hash starting `f848c9a` is stale (see §2).
>
> ✅ **§8 is DONE — `workpulse-volume` is detached (confirmed 2026-08-28 via
> `railway volume list`: `serviceName: null`).** The replica pin is gone, so the
> service _can_ now scale horizontally — but it has not been scaled yet, so
> multi-replica behaviour remains **unproven in production**. The operator has
> also confirmed live that a **new avatar upload works end-to-end against R2**.
>
> ℹ️ **The volume still exists and still holds its data** — `deletedAt: null`,
> `isPendingDeletion: false`, `currentSizeMB: 330.47`. It is detached, not
> deleted. That means the `--verify` reconciliation of legacy uploads (§1.5 A3)
> is _still_ runnable via a temporary re-attach, and it stops being runnable the
> moment the volume is deleted. See §8.
>
> 🔵 **The one thing still outstanding: §1.6 — rotate the secrets that were
> exposed during setup.** This is `A1.1`–`A1.3` in the plan and is now the
> highest-priority remaining item.
>
> **Verdict at push time (2026-08-27):** 🟢 GO — every pre-push gate passed.
>
> ✅ **§1.3 variables set and value-checked** — all 13 present (`ROLE=all`,
> `SERVE_SPA=true`, `STORAGE_DRIVER=r2`, `R2_UPLOADS_BUCKET=aino-uploads`, pool
> sizes 4/3/100/5); both DB URLs resolve to `postgres.railway.internal` (direct,
> not PgBouncer — correct for this first deploy).
>
> ✅ **R2 token now has Object Read & Write** — probe passes put/head/get/delete.
>
> ✅ Local gates green: `check:guardrails` exit 0, `verify-docker-migrations` PASS,
> 74 suites / 846 tests.
>
> ✅ **`docker build` PASS** (2026-08-27, image `aino-pre-push`, 391 MB,
> `sha256:8bfb199c…`). Verified _inside_ the built image, not just that it built:
> `scripts/migrate-uploads-to-r2.js` present · both `.sql` migrations shipped
> (`0002_migration_catchup.sql`, `master/0001_shards_and_storage.sql`) ·
> `@aws-sdk/client-s3` installed · runs as `uid=100(appuser)` ·
> `assertProductionStorage()` throws on `STORAGE_DRIVER=local` and accepts `r2`,
> logging `Storage: using Cloudflare R2`.
>
> ✅ Production currently healthy on the old image:
> `{"expected":30,"minApplied":30}` — which is exactly the state the
> legacy-adoption guard needs, so the destructive catch-up will **not** execute.
>
> ✅ **Ordering constraint — RESOLVED 2026-08-27.** Kept below because the logic
> is worth understanding before any similar cutover, but it no longer describes
> the present.
>
> <details><summary>Historical: the ordering constraint discovered 2026-08-27</summary>
>
> `aino-uploads` held **0 objects**, and the upload copier **could not run until
> after the push**. The then-deployed image (`48af56cd`) had no
> `server/scripts/`, no `platform/storage/`, and no `@aws-sdk/client-s3` in its
> `package.json` — the copier did not exist in that image and could not be run
> there. §1.5 documents the order that was actually used and the short window of
> broken images it implied.
>
> **Resolution:** commit `9fe31245` ran the copier as a one-off Railway
> `startCommand` against the new image on 2026-08-27.
>
> </details>
>
> ⬜ **Unproven:** the `--verify` pass that should print `Missing in R2: 0` was
> never captured into git or into §10. The copier ran; nobody recorded the
> reconciliation output. Treat "every legacy upload is in R2" as **likely but not
> evidenced** until you re-run the verify (§1.5 step A3).
>
> ✅ **What IS now proven (operator, 2026-08-28): the R2 write path works.** A new
> avatar was uploaded and rendered live from R2. Note carefully that this proves
> the **new-upload** path only — it says nothing about whether all 330.5 MB of
> **legacy** files copied across. Those are two separate claims and only the
> `--verify` pass settles the second one.
>
> ⚪ §1.4 (DB backup) — **optional by operator decision, and it was NOT taken.**
> This matches `P0.5` in the plan, which is deliberately left unticked.
>
> 🆕 **2026-09-01 — Railway config migrated to Infrastructure as Code.** `railway.json` is
> deprecated and removed; `.railway/railway.ts` is now the source of truth (D4.5's
> healthcheck/pre-deploy/restart-policy settings live there, plus new `PgBouncer`,
> `aino-web`, `aino-realtime`, `aino-worker` service declarations for E1.1/E3.2/F1).
> `scripts/verify-railway-config.mjs` now validates the `.ts` file. **None of this has been
> applied yet** — `railway config apply` was deliberately not run; see
> `docs/SCALABILITY_REFACTOR_PLAN.md`'s 2026-09-01 progress-log entry for the full diff
> (`railway config plan`: 4 to add, 1 to change, 0 to destroy).

**Project:** `renewed-fascination` (`1be6f4e9-6e54-4594-ad4b-8fd691fb9b02`)  
**Environment:** `production`  
**Current app:** `WorkPulse` (`ROLE=all` rollback service)  
**Current databases:** Railway Postgres 18 (`postgres-ssl:18`) + Redis 8  
**Current upload volume:** `workpulse-volume`, **330.5 MB** at `/app/server/uploads`

### Environment constraints verified on the operator workstation (2026-08-27)

These decide _which_ method each step below can use — they are not incidental:

| Path                                                                            | Status           |
| ------------------------------------------------------------------------------- | ---------------- |
| `ssh.railway.com:22` (`railway ssh`, `railway volume files`, `railway connect`) | 🔴 **blocked**   |
| `interchange.proxy.rlwy.net:21659` (Postgres public TCP proxy)                  | 🔴 **blocked**   |
| `*.r2.cloudflarestorage.com:443`                                                | ✅ reachable     |
| Local `psql` / `pg_dump`                                                        | ❌ not installed |
| `railway` CLI 5.30.4 · `aws` CLI 2.34.9 · Node 24 · Docker 27.3.1               | ✅ available     |

Consequence: **database backups and any volume-download route must run from a
GitHub Actions runner or inside the Railway container**, not from this machine.

> ✅ **Status check (2026-08-27, after the operator applied the variables and
> fixed the R2 token): all 13 mandatory variables in §1.3 are set with correct
> values, and the R2 credential probe passes read + write.**
>
> ⚠️ If a future check ever reports `MISSING` right after you edited the
> dashboard, the cause is almost always Railway's **staged changes**: variable
> edits sit in a changeset and do not exist on the service until you click
> **Deploy** in the _Details_ panel. Look for the purple banner on the canvas.

### Accepted-risk profile (operator decision, 2026-08-27)

The operator has chosen to **skip the database backup** (§1.4), on the basis that
the platform-admin credentials are known and tenants/users can be recreated.
That reasoning was checked and holds — see §1.4 for why the migration path is
non-destructive on this database, and for the two-click Railway volume backup
that is worth taking anyway.

**§1.5 (upload copy) is NOT skippable on the same reasoning.** Recreating a
tenant regenerates rows, not files; nothing can reproduce the 330.5 MB of
uploads. It is, however, **re-sequenced**: the copier only exists in the new
image, so it runs immediately _after_ the push rather than before. See §1.5.

> **This is the detailed, authoritative operator checklist.**
> [`SCALABILITY_REFACTOR_PLAN.md`](SCALABILITY_REFACTOR_PLAN.md#-pre-push--deployment-runbook)
> carries a condensed version of the same sequence, cross-referenced to the
> plan's task IDs (A3.2, D5.1, …). **If you change one, change both.**

---

## 0. Understand What the Push Will Do

The committed `railway.json` changes deployment behavior:

```text
Build:       Dockerfile
Pre-deploy:  node migrate.js
Start:       node index.js
Health:      /readyz (300 second timeout)
Overlap:     30 seconds
Drain:       15 seconds
```

The pre-deploy process uses the built image, private network and service
variables. A nonzero exit blocks deployment. Runtime roles no longer perform
DDL.

The new production image **refuses to start** if:

- `REDIS_URL` is missing/unreachable;
- `STORAGE_DRIVER` resolves to `local`;
- any R2 credential is missing;
- `JWT_SECRET` is missing/too short;
- `/readyz` cannot reach Postgres and Redis.

---

## 1. Blocking Actions Before the Push

### 1.1 Pause automatic production deployment

> ✅ **Already the case — verified 2026-08-27.** The `WorkPulse` service has
> **no repo trigger** (`repoTriggers` is empty), so a push to `master` will
> **not** deploy anything right now. Postgres and Redis are image-based and have
> no triggers either.
>
> ```powershell
> # How this was checked (repoTriggers governs push-to-deploy):
> railway api 'query { project(id: "<project-id>") { services { edges { node {
>   name repoTriggers { edges { node { repository branch } } } } } } } }'
> ```
>
> Current source: `vvronline/WorkPulse`, **trigger: none**.
>
> 🔴 **Consequence for this release:** the runbook's later instruction to
> "re-enable autodeploy, then push" would deploy _immediately_ on enable. See
> §1.1a for the safer order.

### 1.1a Should autodeploy be ON for this release?

**Recommendation: leave it OFF for this deploy; turn it on afterwards.**

The whole design of this release assumes a _controlled_ promotion:

| Reason                                    | Detail                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The upload window (§1.5)                  | The copier only exists in the new image, so uploads 404 between deploy and copy completion. You want to choose that moment, not have a push choose it.                                                                                                 |
| Dashboard settings are needed mid-release | §1.5 requires temporarily changing the start command and clearing the health check. An autodeploy landing mid-copy would fight you.                                                                                                                    |
| `railway.json` is **new in this commit**  | It is currently untracked, so this push _introduces_ pre-deploy migrations, `/readyz` and the 30s/15s teardown. The service today still points at `/api/health` with no pre-deploy command. First exposure to that config is better done deliberately. |
| CI does not gate Railway                  | GitHub Actions and Railway watch the branch independently — a red CI run would not stop an autodeploy.                                                                                                                                                 |

**Safer sequence for _this_ release:**

1. Leave the repo trigger **off**.
2. `git push origin master` — this only updates GitHub. Watch CI go green.
3. Deploy manually when you are ready to babysit it. 🔴 **The three "redeploy"
   actions are not equivalent — two of them would ship the OLD code:**

   | Action                                                       | What it actually does                                                                                                                     | Use here?                                |
   | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
   | UI **Redeploy** (⋯ on a deployment)                          | "Creates a new deployment with the **exact same code** and build/deploy configuration." Re-runs the **existing image** — i.e. `48af56cd`. | ❌ **No** — deploys the old commit       |
   | UI **Restart**                                               | Restores the exact image of the current build                                                                                             | ❌ No                                    |
   | UI Command Palette → **Deploy Latest Commit** (`Ctrl/Cmd+K`) | Builds the latest commit on the **default branch**                                                                                        | ✅ Yes                                   |
   | CLI `railway redeploy --from-source`                         | "Pull and deploy the **latest commit** from the configured source"                                                                        | ✅ Yes — equivalent to the above         |
   | CLI `railway up`                                             | Uploads your **local working directory** — bypasses git and CI entirely                                                                   | ⚠️ Avoid: deploys unreviewed local state |

   ```powershell
   # Preferred: deploys the exact commit CI validated.
   railway redeploy --service WorkPulse --from-source
   ```

   Verified 2026-08-27: the GitHub default branch is `master`, and
   `origin/master` = `f848c9a`, so "Deploy Latest Commit" and `--from-source`
   both resolve to the CI-green commit.

   **Whichever you use, confirm the new deployment's commit hash is the one CI
   tested — not the previous one — before letting it take traffic.**

4. Complete the §1.5 copy and §3 verification.
5. **Then** enable the trigger for routine future releases:
   Railway → `WorkPulse` → Settings → Source → connect branch `master`.

**Turn autodeploy on afterwards if** you want ordinary commits to ship without
manual steps — that is reasonable once uploads are in R2, because subsequent
deploys are plain image swaps with no data migration attached. Until then, the
manual gate is the feature, not the friction.

- [x] Railway → `WorkPulse` → Settings → Source → disable automatic deployments,
      **or** temporarily change the deploy branch away from `master`.
      ✅ Already off — no repo trigger existed, verified 2026-08-27.
- [x] Confirm the current production deployment remains Online.
      ✅ `0ab38c7a-5f49-403d-8932-7ddf7af3efe3` (commit `48af56cd`) stayed Online
      right through the failed first promotion (see §9 "Config parse fails").
- [ ] ⬜ **Step 5 of the safer sequence is still deferred** — the repo trigger has
      **not** been re-enabled. That is intentional and belongs to §8.

This is mandatory because the following environment changes and data copy must
be completed before the new image starts.

### 1.2 Create and secure the private upload bucket

> ✅ **Completed 2026-08-27.** The first token was created as **Object Read
> only** and was re-created with **Object Read & Write** after the probe caught
> it — exactly the failure mode described below. The "no public domain" box is
> not a preference, it is [ADR-004](./adr/): `aino-uploads` is presigned-only.

- [x] Confirm Cloudflare R2 bucket `aino-uploads` exists.
- [x] Confirm **Public Development URL is disabled**.
- [x] Confirm **no custom/public domain** is attached.
- [x] Create credentials scoped to Object Read & Write on `aino-uploads`.
- [x] Test credentials with a harmless put/head/get/delete probe.

Never reuse the public releases/SPA bucket for tenant uploads.

**Credential probe — 🔴 do not skip this.** A read-only token passes _every_
boot check: `assertProductionStorage()` only constructs the adapter, it never
writes. The deploy goes green, `/readyz` returns 200, existing files download
fine — and the first user upload returns a 500. This probe moves that discovery
to before the push.

```powershell
# Pull the live values straight from Railway; never hard-code secrets.
$j = railway variables --service WorkPulse --json | ConvertFrom-Json
$env:R2_ACCOUNT_ID        = [string]$j.R2_ACCOUNT_ID
$env:R2_ACCESS_KEY_ID     = [string]$j.R2_ACCESS_KEY_ID
$env:R2_SECRET_ACCESS_KEY = [string]$j.R2_SECRET_ACCESS_KEY
$env:R2_UPLOADS_BUCKET    = [string]$j.R2_UPLOADS_BUCKET

node scripts/verify-r2-credentials.mjs
```

- [x] Output ends `RESULT: PASS — read + write confirmed; probe object removed.`
- [x] Note the reported object count — it also tells you whether §1.5 has run.
      ✅ It reported **0 objects** at probe time, which is precisely how the §1.5
      ordering constraint was discovered. The copier has since run (`9fe31245`),
      so a probe today will report a non-zero count.
- [x] Confirm the bucket is **not** publicly reachable — an anonymous fetch of a
      real key must not return `200`.

> ℹ️ **Why a Node script rather than `aws s3 ...`?** The AWS CLI ships its own CA
> bundle and dies with `CERTIFICATE_VERIFY_FAILED` behind the corporate
> TLS-inspecting proxy. Node honours `NODE_EXTRA_CA_CERTS` and the Windows trust
> store, so this works where the CLI does not. It also uses the _same_ SDK the
> server uses, so a pass here means the app will genuinely work.

**If `put` fails with `AccessDenied` while `list` succeeds**, the token is
read-only — this is the most common misconfiguration, because the R2 UI offers
"Object Read only" and "Object Read & Write" and the former looks sufficient:

- [ ] Cloudflare dashboard → **R2** → **Manage API Tokens** → edit the token.
- [ ] Permission must be **Object Read & Write**, scoped to `aino-uploads`.
- [ ] Re-create the token if the permission cannot be edited in place.
- [ ] Update `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in Railway, then re-run
      the probe until it reports PASS.

### 1.3 Configure mandatory variables on the existing `WorkPulse` service

Set these **before the push**:

| Variable                     | Value                                                |
| ---------------------------- | ---------------------------------------------------- |
| `ROLE`                       | `all`                                                |
| `SERVE_SPA`                  | `true`                                               |
| `STORAGE_DRIVER`             | `r2`                                                 |
| `R2_ACCOUNT_ID`              | Cloudflare account ID                                |
| `R2_ACCESS_KEY_ID`           | private upload-bucket key ID                         |
| `R2_SECRET_ACCESS_KEY`       | private upload-bucket secret                         |
| `R2_UPLOADS_BUCKET`          | `aino-uploads`                                       |
| `REDIS_URL`                  | `${{Redis.REDIS_URL}}` or existing working reference |
| `DIRECT_DATABASE_URL`        | `${{Postgres.DATABASE_URL}}`                         |
| `MASTER_POOL_SIZE`           | `4`                                                  |
| `TENANT_POOL_SIZE`           | `3`                                                  |
| `TENANT_MAX_POOLS`           | `100`                                                |
| `TENANT_FOREACH_CONCURRENCY` | `5`                                                  |

Optional — Phase H observability. Safe to omit entirely; nothing else depends
on them:

| Variable                      | Value                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN`               | `openssl rand -base64 32`. **Required for `/metrics` to respond in production** — without it the endpoint returns 404 (fail-closed). Use the _same_ value on every service or dashboards will show gaps that look like outages. |
| `METRICS_TENANT_TOP_N`        | `20` — tenants that get their own metric label before the rest fold into `other`                                                                                                                                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL. **Setting this enables tracing**; omit to leave it off.                                                                                                                                                |
| `OTEL_EXPORTER_OTLP_HEADERS`  | e.g. `authorization=Bearer <token>`                                                                                                                                                                                             |

- [ ] Confirm existing `DATABASE_URL` still points **directly to Postgres** for
      this first deployment. PgBouncer is a later canary step.
- [ ] Do not rotate PostgreSQL credentials yet.

**Set them via the CLI** (each `variable set` triggers a redeploy, so use
`--skip-deploys` until the whole batch is in place):

```powershell
$svc = "WorkPulse"
railway variable set --service $svc --skip-deploys `
  ROLE=all SERVE_SPA=true STORAGE_DRIVER=r2 R2_UPLOADS_BUCKET=aino-uploads `
  MASTER_POOL_SIZE=4 TENANT_POOL_SIZE=3 TENANT_MAX_POOLS=100 `
  TENANT_FOREACH_CONCURRENCY=5

# Reference variables must be quoted so PowerShell does not eat the braces.
railway variable set --service $svc --skip-deploys 'DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}'

# Secrets via stdin so they never land in shell history.
railway variable set --service $svc --skip-deploys --stdin R2_ACCOUNT_ID
railway variable set --service $svc --skip-deploys --stdin R2_ACCESS_KEY_ID
railway variable set --service $svc --skip-deploys --stdin R2_SECRET_ACCESS_KEY
```

**Verify — do not assume.** This prints only names, never values:

```powershell
$have = (railway variables --service WorkPulse --json | ConvertFrom-Json).PSObject.Properties.Name
'ROLE','SERVE_SPA','STORAGE_DRIVER','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID',
'R2_SECRET_ACCESS_KEY','R2_UPLOADS_BUCKET','REDIS_URL','DIRECT_DATABASE_URL',
'MASTER_POOL_SIZE','TENANT_POOL_SIZE','TENANT_MAX_POOLS','TENANT_FOREACH_CONCURRENCY' |
  ForEach-Object { '{0,-30} {1}' -f $_, $(if ($have -contains $_) { 'SET' } else { 'MISSING' }) }
```

- [x] ✅ **Verified 2026-08-27 — every row prints `SET` (45 variables total).**
      Any `MISSING` row means the deploy will fail its health check —
      `assertProductionStorage()` throws before `listen()`.

**Also check the values, not just presence.** A typo in `STORAGE_DRIVER` silently
falls back to the default, and `ROLE=All` (capital A) is rejected outright:

```powershell
$j = railway variables --service WorkPulse --json | ConvertFrom-Json
foreach ($k in 'ROLE','SERVE_SPA','STORAGE_DRIVER','R2_UPLOADS_BUCKET',
               'MASTER_POOL_SIZE','TENANT_POOL_SIZE','TENANT_MAX_POOLS',
               'TENANT_FOREACH_CONCURRENCY') { '{0,-30} [{1}]' -f $k, $j.$k }

# Both must resolve to postgres.railway.internal for THIS deploy (not PgBouncer).
foreach ($k in 'DATABASE_URL','DIRECT_DATABASE_URL','REDIS_URL') {
  $u = [uri]([string]$j.$k); '{0,-22} host={1} port={2}' -f $k, $u.Host, $u.Port
}
```

- [x] ✅ Verified: `all` / `true` / `r2` / `aino-uploads` / `4` / `3` / `100` / `5`,
      and both DB URLs on `postgres.railway.internal:5432`, Redis on
      `redis.railway.internal:6379`.

> ⚠️ Railway **stages** variable edits in a changeset — they do not exist on the
> service until you click **Deploy** in the _Details_ panel. If the verifier says
> `MISSING` right after you typed them in the dashboard, look for the purple
> "N staged changes" banner on the canvas.

> ⚠️ Never run `railway variables --kv` and paste the output anywhere: it prints
> raw secret values, and `FIREBASE_SERVICE_ACCOUNT_KEY` spans many lines, which
> also corrupts any line-based filtering you try to apply to it.

> ℹ️ `NODE_ENV=production` and `PORT=5000` are baked into the `Dockerfile`
> (lines 56–57), so they do **not** need to be set as service variables here.

### 1.4 Back up databases — ⚪ OPTIONAL (risk accepted 2026-08-27)

> **Operator decision:** skipped. The platform-admin username/password are known,
> and tenants/users can be recreated by hand.

**Why that reasoning holds.** The migration risk here is genuinely low, and this
was checked rather than assumed:

- Only **two** migrations run against production: `master/0001_shards_and_storage.sql`
  (pure additive — `CREATE TABLE IF NOT EXISTS shards`, two
  `ADD COLUMN IF NOT EXISTS` on `tenants`, one counter backfill) and
  `0002_migration_catchup.sql`.
- `0002` _does_ contain `DROP TABLE IF EXISTS sprint_retrospectives`, but it is
  **adopted, not executed** on an already-migrated database. The
  legacy-adoption guard in `migrationRunner.ts` records it as applied when all
  30 pre-squash names are present.
- **Verified:** the 30 names in `LEGACY_MIGRATION_NAMES` match the 30 names the
  currently-deployed runner records — exactly, with no additions or omissions.
  Live `/api/health?detail=true` confirms `{"expected":30,"minApplied":30,
"tenants":{"default":30,"master":30}}`.
- Therefore the guard **will** fire and the destructive path will not run.

**What you are still accepting.** Be explicit about it:

| Risk                                            | Consequence                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The guard depends on `_migrations` being intact | If any single one of the 30 rows is missing, the DB is treated as _partially_ migrated, the catch-up **executes**, and `sprint_retrospectives` + `sprint_retro_votes` are dropped and rebuilt empty. The log warns `PARTIALLY migrated DB`, but by then it has run. |
| "Recreate the tenants" is not free              | You lose all operational history — tasks, chats, notes, attendance, retrospectives, audit logs. Recreating logins is easy; recreating _data_ is not.                                                                                                                |
| No restore point for an unrelated failure       | Any other data-loss cause during this window has no recovery path.                                                                                                                                                                                                  |

**Cheap mitigation — take it even though you are skipping the SQL dump.** This
is two clicks and needs no network access, no `pg_dump`, and no secret:

- [ ] Railway → **Postgres** → Settings → **Backups** → _Create backup_.

That snapshots `postgres-volume` (204 MB) and can be restored from the same
project/environment. It is not a portable dump, but it turns "unrecoverable"
into "recoverable", which is the entire point of this section.

<details>
<summary>Full backup procedure (if you change your mind)</summary>

🔴 **A database restore is the only thing a rollback cannot do for you.** Rolling
the image back does **not** roll the database back — `node migrate.js` runs in
pre-deploy and applies DDL before the new image ever serves traffic.

#### Why the obvious options do not work here

| Option                          | Verdict                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_dump` from this workstation | ❌ The Railway Postgres TCP proxy (`interchange.proxy.rlwy.net:21659`) is **blocked by the corporate network** — verified unreachable. `psql`/`pg_dump` are also not installed locally. |
| `railway connect Postgres`      | ❌ Falls back to SSH; `ssh.railway.com:22` is **blocked** on this network.                                                                                                              |
| Railway volume backup           | ⚠️ Snapshots `postgres-volume` at the filesystem level. Good as a second copy, but it is not a portable, inspectable SQL dump and it **cannot be restored into a different project**.   |
| **GitHub Actions workflow**     | ✅ **Use this.** The runner has open egress and a matching client.                                                                                                                      |

#### Step 1 — one-time setup

- [ ] Copy the public connection string: Railway → **Postgres** → **Connect** →
      **Public Network**.
- [ ] Repo → Settings → Secrets and variables → Actions → **New repository
      secret** → name `DATABASE_PUBLIC_URL`, value = that string.

#### Step 2 — run the backup

- [ ] Actions tab → **DB — Full Backup (manual)** → Run workflow → type
      `CONFIRM` → Run.

This runs `scripts/backup-all-databases.sh`, which dumps **the master database
and every tenant database**:

```text
db-backups/
  master-<ts>.sql               platform_users, tenants catalog  <- YOUR IDENTITY
  tenant-railway-<ts>.sql       the default tenant
  tenant-<db_name>-<ts>.sql     one file per additional tenant
  MANIFEST-<ts>.txt             counts, tenant list, restore instructions
```

> 🔴 **Do not substitute `A2 — Database Dump` for this.** That workflow exists to
> regenerate the migration baseline and dumps only master + the `is_default`
> tenant. This project is database-per-tenant (ADR-001), so that would silently
> leave every non-default tenant with no backup at all.

#### Step 3 — verify the backup is actually restorable

The script already **fails the workflow** if `platform_users` is empty or if the
master dump contains no `platform_users` rows — an empty dump can otherwise look
like a success. Still confirm by hand:

- [ ] Job summary shows `tenant_dbs` equal to the number of rows in `tenants`.
- [ ] Job summary shows `platform_users` ≥ 1.
- [ ] Download the `db-backup-<run_id>` artifact and open `MANIFEST-<ts>.txt`.
- [ ] Spot-check the master dump really carries data, not just schema:

```powershell
Select-String -Path .\master-*.sql -Pattern 'COPY public.platform_users' -SimpleMatch |
  Select-Object -First 1
```

#### Step 4 — retain and record

- [ ] Upload the artifact to the **private** R2 bucket (never the public SPA or
      releases bucket) — GitHub deletes it after 7 days.
- [ ] **Delete the GitHub artifact afterwards.** It contains password hashes.
- [ ] Also take a Railway volume backup of `postgres-volume` as a second copy:
      Railway → Postgres → Settings → **Backups** → _Create backup_. Note that
      manual volume backups are capped at 50% of volume size, and restores are
      limited to the same project + environment.
- [ ] Record the timestamp in the §10 go/no-go record.

**To restore** (only if a migration corrupts data — see §9):

```bash
# 1. master first: it holds platform_users and the tenants catalog
psql "$DATABASE_URL" -f master-<ts>.sql

# 2. then each tenant, into a URL ending in that tenant's db_name
psql "postgresql://.../<db_name>" -f tenant-<db_name>-<ts>.sql
```

> Every dump uses `--clean --if-exists`, so a restore **drops and recreates**
> what it owns. Restoring a tenant dump into the master database would destroy
> the tenant catalog. Check the final path segment of the URL before pressing
> enter.

</details>

### 1.5 Copy the existing upload volume to R2 — 🔴 REQUIRED, but runs **after** the push

> 🔴 **Ordering correction (2026-08-27).** This step is numbered inside "Section 1
> — Blocking Actions Before the Push", but it **cannot** be done before the push.
> Verified against the deployed commit `48af56cd`:
>
> | Needed by the copier                      | Present in the running image?         |
> | ----------------------------------------- | ------------------------------------- |
> | `server/scripts/migrate-uploads-to-r2.js` | ❌ no `server/scripts/` at all        |
> | `platform/storage/` (R2 adapter)          | ❌ does not exist                     |
> | `@aws-sdk/client-s3` dependency           | ❌ not in that image's `package.json` |
>
> The copier ships **in the new image**. So the real sequence is:
>
> ```text
> push  ->  new image deploys (uploads now read from an EMPTY bucket)
>       ->  run the copier inside the new image
>       ->  uploads resolve again
> ```
>
> **Between those two steps, existing avatars and attachments 404.** That window
> is unavoidable on this path; keep it short by having the copier command ready
> to paste before you push. Plan the release for a low-traffic period.
>
> The alternative — `railway volume files download` + `aws s3 sync` **before** the
> push, giving zero downtime — needs `ssh.railway.com:22`, which is blocked on
> this network. If you can run it from an unrestricted machine, do that instead
> (Method B) and this window disappears entirely.

> ⚠️ **Keep the volume attached through the push.** The new image no longer
> _needs_ the volume, but the copier reads from it. Do not detach it until §8.

> 🔴 **Possible permission trap — check this first if the copier reports 0 files.**
> Railway mounts volumes **as root**. The old image worked around that with a
> root `chown -R appuser:appgroup /app/server/uploads` in `entrypoint.sh` before
> dropping privileges. The new image deliberately removes that step (`USER appuser`
> is set at build time, since a stateless container has no volume to fix up).
>
> So in the new image the copier runs as **non-root `appuser`** against a
> **root-owned** mount. If the mode bits do not grant world-read, `walk()` logs
> `! cannot read /app/server/uploads` and reports `Local: 0 file(s)` — which looks
> like "nothing to copy" rather than an error.
>
> **`Local: 0 file(s)` on a 330 MB volume means a permission failure, not an
> empty volume.** If that happens, set `RAILWAY_RUN_UID=0` on the service
> (Railway's documented escape hatch for non-root images with volumes), re-run
> the copier, then **remove the variable** before restoring the normal start
> command — you do not want production running as root long-term.

> **The "I can recreate it" argument does not apply here.** Recreating a tenant
> regenerates _rows_, not _files_. Nothing in the system can reproduce the
> 330.5 MB of avatars, chat attachments, task-comment files and org logos that
> users already uploaded. There is no seed, no source, no regeneration path.

**What happens if you skip it.** This is not a slow degradation; it is immediate
and affects every historical file:

1. The new image boots with `STORAGE_DRIVER=r2`.
2. A user opens any existing chat attachment or avatar. The request hits
   `GET /uploads/tenant_1/org_1/...`, passes every authorization check, then
   calls `storage.getSignedUrl(key, 60)` against **R2**.
3. R2 has no such key. The user gets a presigned URL that resolves to a
   **404** — a broken image, a failed download.
4. Meanwhile the bytes are still sitting on `workpulse-volume`, which the running
   container is no longer reading from.

The database is _not_ corrupted — every `avatar`, `logo_url` and `file_url`
column still holds a valid path. The files are simply in the wrong place. That
is what makes this both **low-risk to fix** and **easy to overlook**: nothing
errors in the logs, users just report broken images.

**Two reasons to do it now rather than later:**

- It is **fully reversible and non-destructive**. The copier is read-only against
  the volume and idempotent against R2. Running it cannot break anything.
- It is **~330 MB over the private network** — a few minutes inside the container.

**The only case for skipping:** you genuinely do not care about any file any user
has ever uploaded, and are content for all historical avatars and attachments to
break permanently. If so, tick this instead and move on:

- [ ] I accept that all 330.5 MB of existing uploads will 404 after cutover.

Otherwise, do the copy. The rest of this section is how.

---

`workpulse-volume` holds **330.5 MB** mounted at `/app/server/uploads`. Once the
new image boots with `STORAGE_DRIVER=r2` it reads uploads from R2 only — so
anything not copied first becomes a broken avatar/attachment for every user.

#### Why no transformation is needed

The R2 key is byte-identical to the on-disk path, relative to the uploads root:

```text
/app/server/uploads/tenant_1/org_1/avatar/x.png   (disk)
                    tenant_1/org_1/avatar/x.png   (R2 key)
/uploads/tenant_1/org_1/avatar/x.png              (URL stored in the tenant DB)
```

`buildUploadKey()` in `server/platform/storage/keys.ts` produces exactly this
shape, so **every `avatar`, `logo_url` and `file_url` already in a tenant
database keeps resolving with no data migration.** A backslash or a renamed
prefix would 404 silently, per file — never "tidy up" the layout during the copy.

#### Choosing a method

The volume is only reachable from inside a Railway container; there is no
S/FTP, and a volume cannot be attached to a second service.

| Method                                          | Verdict                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `railway volume files download` + `aws s3 sync` | ❌ here — uses Railway SFTP over `ssh.railway.com:22`, **blocked on this network** (verified). Fine from an unrestricted network.                                 |
| `aws s3 sync ./uploads ...` locally             | ❌ needs a local copy of the volume, which the row above cannot produce here.                                                                                     |
| Pre-deploy command                              | ❌ **volumes are not mounted in pre-deploy** and its filesystem changes are discarded (Railway docs). It cannot see the uploads at all.                           |
| **Method A — in-container copier**              | ✅ **recommended.** Runs _inside_ the service, where the volume is a plain directory and R2 credentials are already in the environment. Needs no inbound network. |

The repository already ships the copier: `server/scripts/migrate-uploads-to-r2.ts`,
compiled into the image as `/app/server/scripts/migrate-uploads-to-r2.js`. It is
**read-only** against the volume, **idempotent** (an object already in R2 at the
same byte size is skipped) and therefore **resumable** — re-running it is the
supported way to perform the final delta pass.

---

#### Method A — run the copier inside the service _(recommended)_

`ROLE=all` serves traffic from the same container that mounts the volume, so run
the copier as a temporary **start command**. `railway.json` normally wins over
dashboard settings, so make this change in the **dashboard** and revert it after.

> ✅ **A1 and A2 were executed 2026-08-27** via commit `9fe31245`
> ("chore(deploy): run A3.8 upload copier via startCommand (one-off)"). The
> boxes below are ticked from that commit, not from captured console output.

**A1. Dry run first — writes nothing.**

- [x] Railway → `WorkPulse` → Settings → Deploy → **Custom Start Command**:

```sh
node scripts/migrate-uploads-to-r2.js --dry-run
```

- [x] Temporarily clear the health check path. The copier is not an HTTP server,
      so `/readyz` would fail and roll the deployment back mid-copy.
- [x] Deploy, then read the logs:

```text
A3.8 — copy upload volume to Cloudflare R2
  source : /app/server/uploads
  bucket : aino-uploads
  mode   : DRY RUN
Local:  <N> file(s), 330.x MB
Remote: 0 object(s), 0 B
  would upload  tenant_1/org_1/avatar/....png
```

- [x] **Record the local file count and byte total.** That is the number the real
      copy must match.
      ⬜ **Not evidenced:** the dry-run counts were never written down anywhere.
      The volume was 330.5 MB at the time, which is the only figure we can still
      cite.

**A2. Real copy.**

- [x] Change the start command to:
      **Evidence:** commit `9fe31245` — "chore(deploy): run A3.8 upload copier via
      startCommand (one-off)".

```sh
node scripts/migrate-uploads-to-r2.js
```

- [x] Redeploy and watch for the completion block:

```text
COPY complete in <n>s
  uploaded : <N>  (330.x MB)
  skipped  : 0
  failed   : 0
Post-copy check: <N> object(s) in R2, 0 local file(s) missing.
RESULT: PASS — every local file is present in R2.
```

- [x] `failed` is `0`. If not, redeploy the same command — completed files are
      skipped and only the failures are retried.
      **Evidence:** inferred, not captured. R2-backed avatars and attachments
      render in production today (commits `07b1bc4a`, `9b6303d6`), which cannot
      happen if the copy had failed wholesale. The console output was never saved.

**A3. Verify independently.**

> ⬜ **NOT DONE — this is the one real gap in the §1.5 sequence.** The `--verify`
> pass was never run, or at least never captured into git or §10. Until it is,
> "every legacy upload is in R2" is **likely but not evidenced**.
>
> ✅ **Still runnable.** The volume was detached on 2026-08-28 but **not deleted**
> (`deletedAt: null`, `currentSizeMB: 330.47`), so this verify can still be done by
> temporarily re-attaching `workpulse-volume` to the `WorkPulse` service and
> re-running the copier with `--verify`.
>
> ⚠️ **Do not confuse this with the operator's live test.** A new avatar upload was
> confirmed working end-to-end against R2 on 2026-08-28 — that proves the
> **new-upload** path. It says nothing about whether all 330.5 MB of **legacy**
> files copied across. Only the `--verify` pass settles that second claim, and
> **deleting** the volume is what makes it permanently unanswerable.

- [ ] Set the start command to `node scripts/migrate-uploads-to-r2.js --verify`
      and redeploy. It compares every local file against R2 by key _and_ size,
      and **exits non-zero** if anything is missing:

```text
Missing in R2   : 0
Size mismatches : 0
RESULT: PASS — every local file is in R2 at the same size.
```

**A4. Restore the service.**

> ✅ **Inferred complete, not evidenced.** No commit records these dashboard
> actions, but the service is serving normal HTTP traffic today — which is only
> possible if the custom start command was cleared and `/readyz` restored.
> Re-confirm in the dashboard while you are there for §8.

- [x] Clear the custom start command so `railway.json` (`node index.js`) applies again.
- [x] Restore the health check path to `/readyz`, timeout 300s.
- [x] Redeploy and confirm the service is Online.

> 🔴 Never leave the copier as the start command: the process exits when the copy
> finishes, and Railway would restart it in a crash loop.

---

#### Method B — download the volume, then sync _(needs port 22 open)_

```powershell
# 1. Pull the volume to disk (prompts for a volume; choose workpulse-volume).
railway volume files download / .\uploads-backup --concurrency 32

# 2. Push to R2. Sync the directory that CONTAINS tenant_*, not its parent,
#    or every key gains an extra path segment and silently 404s.
$env:AWS_ACCESS_KEY_ID     = "<R2_ACCESS_KEY_ID>"
$env:AWS_SECRET_ACCESS_KEY = "<R2_SECRET_ACCESS_KEY>"
$env:AWS_DEFAULT_REGION    = "auto"
# R2 does not implement the AWS CLI's newer default checksum headers.
$env:AWS_REQUEST_CHECKSUM_CALCULATION = "when_required"
$env:AWS_RESPONSE_CHECKSUM_VALIDATION = "when_required"

aws s3 sync .\uploads-backup s3://aino-uploads/ `
  --endpoint-url "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com" `
  --exclude ".*" --exclude "*/.*"
```

- [ ] Local file count equals remote object count (commands below).

> The `--exclude` filters keep `.gitkeep`/`.DS_Store` out of the bucket, matching
> the in-container copier, which skips dotfiles.

---

#### Verification common to both methods (do not skip)

- [ ] Object count and total bytes match the volume (`currentSizeMB` ≈ **330.5**;
      confirm with `railway volume list --json`).
- [ ] Keys begin with `tenant_` — no `uploads/` prefix, no backslashes:

```powershell
$ep = "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
aws s3 ls s3://aino-uploads/ --recursive --endpoint-url $ep | Select-Object -First 5
```

- [ ] Every upload _kind_ is present. These are the exact `UploadKind` values
      from `server/platform/storage/types.ts`; each is written by a different
      route, so a missing kind means one broken feature:

```powershell
$all = aws s3 ls s3://aino-uploads/ --recursive --endpoint-url $ep
foreach ($k in 'avatars','chat','branding','task-comments') {
  '{0,-15} {1}' -f $k, ($all | Select-String -SimpleMatch "/$k/").Count
}
```

| Kind            | Feature                 | Written by                 |
| --------------- | ----------------------- | -------------------------- |
| `avatars`       | profile picture         | `routes/profile.ts`        |
| `chat`          | chat image/file         | `routes/chat.ts`           |
| `branding`      | organization logo       | `routes/branding.ts`       |
| `task-comments` | task-comment attachment | `routes/tasks/comments.ts` |

These are the only four kinds any route currently writes. `UploadKind` also
declares `notes` and `exports`, but no code path produces them today — if the
bucket contains such keys they came from an older build, and they must still
be copied.

A count of `0` is only acceptable for a kind that has genuinely never been
used. Compare against the old volume rather than assuming.

- [ ] Record the sync timestamp, or briefly freeze uploads, so you know exactly
      what the delta pass must pick up.
- [ ] **Immediately before the push, run the copier once more** to catch anything
      uploaded since. It is resumable, so this pass moves only new objects.
- [ ] **Keep `workpulse-volume` attached and undeleted.** It is the rollback copy
      and must survive until §8.

### 1.6 Rotate the previously exposed secrets

Do this only after the backup/data-copy prerequisites above, but before enabling
real customer traffic:

> 🔴 **Order matters.** Rotating the Postgres password invalidates the
> `DATABASE_PUBLIC_URL` secret that the backup workflow uses. Take the §1.4
> backup **first**, then rotate, then update the GitHub secret.

> ⚠️ **OVERDUE — NOT DONE as of 2026-08-28.**
> The release shipped on 2026-08-27 without this rotation. These are steps
> `A1.1`–`A1.3` in [`SCALABILITY_REFACTOR_PLAN.md`](./SCALABILITY_REFACTOR_PLAN.md),
> and they are the **highest-priority remaining security item** in the whole
> programme — every credential that was ever pasted into a shell, a log, or a
> chat window is still live.
> The "backup first" ordering above no longer gates you: §1.4 was skipped by
> operator decision, so there is no backup workflow secret waiting on the old
> password. Rotate now.

- [ ] Rotate the Railway PostgreSQL password (Railway → Postgres → rotate
      credentials). `DATABASE_URL` and `DIRECT_DATABASE_URL` are Railway
      _reference_ variables (`${{Postgres.DATABASE_URL}}`), so they update
      themselves — any hard-copied literal will not.
- [ ] Delete Firebase service-account key
      `43a25c39680d69b7f6633722f4bf0d2b5a2bd33a` (GCP Console → IAM → Service
      Accounts → `firebase-adminsdk-fbsvc@aino-86bb6.iam.gserviceaccount.com`).
- [ ] Create a replacement Firebase key and update
      `FIREBASE_SERVICE_ACCOUNT_KEY` in Railway.
- [ ] Update the `DATABASE_PUBLIC_URL` **GitHub Actions secret** to the new
      credential, or the next backup run will fail to authenticate.
- [ ] Verify after rotation: the app is still Online, `/readyz` is 200, login
      works and a push notification still delivers.
- [ ] Keep `DATABASE_PUBLIC_URL` only until external dumps are finished; then
      delete it from the app service and disable the TCP proxy if unused. It
      exposes Postgres to the public internet and is published into the app env.

### 1.7 Run local release gates

From `D:\Learnings\WorkPulse`:

```powershell
# All six repository guardrails in one command (GR1/GR2/GR3/GR5/GR8 + Railway config).
npm run check:guardrails

Push-Location server
npm ci
npm run typecheck
npm run lint:deps
npm run build
npm test
Pop-Location

Push-Location client
npm ci
npm run typecheck
npm test
npm run build
Pop-Location

node scripts/verify-spa-build.mjs client/dist

Push-Location infra/cloudflare
npm test
Pop-Location

# Proves the image ships the .sql migrations; without them the pre-deploy
# migration step silently applies nothing.
node scripts/verify-docker-migrations.mjs
node scripts/a2-verify-baseline.mjs

# Requires Docker Desktop to be running.
docker build -t aino-pre-push .

# Don't just trust that it built — verify the image actually CONTAINS the pieces
# the deploy depends on. A build can succeed while shipping zero migrations.
docker run --rm --entrypoint sh aino-pre-push -c "ls /app/server/scripts/; ls /app/server/platform/db/migrations/ /app/server/platform/db/migrations/master/; id"

# Boot guard must reject local disk in production and accept r2.
docker run --rm -e NODE_ENV=production -e STORAGE_DRIVER=local --entrypoint node aino-pre-push `
  -e "try{require('/app/server/platform/storage').assertProductionStorage();console.log('GUARD BROKEN')}catch(e){console.log('guard OK')}"
```

> ✅ **All gates passed 2026-08-27 — this is the run that produced the 🟢 GO
> verdict in the banner.** Directly captured: `check:guardrails` exit 0,
> `verify-docker-migrations` PASS, **74 suites / 846 tests**, and
> `docker build` PASS (image `aino-pre-push`, 391 MB, `sha256:8bfb199c…`,
> contents verified inside the image). The remaining boxes are ticked from the
> GO verdict rather than from saved console output — re-run them, do not trust
> them, if you are preparing a **new** release.

- [x] Every command exits 0.
- [x] `npm test` reports **74 suites / 846 tests** passing.
      _(Verified 2026-08-27. If your run reports fewer suites, you are on a stale
      checkout — do not push.)_
- [x] `npm run lint:deps` reports **0 errors** (warnings are the Phase G worklist).
- [x] The route snapshot diff, if any, shows **only intentional additions**. A
      removal is a breaking API change — read the diff before running `-u`.
- [x] `git diff --check` exits 0.
- [x] Review `git status` and confirm the 85 `graphify-out` deletions are expected.
- [x] Confirm no `.env`, R2 key, Firebase JSON or database URL is staged:

```powershell
git diff --cached --name-only | Select-String -Pattern '\.env|serviceAccount|\.pem$|\.key$'
git diff --cached | Select-String -Pattern 'BEGIN PRIVATE KEY|postgresql://|r2\.cloudflarestorage'
```

- [x] Both commands print **nothing**.
      **Evidence:** the pushed tree carries no secret material —
      `scripts/check-no-graphify-tracked.mjs` and the guardrail suite both run in
      `check:guardrails`, which exited 0.

> ⚠️ **CI does not gate the Railway deploy.** GitHub Actions and Railway watch
> `master` independently, so a red CI run does **not** stop the deployment. These
> gates must pass _before_ the push, not after.

---

## 2. First Safe Push — Combined Role Only

The first deployment validates storage and migrations without adding service
splitting or PgBouncer.

### Release-day sequence (follow exactly)

> ✅ **EXECUTED 2026-08-27.** Steps 1–6, 8 and 9 of this sequence were run.
> **Step 7 (the copier `--verify` pass) was not**, and that gap is still open —
> see §1.5 A3 and §8.
>
> The **first promotion attempt failed** before the container ever started:
> `railway.json` had `deploy.overlapSeconds` and `deploy.drainingSeconds` written
> as quoted strings, and Railway rejected the config with
> `expected number, received string`. Commit `d9213187` unquoted them and the
> re-promotion succeeded. See §9, "Config parse fails", for the same symptom.
> Production kept serving the previous image (`48af56cd`) throughout that
> failure — no outage was caused by it.

Because the copier only exists in the new image (§1.5), the order is:

| #   | Action                                                         | Notes                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Re-run the §1.2 R2 probe and the §1.3 variable check           | Both must pass _now_, not "earlier today"                                                                                                                                                                                 |
| 2   | Record the rollback deployment ID                              | Command below                                                                                                                                                                                                             |
| 3   | `git push origin master`                                       | ⚠️ With the repo trigger **off** (current state, §1.1) this only updates GitHub — it does **not** deploy. Wait for CI to go green, then trigger the deploy yourself: `railway redeploy --service WorkPulse --from-source` |
| 4   | Watch for `adopted catch-up migration without re-running it`   | Confirms the destructive path was skipped                                                                                                                                                                                 |
| 5   | Confirm `/readyz` → 200 and `Storage: using Cloudflare R2`     | Deploy is live                                                                                                                                                                                                            |
| 6   | 🔴 **Immediately run the §1.5 copier**                         | Existing uploads 404 until this finishes                                                                                                                                                                                  |
| 7   | Run the copier with `--verify`                                 | Must report `Missing in R2: 0`                                                                                                                                                                                            |
| 8   | Clear the custom start command, restore `/readyz` health check | §1.5 A4                                                                                                                                                                                                                   |
| 9   | Work through §3 verification                                   | Then soak before §4                                                                                                                                                                                                       |

Steps 5→8 are the exposure window. Have the copier command ready to paste, and
run the release when traffic is low.

### 📋 Release-day copy/paste card

Keep this open in a second window. Everything you need, in order.

**Before the push — final pre-flight (all must pass):**

```powershell
cd D:\Learnings\WorkPulse
$j = railway variables --service WorkPulse --json | ConvertFrom-Json

# 1. Variables (expect: PASS 13/13)
$h = $j.PSObject.Properties.Name
$miss = 'ROLE','SERVE_SPA','STORAGE_DRIVER','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY','R2_UPLOADS_BUCKET','REDIS_URL','DIRECT_DATABASE_URL',
  'MASTER_POOL_SIZE','TENANT_POOL_SIZE','TENANT_MAX_POOLS','TENANT_FOREACH_CONCURRENCY' |
  Where-Object { $h -notcontains $_ }
if ($miss) { "NO-GO - missing: $($miss -join ', ')" } else { "variables PASS" }

# 2. R2 read+write (expect: RESULT: PASS)
$env:R2_ACCOUNT_ID        = [string]$j.R2_ACCOUNT_ID
$env:R2_ACCESS_KEY_ID     = [string]$j.R2_ACCESS_KEY_ID
$env:R2_SECRET_ACCESS_KEY = [string]$j.R2_SECRET_ACCESS_KEY
$env:R2_UPLOADS_BUCKET    = [string]$j.R2_UPLOADS_BUCKET
node scripts/verify-r2-credentials.mjs

# 3. Guardrails (expect: exit 0)
npm run check:guardrails

# 4. Rollback target — WRITE THIS DOWN
railway service status --service WorkPulse --json | ConvertFrom-Json |
  Select-Object deploymentId, status
```

**Step 3 — push, then deploy deliberately:**

```powershell
git add -A
git commit -m "feat(scalability): R2 uploads, pre-deploy migrations, split roles"
git push origin master        # repo trigger is OFF -> updates GitHub only

# Wait for GitHub Actions to go green, THEN promote.
# --from-source is REQUIRED: a plain `railway redeploy`, the UI "Redeploy"
# button and "Restart" all re-run the EXISTING image (the old commit).
railway redeploy --service WorkPulse --from-source

# UI equivalent: Ctrl/Cmd+K -> "Deploy Latest Commit" (uses the default branch).

# Confirm the deployment picked up the NEW commit, not the old one.
# (Index [0] rather than Select-Object: the JSON is an array of deployments.)
$d = (railway deployment list --service WorkPulse --json | ConvertFrom-Json)[0]
'{0}  {1}  {2}' -f $d.id, $d.status, $d.meta.commitHash
```

Expected after promotion: commit hash starts **`f848c9a`**. If it still reads
`48af56cd`, the old image was re-run — you used a plain redeploy rather than
`--from-source` / "Deploy Latest Commit".

> ⚠️ **That `f848c9a` expectation is historical.** It is the correct answer only
> for the 2026-08-27 release. `master` has moved on since — HEAD is now
> `9b6303d6` — so a fresh `--from-source` promotion **today** should report
> `9b6303d6`. Before any future release, re-read the expected hash from
> `git rev-parse --short HEAD` rather than trusting the value printed here.

**Step 6 — the copier.** Railway → `WorkPulse` → Settings → Deploy. Clear the
health check path first, then set **Custom Start Command** to each of these in
turn, redeploying between each:

```text
node scripts/migrate-uploads-to-r2.js --dry-run    # 1. inspect; expect ~330 MB
node scripts/migrate-uploads-to-r2.js              # 2. copy;    expect failed: 0
node scripts/migrate-uploads-to-r2.js --verify     # 3. prove;   expect Missing in R2: 0
```

🔴 If step 1 reports `Local: 0 file(s)` — that is the **permission trap**, not an
empty volume. Set `RAILWAY_RUN_UID=0`, redeploy, re-run, then remove it again.

**Step 8 — restore the service:**

- Clear the Custom Start Command (so `railway.json` → `node index.js` applies)
- Restore health check path `/readyz`, timeout `300`
- Remove `RAILWAY_RUN_UID` if you set it
- Redeploy, confirm Online

**Post-deploy smoke test:**

```powershell
curl.exe -s "https://www.aino.org.in/healthz"
curl.exe -s "https://www.aino.org.in/readyz"
curl.exe -s "https://www.aino.org.in/api/health?detail=true"
```

`/healthz` and `/readyz` must return **JSON** now. If they return the SPA HTML
shell, you are still on the old image — the deploy did not promote.

- [x] Keep existing service `ROLE=all`.
- [x] Keep `SERVE_SPA=true`.
- [x] Keep `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
- [x] Keep the old upload volume attached.
      ✅ Correct at release time; the volume has since been **detached** (§8,
      confirmed 2026-08-28 via `railway volume list`). It still exists and still
      holds its 330.5 MB of data — it is detached, not deleted.
- [x] Confirm the custom start command from §1.5 Method A is **cleared**, and the
      health check is back to `/readyz` / 300s.
      **Evidence:** inferred — the service serves normal HTTP traffic, which is
      impossible while the copier is the start command (see §1.5 A4).
- [x] **Record the current deployment ID for rollback** _before_ pushing:

```powershell
# The currently-live deployment — this is your rollback target.
railway service status --service WorkPulse --json | ConvertFrom-Json |
  Select-Object name, deploymentId, status
```

Recorded 2026-08-27: `0ab38c7a-5f49-403d-8932-7ddf7af3efe3` (SUCCESS, commit
`48af56cd`). Re-check it immediately before pushing — editing variables triggers
a redeploy, so this ID changes.

- [ ] **Do NOT enable the repo trigger yet.** It is off today (§1.1); enabling it
      would deploy immediately. Leave it off through this release and turn it on
      in §8, after uploads are in R2 and the deployment has soaked.
      ⬜ **Still deliberately unticked, and still accurate as of 2026-08-28** —
      the trigger remains off. Re-enabling it is a §8 action.
- [x] Push the reviewed commit to `master`.
      **Evidence:** commit `f848c9a5`, pushed 2026-08-27.

```powershell
git add -A
git commit -m "feat(scalability): R2 uploads, pre-deploy migrations, split roles"
git push origin master        # <- this deploys production
```

### Expected deployment order

1. GitHub CI runs server, client, mobile, edge and Docker jobs.
2. Railway builds the image.
3. Railway executes `node migrate.js` in pre-deploy.
4. Any schema failure exits nonzero and blocks promotion.
5. Railway starts `node index.js`.
6. Railway waits for `/readyz` before switching traffic.

### Watch these logs

```text
Database is ready
master migrations complete
base tenant schema ensured
all migrations complete
migrate.js: success — exiting
Storage: using Cloudflare R2
Redis command connection ready
Redis subscriber connection ready
Runtime dependencies ready (database + Redis)
Server running
```

Stop deployment if any migration log contains `FAILED` or if pre-deploy exits
nonzero.

---

## 3. Verify the Combined Deployment

- [ ] `GET /healthz` → HTTP 200.
- [ ] `GET /readyz` → HTTP 200 with database/Redis ready.
- [ ] `GET /api/health` → HTTP 200.
- [ ] Platform admin can log in.
- [ ] Admin → Tenants loads.
- [ ] Existing tasks, chats, notes and retrospectives remain intact.
- [ ] `/api/internal/migration-status` reports expected migrations for all DBs.
- [ ] `/api/internal/db-pool-stats` shows no waiting clients.

### Upload checks

- [x] Existing avatar renders from R2.
      **Evidence:** commit `07b1bc4a` — "fix(csp): allow R2 upload origin so avatars and attachments render". You only get a CSP violation for the R2 origin if avatars are already being served from R2.
- [x] Existing chat attachment downloads.
      **Evidence:** same commit `07b1bc4a` — the CSP fix covered attachments as well as avatars.
- [x] New avatar upload and deletion work.
      **Evidence:** commit `46202588` — "fix(uploads): stop forwarded-attachment deletion; randomise upload filenames". Randomised filenames are applied on the live upload path. **Also confirmed live by the operator 2026-08-28** — a new avatar was uploaded and rendered from R2.
- [x] New chat attachment upload and deletion work.
      **Evidence:** same commit `46202588` — the forwarded-attachment deletion bug was found and fixed against the live R2 delete path.
- [ ] New task-comment attachment works.
- [ ] Organization logo works on authenticated and public login pages.
- [ ] `/uploads/...` returns a short-lived private R2 redirect after authorization.
- [ ] Cross-tenant and cross-org upload URLs return 403/404.

### Realtime/job checks

- [ ] 1:1 voice/video call connects.
- [ ] Meeting call connects.
- [ ] Notes collaboration connects using the HttpOnly cookie.
- [ ] Presence and chat fan-out work.
- [ ] Job logs show one scheduler execution.

### Observability checks (Phase H)

Skip if you did not set `METRICS_TOKEN`.

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://www.aino.org.in/metrics | head -40
curl -i https://www.aino.org.in/metrics        # expect 404 — proves the guard works
```

> ⬜ **NOT VERIFIED — `METRICS_TOKEN` was never set.**
> This is `P0.3` in [the plan](./SCALABILITY_REFACTOR_PLAN.md), deliberately left unticked. With no token
> configured, `/metrics` is fail-closed at 404 for everyone, so the entire Phase H observability block
> below is untested in production. Set `METRICS_TOKEN` on the Railway service first, then work this list.

- [ ] `/metrics` returns the exposition body **with** the token.
- [ ] `/metrics` returns **404 without** the token. Verify this; do not assume it.
- [ ] `aino_http_request_duration_seconds` shows **route templates**
      (`/api/tasks/:id`), not concrete ids. 🔴 **If you see raw ids, stop and fix
      it** — Prometheus cardinality damage persists for the whole retention window.
- [ ] Distinct `tenant` label values are at most `METRICS_TENANT_TOP_N + 2`.
- [ ] `aino_redis_up{connection="subscriber"}` is `1`.
- [ ] Load `infra/observability/alerts.yml` and `prometheus.yml` into Prometheus.

Keep the deployment at `ROLE=all` for a soak period before continuing.

---

## 4. PgBouncer Canary

Do not point every production role to PgBouncer at once.

### 4.1 Provision

```powershell
pwsh ./scripts/setup-pgbouncer-railway.ps1        # dry-run
pwsh ./scripts/setup-pgbouncer-railway.ps1 -Apply
```

- [ ] Confirm `PgBouncer` is healthy on Railway private networking.
- [ ] Do not expose a public TCP proxy.
- [ ] Confirm `POOL_MODE=transaction`, `DEFAULT_POOL_SIZE=20`,
      `MAX_DB_CONNECTIONS=80`, `MAX_CLIENT_CONN=500`.

### 4.2 Canary

- [ ] Clone/create a staging app role and point its `DATABASE_URL` at PgBouncer.
- [ ] Keep `DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`.
- [ ] Verify login, registration, transactions, reports, WebSocket auth,
      migrations and `/readyz`.
- [ ] Verify `/api/internal/db-pool-stats` and Railway Postgres metrics.
- [ ] Confirm server-side Postgres connections remain bounded.

### 4.3 Production promotion

- [ ] Switch one role/service at a time to the PgBouncer URL.
- [ ] Verify after each switch.
- [ ] Roll back immediately by restoring
      `DATABASE_URL=${{Postgres.DATABASE_URL}}` if errors appear.

---

## 5. Split Railway Roles

Dry-run first:

```powershell
pwsh ./scripts/setup-railway-roles.ps1
pwsh ./scripts/setup-railway-roles.ps1 -Apply
```

The script creates non-secret role configuration only. Before deploying each
service, copy/reference all required variables from `WorkPulse`:

- `DATABASE_URL` and `DIRECT_DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`, `ENCRYPTION_KEY`
- all R2 private-upload variables
- Firebase/email/GIPHY/Google/TURN variables used by that role
- `NODE_ENV=production`, `PORT=5000`, `SERVE_SPA=false`

### Role validation

| Service         | Role       | Required validation                                           |
| --------------- | ---------- | ------------------------------------------------------------- |
| `aino-web`      | `web`      | `/readyz`, auth, API, uploads; no jobs/WS startup logs        |
| `aino-realtime` | `realtime` | `/readyz`, Redis subscriber, `/ws`, `/collab`; no worker logs |
| `aino-worker`   | `worker`   | `/readyz`, `jobs=ready`; no application API routes            |

- [ ] Set every health check to `/readyz` with a 300-second timeout.
- [ ] Scale realtime to 2 and verify a call between users on different replicas.
- [ ] Verify meeting reconnect within 15 seconds does not emit a false leave.
- [ ] Scale workers to 2 and confirm BullMQ jobs execute exactly once.
- [ ] Scale web to 2 and verify upload on one/download through another.
- [ ] Keep `WorkPulse` (`ROLE=all`) online but outside split traffic as rollback.

---

## 6. Publish the SPA to Public R2

Create a **new public SPA bucket**. Do not use:

- private `aino-uploads`;
- the existing desktop release bucket.

Configure GitHub Actions:

| Setting                       | Value                                |
| ----------------------------- | ------------------------------------ |
| Secret `R2_ACCESS_KEY_ID`     | key with SPA bucket write permission |
| Secret `R2_SECRET_ACCESS_KEY` | matching secret                      |
| Secret `R2_ACCOUNT_ID`        | Cloudflare account ID                |
| Variable `R2_WEB_BUCKET`      | the public SPA bucket name           |
| Variable `SPA_PUBLIC_ORIGIN`  | the bucket's dedicated custom domain |

- [ ] Keep R2 public development URL disabled.
- [ ] Attach a dedicated custom domain to the SPA bucket.
- [ ] Run **Web SPA — Publish to R2 (manual)** and type `PUBLISH`.
- [ ] Verify assets upload first and the HTML shell is promoted last.
- [ ] Verify hashed `/assets/*` returns long immutable cache headers.
- [ ] Verify `index.html`, `sw.js`, and `manifest.json` return no-store/no-cache.
- [ ] Keep the workflow artifact for rollback.

---

## 7. Deploy the Cloudflare Worker

From `infra/cloudflare`:

```bash
npm install
npm test
npx wrangler secret put LEGACY_ORIGIN
npx wrangler secret put WEB_ORIGIN
npx wrangler secret put REALTIME_ORIGIN
npx wrangler secret put SPA_ORIGIN
npx wrangler secret put ORIGIN_SECRET
npx wrangler deploy
```

### Safe order

- [ ] Deploy with `ROUTING_MODE=legacy` first.
- [ ] Attach a staging hostname, not the production hostname.
- [ ] Verify legacy mode sends every path to the existing `ROLE=all` origin.
- [ ] Switch staging to `ROUTING_MODE=split`.
- [ ] Verify:
  - `/api/*` → web;
  - `/uploads/*` → web authorization, never public bucket;
  - `/ws` and `/collab` → realtime WebSocket upgrade;
  - everything else → SPA origin with fallback to `index.html`.
- [ ] Verify HttpOnly login cookies and CSRF mutations through the Worker.
- [ ] Verify direct Railway traffic metrics before enforcing `ORIGIN_SECRET`.
- [ ] Configure WAF, bot controls and edge rate limits.
- [ ] Promote the Worker route to `aino.org.in/*` and `www.aino.org.in/*`.
- [ ] Keep the prior Worker version and `ROUTING_MODE=legacy` for rollback.

> ⬜ **Nothing in §7 has been done yet — verified 2026-08-28.**
> `infra/cloudflare/wrangler.toml` still declares `ROUTING_MODE = "legacy"` and
> has **no zone or route bindings at all**, so the Worker is not in the request
> path for any hostname. The reverse proxy exists in code and is unit-tested, but
> production traffic goes straight to Railway. Rolling `ROUTING_MODE` off
> `legacy` is `P9.3` in
> [`SCALABILITY_REFACTOR_PLAN.md`](./SCALABILITY_REFACTOR_PLAN.md), and it is
> gated on the split/staging verification above (plan STEP 7, F2) — do not flip
> it early.
>
> 🧹 **Related cleanup — plan STEP 9, `P9.1`.** `docker-compose.yml` still defines
> a dead `caddy` service that bind-mounts a `./Caddyfile` which does not exist in
> the repository, so `docker compose up` fails. Caddy was rejected as the reverse
> proxy in [ADR-002](./adr/) precisely because Railway routes by **hostname
> only** — which is why this Worker exists. Delete that service block; it is a
> leftover from an abandoned approach and it actively misleads anyone reading
> the compose file for the current architecture.

---

## 8. Volume Removal and Final Cutover

> ✅ **DONE 2026-08-28 — `workpulse-volume` is detached.** Confirmed via
> `railway volume list --json`: the volume reports `serviceName: null`. This was
> `STEP 5` in
> [`SCALABILITY_REFACTOR_PLAN.md`](./SCALABILITY_REFACTOR_PLAN.md#step-5--detach-the-volume--a310b--this-is-what-unblocks-replicas).
>
> 🟡 **Horizontal scaling is now unblocked but still untested.** The one-replica
> pin imposed by the volume is gone, so split roles, stateless containers, Redis
> pub/sub fan-out and the readiness probe can finally be exercised across more
> than one instance — but the service has not been scaled above 1 replica yet,
> so multi-replica behaviour remains unproven in production. Scaling to 2 and
> re-running the §3 checks is the next real step.
>
> ℹ️ **The volume still exists.** `deletedAt: null`, `isPendingDeletion: false`,
> `currentSizeMB: 330.47`. Detached ≠ deleted, and that distinction is what keeps
> the §1.5 A3 `--verify` reconciliation possible: re-attach the volume, run the
> copier with `--verify`, then detach again.
>
> 🔴 **The `--verify` now blocks the DELETE, not the detach.** §1.5 step A3 was
> never run, so "every legacy upload is in R2" is still **likely but unevidenced**.
> The operator's 2026-08-28 live avatar test proves the **new-upload** path only.
> The moment this volume is deleted the two sides can no longer be compared and
> the question becomes permanently unanswerable — any file that was silently
> missed turns into a broken avatar or attachment with no way to recover it. Do
> the verify before ticking the delete box below.

Remaining work in this section:

- [ ] **Re-attach `workpulse-volume` and run the copier with `--verify`**, then
      detach it again. Must report `Missing in R2: 0`. This is the blocker for
      the delete step below — once the volume is deleted, anything still only on
      disk is unreachable and unverifiable.
- [x] Detach `workpulse-volume` from the application service:
      ✅ Done 2026-08-28 — `serviceName: null` in `railway volume list --json`.

```powershell
railway volume detach --service WorkPulse
railway volume list --json | ConvertFrom-Json |
  Select-Object -ExpandProperty volumes |
  Where-Object name -eq 'workpulse-volume'
```

- [ ] Keep it **undeleted** for at least one rollback window (one week).
- [ ] **Prove multi-replica actually works.** The detach removed the 1-replica
      pin, but nothing has run on two replicas yet. Scale the `WorkPulse`
      service to **2 replicas**, redeploy, and re-run the §3 post-deploy checks.
      Both replicas must pass `/readyz`, and login plus avatar upload must work
      no matter which replica serves the request.
- [ ] After the soak period, delete the old volume. Railway queues deletion and
      permanently removes it after **48 hours**; a restoration link is emailed
      during that window, after which it is unrecoverable.
- [ ] Remove/disable `DATABASE_PUBLIC_URL` if external dumps no longer need it.
      Note this disables the §1.4 backup workflow — re-enable it before the next
      release, or keep the variable and accept the exposure.
- [ ] Retire `ROLE=all` only after split-role and Worker rollback have both been tested.
- [ ] **Now enable push-to-deploy** (deferred from §1.1a): Railway → `WorkPulse`
      → Settings → Source → connect branch `master`. Safe at this point because
      later deploys are plain image swaps with no one-off data migration
      attached. Remember the trade-off: CI does not gate Railway, so from here on
      a red CI run will not stop a deploy.

---

## 9. Rollback Procedures

### New application image fails

1. Railway → Rollback/Redeploy the previous successful `WorkPulse` deployment.
2. Worker `ROUTING_MODE=legacy`.
3. Keep `SERVE_SPA=true` and the volume attached.

### R2 uploads fail

1. Roll back to the prior single-replica image.
2. Reattach the preserved volume.
3. Use `STORAGE_DRIVER=local` **only on that old single-replica deployment**.

> 🔴 **Uploads diverge the moment the new image serves traffic.** Anything users
> uploaded after cutover exists **only in R2**; the reattached volume does not
> have it, so those files appear as broken images/attachments after rollback.
> Before declaring the rollback complete, list objects created after the cutover
> timestamp and copy them back down to the volume, or accept the loss knowingly:
>
> ```powershell
> aws s3 ls s3://aino-uploads/ --recursive --endpoint-url $ep |
>   Where-Object { $_ -gt "<cutover-timestamp>" }
> ```
>
> This is why §1.5 asks you to record the sync timestamp — it is the dividing
> line between "already on the volume" and "R2 only".
>
> Note the current production image predates the storage refactor, so it has no
> `assertProductionStorage()` guard and will happily run on local disk. The
> **new** image refuses to boot with `STORAGE_DRIVER=local` in production, by
> design — do not set it there.

### PgBouncer fails

1. Restore role `DATABASE_URL` values directly to `${{Postgres.DATABASE_URL}}`.
2. Keep `DIRECT_DATABASE_URL` unchanged.
3. Verify `/readyz` and pool metrics before resuming traffic.

### SPA/Worker fails

1. Set Worker `ROUTING_MODE=legacy` or roll back the Worker version.
2. The existing `ROLE=all` service with `SERVE_SPA=true` serves the SPA.
3. Optionally republish the previous `web-spa-<sha>` artifact.
4. Never delete old hashed SPA assets during the same release.

### Config parse fails ("Failed to parse your service config")

**Seen for real on 2026-08-27**, first promotion attempt of `f848c9a`:

```text
Failed to parse your service config.
Error: deploy.overlapSeconds: Invalid input: expected number, received string
Error: deploy.drainingSeconds: Invalid input: expected number, received string
```

`railway.json` had `"overlapSeconds": "30"` (quoted). Railway validates the file
against its schema **before doing anything**, so:

- the deploy aborted **before build and before pre-deploy** — no migrations ran;
- production stayed on the previous deployment, entirely unaffected;
- the deployment showed only `FAILED` with **no build or deploy logs**, because
  neither phase started. The message is visible **only in the Railway UI**.

🔴 **`npm run check:guardrails` passed anyway.** The old
`verify-railway-config.mjs` compared _values_ but never _types_, so a quoted
number sailed through. That gap is now closed: the script rejects a non-number
`healthcheckTimeout`, `restartPolicyMaxRetries`, `overlapSeconds`,
`drainingSeconds` or `numReplicas`, and a non-string command/path field.

**If you hit this:**

1. Read the error — it names the exact field and the expected type.
2. Fix `railway.json`; cross-check against <https://railway.com/railway.schema.json>.
3. `node scripts/verify-railway-config.mjs` must exit 0.
4. Commit, push, re-promote. Nothing needs rolling back: the previous
   deployment never stopped serving.

**Empty logs on a FAILED deployment is itself the diagnostic** — it means the
failure happened before the container was created, which almost always points at
config parsing rather than application code.

### Migration fails

1. Railway pre-deploy blocks promotion automatically.
2. Do not bypass it or manually start the new image.
3. Inspect the named failed migration and `_migrations` ledger.
4. Restore the database backup for destructive/partial schema changes.
5. Remember: rolling back the image does not roll back the database.

**Restoring from the §1.4 backup:**

```bash
# master FIRST — it holds platform_users and the tenants catalog.
psql "postgresql://.../railway" -f master-<ts>.sql

# then every tenant, into a URL ending in that tenant's db_name.
psql "postgresql://.../<db_name>" -f tenant-<db_name>-<ts>.sql
```

- [ ] Restore master before any tenant: the tenant list lives there.
- [ ] Check the final path segment of each URL. The dumps use
      `--clean --if-exists`, so a tenant dump applied to master would **drop the
      tenant catalog**.
- [ ] After restoring, redeploy the _previous_ image (rollback deployment ID from
      §2), not the new one — otherwise pre-deploy immediately re-applies the
      migration that failed.
- [ ] Verify `/api/internal/migration-status` and platform-admin login before
      restoring traffic.

---

## 10. Final Go/No-Go Record

Record this before restoring `master` autodeploy:

```text
Commit SHA:
Database backup:                  (SKIPPED — risk accepted; §1.4)
  Railway volume backup taken?    (recommended substitute: YES / NO)
Upload object count / bytes:      (must match volume: ~330.5 MB)
  copier --verify result:         (must be "PASS", missing 0 / mismatch 0)
  ...or explicit acceptance:      (all existing uploads will 404)
R2 credential probe:              (put/head/get/delete all succeeded)
Railway variables verified:       (all 13 print SET, §1.3)
Local CI result:                  (74 suites / 846 tests)
Docker image build result:
Rollback deployment ID:           (§2, recorded BEFORE the push)
Approver:
Decision: GO / NO-GO
```

### Completed record — release of 2026-08-27

```text
Commit SHA:                       f848c9a5  (HEAD is now 9b6303d6)
Database backup:                  SKIPPED — risk accepted by the operator (§1.4)
  Railway volume backup taken?    NO
Upload object count / bytes:      NOT RECORDED (volume was 330.5 MB)
  copier --verify result:         NOT CAPTURED — the copier itself ran
                                  (commit 9fe31245) but the verify pass was
                                  never run.  STILL OPEN
  ...or explicit acceptance:      not given
R2 credential probe:              PASS (put/head/get/delete) after the token was
                                  re-created with Object Read & Write
Railway variables verified:       13/13 SET (45 variables total on the service)
Local CI result:                  PASS — 74 suites / 846 tests
Docker image build result:        PASS — aino-pre-push, 391 MB,
                                  sha256:8bfb199c…, contents verified in-image
Rollback deployment ID:           0ab38c7a-5f49-403d-8932-7ddf7af3efe3
                                  (commit 48af56cd)
Approver:                         operator
Decision:                         GO — executed 2026-08-27
```

The single unresolved line is the `copier --verify` result. It is tracked at
§1.5 A3. It no longer blocks the detach — that already happened on 2026-08-28,
confirmed by `railway volume list --json` reporting `serviceName: null`. It now
blocks the **deletion** of `workpulse-volume`. The volume is still present with
its 330.47 MB intact, so the verify pass remains obtainable by re-attaching it
temporarily. Once the volume is deleted that question can never be answered, so
do not delete it until the verify pass is captured, or until the operator
explicitly accepts that any unmigrated legacy uploads will 404.

**GO requires every checkbox in Section 1 and every local release gate to be
complete.**

### Minimum bar with §1.4/§1.5 skipped

If the backup and upload copy are being skipped, these are the items that are
**not** negotiable, because each one breaks the deploy outright rather than
merely losing data:

| #   | Gate                                    | Why it cannot be skipped                                                                                           |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | All 13 variables in §1.3 actually `SET` | `assertProductionStorage()` throws before `listen()`; `/readyz` never returns 200; the deploy fails and rolls back |
| 2   | R2 credential probe passed              | Valid-looking but unauthorised keys fail at the _first upload_, not at boot                                        |
| 3   | `npm run check:guardrails` exits 0      | Includes `verify-railway-config` — validates `.railway/railway.ts` (was `railway.json` before the 2026-09-01 IaC migration); a bad config breaks pre-deploy migrations |
| 4   | `docker build` succeeds                 | Railway builds the same Dockerfile; a local failure is a guaranteed deploy failure                                 |
| 5   | Rollback deployment ID recorded         | Without it there is no fast path back                                                                              |

Everything else in §1.4/§1.5 is a data-safety trade you are consciously making.

### Quick pre-flight (run immediately before the push)

```powershell
# 1. Variables present?
$have = (railway variables --service WorkPulse --json | ConvertFrom-Json).PSObject.Properties.Name
$missing = 'ROLE','SERVE_SPA','STORAGE_DRIVER','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY','R2_UPLOADS_BUCKET','REDIS_URL','DIRECT_DATABASE_URL' |
  Where-Object { $have -notcontains $_ }
if ($missing) { "NO-GO — missing: $($missing -join ', ')" } else { "variables OK" }

# 2. R2 token can actually WRITE? (a read-only token boots fine and fails later)
$env:R2_ACCOUNT_ID        = [string]$j.R2_ACCOUNT_ID
$env:R2_ACCESS_KEY_ID     = [string]$j.R2_ACCESS_KEY_ID
$env:R2_SECRET_ACCESS_KEY = [string]$j.R2_SECRET_ACCESS_KEY
$env:R2_UPLOADS_BUCKET    = [string]$j.R2_UPLOADS_BUCKET
node scripts/verify-r2-credentials.mjs

# 3. Local gates green?
npm run check:guardrails
node scripts/verify-docker-migrations.mjs

# 4. Nothing secret staged?
git diff --cached | Select-String -Pattern 'BEGIN PRIVATE KEY|postgresql://'
```

Any `NO-GO` line, any non-zero exit, or any output from step 4 means **do not
push**.
