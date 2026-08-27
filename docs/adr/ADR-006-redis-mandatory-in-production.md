# ADR-006 — Redis is mandatory in production

**Status:** Accepted · **Date:** 2026-08-21

## Context

`redis.ts` was written to degrade gracefully. `attachFailFast()` gives the
connection three attempts, then disconnects for good and lets the app fall back
to in-process alternatives:

- `express-rate-limit` reverts to `MemoryStore`
- org config / user context / token versions use an in-proc cache
- presence and unread counters go local

For a **single instance** this is exactly right — a Redis outage degrades
performance instead of causing an outage.

For **multiple replicas it is silently wrong**:

| Subsystem | Failure with N replicas and no Redis |
|---|---|
| Rate limiting | Each replica keeps its own counter — the real limit is N× the configured one |
| Presence | A user appears offline to anyone connected to a different replica |
| Token revocation | A logout invalidates the token on one replica only |
| WS fan-out (`ws:broadcast`) | Messages never reach clients on other replicas |
| BullMQ | No queue at all; jobs fall back to `setInterval` on **every** replica |

None of these throw. The app looks healthy while enforcing the wrong limits and
showing the wrong presence.

## Decision

**In production, Redis is required.** Missing or unreachable Redis is a startup
failure, not a degradation. The graceful path is kept for local development,
where a single process makes it correct.

## Consequences

**Good**

- The multi-replica correctness bugs above become impossible.
- Failures surface at deploy time, loudly, instead of as subtle wrong behaviour.
- Removes a whole class of "works locally, misbehaves in prod" reports.

**Bad — and how it is handled**

| Cost | Mitigation |
|---|---|
| Redis is now a hard dependency for boot | It is already provisioned and Online on Railway |
| A Redis outage takes the app down | Correct trade-off: with replicas, running *without* Redis serves wrong data. Railway restarts on failure |
| Dev needs a Redis or the fallback | Fallback retained for `NODE_ENV !== "production"` |

**Precedent.** The same reasoning produced `assertProductionStorage()` in
[ADR-003](ADR-003-r2-prefixes-not-buckets.md)'s implementation: local disk in
production is also a silent single-replica trap, and is now a fatal startup
error. Config that is *safe when single-instance* and *wrong when replicated*
should fail fast, not degrade.

## Alternatives considered

**Keep degrading silently.** Rejected: the failure mode is invisible and the
symptoms (wrong rate limits, phantom offline users) are hard to trace back.

**Warn loudly but continue.** Rejected: warnings in a log nobody is watching are
indistinguishable from silence when the consequence is a security control
enforcing 3× its intended limit.

## References

`redis.ts` (`attachFailFast`) · Phase D3 of `../SCALABILITY_REFACTOR_PLAN.md` ·
`platform/storage/index.ts` (`assertProductionStorage`)
