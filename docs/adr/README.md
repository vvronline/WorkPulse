# Architecture Decision Records

Each ADR captures one architectural decision: the context, the choice, and the
consequences we accepted. They exist so a future maintainer can see **why** the
system looks the way it does — and so a decision is revisited deliberately
rather than eroded by accident.

Keep them short. If an ADR needs more than a page, the decision is probably two
decisions.

## Status values

| Status | Meaning |
|---|---|
| **Accepted** | In force. Code must comply. |
| **Superseded** | Replaced — links to the ADR that replaced it. |
| **Proposed** | Under discussion; not yet binding. |

## Index

| # | Title | Status |
|---|---|---|
| [001](ADR-001-database-per-tenant.md) | Keep database-per-tenant | Accepted |
| [002](ADR-002-cloudflare-path-routing.md) | Cloudflare for path routing, no Caddy service | Accepted |
| [003](ADR-003-r2-prefixes-not-buckets.md) | R2 folder prefixes, not per-tenant buckets | Accepted |
| [004](ADR-004-two-buckets-by-access-pattern.md) | Two buckets split by access pattern | Accepted |
| [005](ADR-005-squash-migrations.md) | Squash 30 migrations into one baseline | Accepted |
| [006](ADR-006-redis-mandatory-in-production.md) | Redis is mandatory in production | Accepted |
| [007](ADR-007-stay-on-railway.md) | Stay on Railway | Accepted |
| [008](ADR-008-metrics-cardinality-and-access.md) | Metrics: bounded cardinality, fail-closed access | Accepted |

## Adding one

Copy the shape of an existing file: **Context → Decision → Consequences →
Alternatives considered**. Number it sequentially and add it to the index above.

Related: [`../SCALABILITY_REFACTOR_PLAN.md`](../SCALABILITY_REFACTOR_PLAN.md)
