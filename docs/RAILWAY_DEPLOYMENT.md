# AINO — Railway Deployment Guide

Production deployment on Railway with managed PostgreSQL, Redis, Cloudflare R2,
role-specific services, and GitHub-driven CI/CD.

> 🔴 **Before pushing to `master`, follow the authoritative ordered checklist in
> [`PRE_PUSH_DEPLOYMENT_RUNBOOK.md`](PRE_PUSH_DEPLOYMENT_RUNBOOK.md).** A push
> automatically deploys production. This guide describes the target shape; the
> runbook contains the safety gates, backup/data-copy order and rollback steps.

---

## Architecture Overview

```
Internet
   │
   ▼ (HTTPS — automatic, via Railway)
┌─────────────────────────────────┐
│   Railway Project               │
│                                 │
│  ┌───────────────────────────┐  │
│  ┌───────────────────────────┐  │ ← ROLE=web (HTTP API)
│  │  aino-web                 │  │
│  └────────────┬──────────────┘  │
│  ┌───────────────────────────┐  │ ← ROLE=realtime (WS + collab)
│  │  aino-realtime            │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │ ← ROLE=worker (BullMQ + probes)
│  │  aino-worker              │  │
│  └───────────────────────────┘  │
│               │ DATABASE_URL    │
│  ┌────────────▼──────────────┐  │
│  │  PostgreSQL Plugin        │  │ ← Managed, no external port
│  │  (Railway-managed)        │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │  Redis + PgBouncer        │  │ ← shared cache/queue + DB pooling
│  └───────────────────────────┘  │
└─────────────────────────────────┘

Cloudflare routes `/api` + authenticated `/uploads` to web, `/ws` + `/collab`
to realtime, and public SPA paths to a dedicated R2 bucket. Tenant uploads live
in the separate **private** `aino-uploads` bucket.
```

**What Railway handles automatically:**
- HTTPS / TLS certificates (no Caddy or Nginx needed)
- Managed PostgreSQL and Redis with private reference variables
- Deployments triggered on every push to `master`
- Pre-deploy migrations via `node migrate.js` (failure blocks promotion)
- Health checks via `/readyz`; liveness via `/healthz`
- Container restarts on crash

---

## Prerequisites

