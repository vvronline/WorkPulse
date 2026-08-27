# ADR-002 — Cloudflare for path routing, no reverse-proxy service

**Status:** Accepted · **Date:** 2026-08-21

## Context

Phase F splits the monolith into three process roles — `web`, `realtime` and
`worker` — which requires routing by path:

```
/api/*            -> web        (stateless, scale freely)
/ws, /collab      -> realtime   (sticky, long-lived connections)
/uploads/*        -> web        (authorize, then private R2 presign)
everything else  -> public SPA R2 origin
```

**Railway's proxy routes by hostname, not path.** It cannot express the split.

The obvious answer is a reverse proxy (Caddy/Traefik) as a fourth service. The
committed `docker-compose.yml` already assumed one — it mounts a `Caddyfile`
that **does not exist in the repository**, so that stack is broken as written.

But Cloudflare is *already* in front of DNS: it terminates TLS for
`aino.org.in`, serves `cdn.aino.org.in` from R2, and provides the TURN service.

## Decision

**Use Cloudflare path rules for routing. Do not add a reverse-proxy service.**

## Consequences

**Good**

- **£0 and zero new infrastructure** — no service to deploy, patch or monitor.
- **No extra hop.** Traffic already passes through Cloudflare; a Caddy container
  would add one.
- WAF, edge rate limiting and bot rules come along for free, and fire *before*
  requests reach the app's own limiters.
- `/assets/*` is cached at the edge, so static bytes never touch Node.
- `/uploads/*` deliberately remains a web route: the application must enforce
  tenant/org/chat authorization before redirecting to a private 60-second R2 URL.

**Bad — and how it is handled**

| Cost | Mitigation |
|---|---|
| Routing config lives in a dashboard, not the repo | Mirror it in Phase F of the plan; export as Terraform later if it grows |
| Cloudflare becomes a hard dependency | Already true — it terminates TLS today |
| Local dev cannot use path rules | `docker-compose.yml` runs the combined `ROLE=all` process |

**Required code change:** `app.set("trust proxy", 1)` becomes `2` (D4.4).
Cloudflare + Railway is two hops; the wrong value makes `express-rate-limit` key
on the wrong IP and rate-limit the proxy instead of the client.

## Alternatives considered

**Caddy as a Railway service.** Rejected: an extra service, extra hop and extra
cost to replicate what Cloudflare already does. The owner's explicit priority is
that Railway stays cheap and simple to operate.

**Path routing inside Express.** Rejected: it would defeat the point — every
request would still land on a Node process before being dispatched.

## References

Phase F of `../SCALABILITY_REFACTOR_PLAN.md` · [ADR-007](ADR-007-stay-on-railway.md)
