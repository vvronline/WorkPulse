# ADR-008 — Metrics are bounded by cardinality and closed by default

**Status:** Accepted · **Date:** 2026-08-27

## Context

Phase H adds a Prometheus `/metrics` endpoint to all three roles. Two decisions
had to be made before writing a single collector, because both are extremely
expensive to reverse once dashboards and alerts depend on them.

**1. Tenant labels.** AINO is database-per-tenant, so "which tenant" is the
first question asked about any slow request. The obvious implementation —
`tenant` as a label on the HTTP histogram — multiplies series by the tenant
count. Phase E raised `TENANT_MAX_POOLS` to 100, so the design target is 100
tenants. At 100 tenants × ~450 routes × 14 histogram buckets that is on the
order of **millions of series**, which takes down the monitoring system long
before it takes down the app. Prometheus cardinality blowups are also
notoriously hard to undo, because the series persist for the retention window.

**2. Access.** The exposition format leaks route inventory, queue names, tenant
identifiers and traffic volumes. Railway services get public domains by default.

## Decision

**Bounded tenant labels (top-N + `other`).**

- Only the busiest `METRICS_TENANT_TOP_N` tenants (default **20**) get their own
  label value.
- Everything else folds into a single `other` bucket.
- `master` is always its own label — it is one well-known identity and the first
  thing an operator looks at.
- The promoted set is recomputed every `METRICS_TENANT_REFRESH_MS` (default 60s)
  from a **decaying** counter, so a one-off burst cannot pin a tenant forever,
  and cold tenants are evicted from the bookkeeping map entirely.
- A brand-new tenant is `other` until the next refresh. Promotion on first sight
  would itself be the unbounded behaviour.
- The tenant label is applied **only** to the HTTP histogram, not to every
  metric.

The same bucketing is reused for the `tenant_id` span attribute (H4), because
most tracing backends also bill on attribute cardinality.

**Fail-closed access.**

- `GET /metrics` requires `Authorization: Bearer $METRICS_TOKEN`.
- If `METRICS_TOKEN` is unset, the endpoint is **disabled in production** and
  open in development.
- Unauthorized requests get **404, not 401**, so a caller cannot even confirm
  the endpoint exists.

## Consequences

**Accepted cost.** You cannot get a per-tenant latency breakdown for a tenant
outside the top 20 directly from Prometheus. That is the right trade: for
whole-system health the top-N plus `other` is sufficient, and for a specific
tenant investigation the traces (which carry the real tenant on the sampled
spans) and the structured logs (which carry the exact `tenantId` on every line)
are the correct tools. Metrics answer "is the system healthy"; logs and traces
answer "what happened to this tenant".

**Fail-closed is deliberate.** Defaulting to "open, because someone forgot to
set a variable" is precisely how an unauthenticated metrics endpoint reaches a
public domain. A missing variable produces a loud startup warning and a dark
endpoint, not a silent information disclosure.

**Cost of scraping is bounded.** Gauges are `collect()` callbacks evaluated at
scrape time rather than timers, so an unscraped replica does no metrics work.
Queue depth is read with a single pipelined Redis round trip on the shared
client — no new connections, which preserves the Phase E connection budget. The
one exception is the migration-drift sampler, which is O(tenants) and therefore
runs **only on the worker role**, on a 5-minute interval; putting it on the web
role would reintroduce exactly the sweep D4.3 removed from `/readyz`.