- A [Railway](https://railway.com) account (sign up with GitHub)
- The WorkPulse repo connected to your GitHub account

---

## Step 1: Create a Railway Project

1. Go to [railway.com](https://railway.com) → **New Project** → **Empty Project**
2. Name it `WorkPulse`

---

## Step 2: Add PostgreSQL

1. Inside the project → **+ Add Service** → **Database** → **PostgreSQL**
2. Railway spins up a managed Postgres instance and makes `DATABASE_URL` available to services in the project

---

## Step 3: Add the App Service

1. **+ Add Service** → **GitHub Repo** → select your `WorkPulse` repository
2. Railway detects the `Dockerfile` automatically — no `railway.json` needed
3. Set **Deploy Branch** to `master`

---

## Step 4: Configure Environment Variables

In your app service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `JWT_SECRET` | Run `openssl rand -base64 48` locally and paste the result |
| `NODE_ENV` | `production` |
| `PORT` | `5000` |
| `USE_HTTPS` | `false` |
| `DATABASE_URL` | PgBouncer private URL after canary; direct Postgres before then |
| `DIRECT_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` for pre-deploy migrations |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` — mandatory in production |
| `ROLE` | `all`, `web`, `realtime`, or `worker` |
| `STORAGE_DRIVER` | `r2` |
| `R2_UPLOADS_BUCKET` | `aino-uploads` |

> `${{Postgres.DATABASE_URL}}` is Railway's **reference variable** syntax — it pulls the live connection string from the PostgreSQL service. The name `Postgres` must match your PostgreSQL service name exactly (check the service title in your project).

Optional — observability (Phase H). Safe to omit; the app runs without them:

| Variable | Value |
|---|---|
| `METRICS_TOKEN` | Bearer token a Prometheus scraper must send to `GET /metrics`. **Without it `/metrics` returns 404 in production** (fail-closed). Use the same value on every service. |
| `METRICS_TENANT_TOP_N` | Tenants that get their own metric label before the rest fold into `other`. Default `20`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL. **Setting this enables tracing**; leave unset to disable. |
| `OTEL_EXPORTER_OTLP_HEADERS` | e.g. `authorization=Bearer <token>` |

Optional — only needed if you use email features:

| Variable | Value |
|---|---|
| `SMTP_HOST` | Your SMTP host |
| `SMTP_PORT` | e.g. `587` |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address |
| `GMAIL_CLIENT_ID` | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Google OAuth refresh token |

---

## Step 5: Configure Port & Health Check

In your app service → **Settings**:

- **Port**: `5000`
- **Health Check Path**: `/readyz`
- **Pre-deploy Command**: `node migrate.js`
- **Start Command**: `node index.js`

---

## Step 6: Configure Private R2 Upload Storage

Uploads are stored in private Cloudflare R2. The old `/app/server/uploads`
volume is rollback-only during migration and must be detached after the R2 copy
and two-replica verification. See the pre-push runbook; do not create a new
application upload volume.

---

## Step 7: Get Your Domain & Verify

1. App service → **Settings** → **Networking** → **Generate Domain**
2. Copy the domain (e.g., `workpulse-production-e703.up.railway.app`)
3. Once deployed, verify the app is running:

```
https://your-domain.up.railway.app/api/health
```

Should return `{"status":"ok","time":"..."}`.

---

## Step 8: Create Your First Account

1. Open `https://your-domain.up.railway.app` in your browser
2. Click **Register** and create your account
3. Promote yourself to Super Admin via the Railway DB shell:
   - Railway → **PostgreSQL service** → **Data** tab → open the query editor
   - Run:
     ```sql
     UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';
     ```
4. Log out and log back in — the **Admin** tab will appear

---

## CI/CD (GitHub Actions)

Pushes to `master` trigger two things in parallel:

1. **GitHub Actions** (`.github/workflows/ci.yml`) — runs tests and validates the Docker image builds
2. **Railway** — detects the push via GitHub integration and deploys automatically

No Railway CLI or deploy tokens are required in CI. Railway handles deployment independently.

---

## Updating the App

Push to `master` — Railway deploys automatically. No manual steps needed.

To trigger a manual redeploy without a code change:

- Railway → app service → **Redeploy**

---

## Database Management

### Interactive DB shell

Railway → **PostgreSQL service** → **Data** tab → use the built-in query editor.

Or connect with any PostgreSQL client using the connection string from:

Railway → PostgreSQL → **Connect** tab → copy the connection URL.

### Check DB size

```sql
SELECT pg_size_pretty(pg_database_size(current_database()));
```

### Backup

Run locally using the Railway connection string:

```bash
pg_dump "postgresql://postgres:<password>@<host>:<port>/railway" \
  --clean --if-exists > workpulse_backup.sql
```

### Restore

```bash
psql "postgresql://postgres:<password>@<host>:<port>/railway" < workpulse_backup.sql
```

> Railway Pro plan includes automated point-in-time recovery. On Hobby, set up a Railway [Cron Service](https://docs.railway.com/reference/cron-jobs) that runs `pg_dump` on a schedule and uploads to Cloudflare R2 or S3.

---

## Custom Domain (Optional)

Railway provides a free `.up.railway.app` subdomain. To use your own domain:

1. App service → **Settings** → **Networking** → **Custom Domain** → enter your domain
2. Railway shows you a `CNAME` record to add at your DNS provider
3. TLS is provisioned automatically — no Certbot needed

---

## Troubleshooting

### `DATABASE_URL environment variable is not set`

The reference variable isn't wired. Go to app service → **Variables** → ensure `DATABASE_URL` is set to `${{Postgres.DATABASE_URL}}` and that the name `Postgres` matches your PostgreSQL service name exactly.

### `EACCES: permission denied, mkdir '/app/server/uploads/avatars'`

The volume mount is owned by root at runtime. The `entrypoint.sh` script fixes this automatically. If the error persists, trigger a fresh **Redeploy**.

### `Not allowed by CORS`

The CORS middleware uses the `Host` request header to allow same-origin requests automatically. Ensure you are accessing the app via the Railway HTTPS domain, not a raw IP or custom port.

### Registration returns 500

Check runtime logs: Railway → app service → **Observability** → **Logs** → switch to **Runtime**. Look for `Register error`. Common causes:

- Tables not yet created — trigger a **Redeploy** so `initDB()` runs
- DB connection error — verify `DATABASE_URL` in Variables resolves to an actual `postgresql://...` string, not the raw `${{...}}` text

### `Application failed to respond`

Railway's proxy can't reach the app on the configured port. Verify:
- `PORT=5000` is set in Variables
- App service Settings → Networking → port is `5000`

### Health check failing on deploy

Railway builds and deploys the Docker image independently — the first build after a push takes 2–5 minutes. The health check window is 5 minutes by default. If the app starts within that window the deployment succeeds.

### Registration mode shows "Closed"

Run this in the Railway PostgreSQL Data tab:

```sql
UPDATE app_settings SET value = 'open' WHERE key = 'registration_mode';
```
