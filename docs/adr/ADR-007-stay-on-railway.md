# ADR-007 — Stay on Railway

**Status:** Accepted · **Date:** 2026-08-21

## Context

The scalability review asked whether Railway could carry the platform to
"many tenants, many active users", or whether the refactor should also migrate
to managed Kubernetes, Fly.io, Render or ECS.

Current production:

```
Railway project "renewed-fascination" (EU West)
  WorkPulse   Online · https://www.aino.org.in · 1 replica
  Redis       Online
  Postgres    Online
```

Railway's real limitations are genuine: hostname-only routing
([ADR-002](ADR-002-cloudflare-path-routing.md)), a volume that attaches to a
single instance, and no exposed Postgres tuning.

The owner's stated priority: **"it is very cheap and very simple to maintain."**

## Decision

**Stay on Railway.** Remove the constraints that actually block scaling, rather
than the platform:

| Blocker | Fix | Phase |
|---|---|---|
| Volume pins the app to 1 replica | Uploads → R2, delete the volume | A3 |
| Path routing unsupported | Cloudflare path rules | F |
| WebRTC signal buffers in-process | Redis-backed signal store | D1 |
| Connection budget | PgBouncer | E1 |
| One Postgres | `shards` registry + `db_host` | A4 |

## Consequences

**Good**

- No migration project competing with the refactor for time.
- Cost stays low; operational surface stays small — which is the point.
- Every fix above is *also* required on any other platform, so none of the work
  is wasted.

**Bad — and how it is handled**

| Cost | Mitigation |
|---|---|
| No Postgres tuning (`max_connections`, extensions) | PgBouncer removes the pressure that would need it |
| Hostname-only routing | Cloudflare (ADR-002) |
| Single region | Acceptable now; `shards.region` exists for later |

**No lock-in is created.** Every phase targets standard Docker plus env-var
config: one image, three roles selected by `ROLE`. Moving to Fly.io, Render, ECS
or k8s later is mechanical. **Do not add Railway-specific coupling.**

## When to revisit

- Postgres tuning Railway does not expose becomes necessary
- Multi-region or per-tenant data residency is required
- More than one Postgres shard needs independent scaling
- Cost crossover — typically ~200 tenants / 10k+ DAU

## Alternatives considered

**Move to k8s + RDS now.** Rejected: weeks of migration that fixes none of the
five blockers above, all of which are application-level.

**Move to Fly.io for multi-region.** Rejected as premature — one region is fine
today, and the R2 + stateless-role architecture makes the move easy later.

## References

`docs/RAILWAY_DEPLOYMENT.md` · `../SCALABILITY_REFACTOR_PLAN.md`
