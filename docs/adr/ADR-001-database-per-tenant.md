# ADR-001 — Keep database-per-tenant

**Status:** Accepted · **Date:** 2026-08-21

## Context

Every tenant gets its own physical PostgreSQL database (`wp_<slug>`), created by
`createTenant()` and tracked in the master `tenants` catalog. Tenant resolution
attaches a pool-bound `req.db` per request (`middleware/tenant.ts`).

While planning for scale we asked whether to collapse this into a single shared
database with row-level security (RLS) and a `tenant_id` column, the more common
SaaS pattern.

Two properties of the current code dominate the decision:

- **`tenants.db_host` already exists**, and `getTenantPool(dbName, dbHost)`
  already honours it. Connecting a tenant to a *different* Postgres host is
  supported today; only the placement policy was missing.
- **SQL is spread across route files** — `routes/chat.ts` alone contains 333
  statements. Under RLS, every one of them would need auditing to confirm the
  tenant predicate applies.

## Decision

**Keep database-per-tenant.** Formalise sharding instead of changing the
isolation model: a `shards` registry, `tenants.shard_id`, and least-loaded
placement in `createTenant()` (Phase A4).

## Consequences

**Good**

- Strongest possible isolation. A missing `WHERE tenant_id = ?` cannot leak
  another tenant's data, because the other tenant's data is in a different
  database.
- Per-tenant backup, restore and deletion are trivial (`DROP DATABASE`).
- **Horizontal DB scaling is additive**: outgrowing one Postgres means inserting
  a `shards` row, not rewriting the data layer.

**Bad — and how it is handled**

| Cost | Mitigation |
|---|---|
| Connection count grows with tenants | PgBouncer in transaction mode (Phase E1) |
| Pool cache thrashes past `TENANT_MAX_POOLS` | Raise to 100 once PgBouncer absorbs the cost (E2.1) |
| Migrations run per database, O(n) | Parallelised at concurrency 5 (E4); one squashed baseline (A2) |
| Cross-tenant reporting needs a fan-out | `forEachTenant()` already provides it |

## Alternatives considered

**Single DB + RLS.** Rejected: auditing 333 SQL statements in `chat.ts` alone is
a large, high-risk change whose only reward is cheaper connection management —
which PgBouncer solves directly. It also trades a *structural* guarantee for a
*policy* guarantee.

**Schema-per-tenant.** Rejected: keeps most of the per-tenant overhead (still
O(n) migrations) while weakening isolation and preventing per-tenant sharding
across hosts.

## References

`utils/tenantManager.ts` · `middleware/tenant.ts` ·
`platform/db/migrations/master/0001_shards_and_storage.sql`
