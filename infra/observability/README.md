# Observability (Phase H)

Everything here is configuration for systems **outside** the app. The app-side
implementation lives in `server/platform/metrics/`.

| File | Purpose |
|---|---|
| `alerts.yml` | Prometheus alerting rules — the H5 SLOs |
| `prometheus.yml` | Example scrape config for the three Railway roles |
| `k6/load-test.js` | H6 ramped load test (100 tenants × 50 VUs) |

## Scraping

`GET /metrics` is exposed by **all three roles** (`web`, `realtime`, `worker`)
and is **token-guarded**:

```
Authorization: Bearer $METRICS_TOKEN
```

Without `METRICS_TOKEN` the endpoint returns **404 in production** and is open
in development. It returns 404 rather than 401 so an unauthenticated caller
does not learn the endpoint exists.

> Set `METRICS_TOKEN` to the same value on every Railway service, otherwise
> only some replicas will be scrapable and the dashboards will show gaps that
> look like outages.

## What is exported

| Metric | Type | Why it exists |
|---|---|---|
| `aino_http_request_duration_seconds` | histogram | p95 latency SLO; labelled by **route template**, never the raw URL |
| `aino_http_requests_total` | counter | error-rate SLO, by `status_class` |
| `aino_db_pool_connections` | gauge | `waiting > 0` means requests are queued on a connection |
| `aino_db_tenant_pools` | gauge | open pools vs `TENANT_MAX_POOLS` |
| `aino_db_pool_evictions_total` | gauge | **the LRU thrash signal** (Phase E2) |
| `aino_db_pool_hit_rate` | gauge | pool cache effectiveness |
| `aino_queue_depth` | gauge | BullMQ backlog — the worker autoscaling signal |
| `aino_job_duration_seconds` | histogram | is the backlog slowness or failure? |
| `aino_job_runs_total` | counter | job failure rate |
| `aino_ws_connections` | gauge | realtime scale-out signal (cap ~5k/pod) |
| `aino_redis_up` | gauge | D3 made Redis mandatory in production |
| `aino_redis_keyspace_hit_rate` | gauge | cache effectiveness |
| `aino_migrations_expected` / `_applied` | gauge | schema drift backstop (worker only) |
| `aino_tenants_unreachable` | gauge | tenants whose DB failed during the last drift sweep |
| `aino_*` process/heap/GC | various | prom-client defaults |

15 custom families in total, plus the prom-client process defaults.

Every series carries `role` and `instance_id` default labels.

## Cardinality policy (H3)

A `tenant` label is applied **only** to the HTTP histogram, and it is bounded:

- the busiest `METRICS_TENANT_TOP_N` tenants (default **20**) get their own label
- everything else is folded into a single `other` bucket
- `master` is always its own label
- the promoted set is recomputed every `METRICS_TENANT_REFRESH_MS` (default 60s)
  from a **decaying** counter, so a one-off burst cannot pin a tenant forever

This matters: at 100 tenants × ~450 routes × 14 buckets an unbounded tenant
label is millions of series, and it takes out the monitoring system long before
it takes out the app.

## Tracing (H4)

Tracing is **opt-in**. It starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set,
so local development and CI pay nothing.

| Variable | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL — **enables tracing** |
| `OTEL_EXPORTER_OTLP_HEADERS` | e.g. `authorization=Bearer <token>` |

Auto-instrumentation covers HTTP, Express, `pg` and `ioredis`. On top of that,
AINO adds to every request span:

- `request.id` — the same value as the `x-request-id` header and the `reqId`
  field in every pino log line, so a log can be pivoted to its trace
- `tenant_id` — bucketed with the *same* top-N policy as the metrics labels,
  because most trace backends bill on attribute cardinality
- `enduser.id` when authenticated

`/healthz`, `/readyz` and `/metrics` are excluded — they fire every few seconds
on every replica and would otherwise consume the entire trace budget.

## Load testing (H6)

```bash
k6 run -e BASE_URL=https://staging.aino.org.in infra/observability/k6/load-test.js
```

Run it **after each phase**. Its thresholds mirror the H5 alert rules, so a
passing run means the same conditions would not have paged in production.

While it runs, watch `aino_db_pool_evictions_total` and
`aino_db_pool_connections{state="waiting"}` — those are the two numbers this
entire refactor was built to keep flat.
