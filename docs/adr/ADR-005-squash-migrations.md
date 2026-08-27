# ADR-005 — Squash 30 migrations into one SQL baseline

**Status:** Accepted · **Date:** 2026-08-21

## Context

`utils/migrationRunner.ts` was 1,668 lines, most of it a `MIGRATIONS[]` array of
30 `{ name, up(query) }` objects. Adding a migration meant editing TypeScript.

Auditing it before the refactor turned up something worse than verbosity.
`scripts/analyze-migration-coverage.mjs` compared the DDL in `MIGRATIONS[]`
against `initTenantSchema()` (`db.ts`) and found that **26 of 143 objects exist
only in the migrations**:

| Missing from `initTenantSchema()` | Feature it breaks |
|---|---|
| `device_tokens` + 3 indexes | **Push notifications** |
| `webauthn_credentials`, `device_credentials` | **Biometric login** |
| `mfa_reset_tokens`, `users.mfa_*` (5 cols) | **MFA / 2FA** |
| `sprint_burndown_snapshots`, `sprint_retro_votes` | Burndown, retro voting |
| `tasks.cycle_started_at` / `lead_started_at` | Cycle-time metrics |

Verified by direct grep: `db.ts` contained **zero** references to any of them.

This was a live latent bug. `createTenant()` ran `initTenantSchema()` and
nothing else, so a newly-provisioned tenant received an **incomplete schema** and
only got these tables later, whenever an unrelated migration sweep happened to
run. Until then, push notifications silently did not work.

## Decision

**Replace `MIGRATIONS[]` with `.sql` files** in
`platform/db/migrations/`, applied in filename order and tracked in
`_migrations`. The 30 entries were flattened into a single generated
`0002_migration_catchup.sql` (170 statements).

Because there were **zero customer tenants**, this was the cheapest it would
ever be.

## Consequences

**Good**

- `migrationRunner.ts`: **1,668 → 331 lines**.
- Adding a migration is dropping in a numbered `.sql` file — no TypeScript.
- Reviewable in diffs, greppable, no template-literal escaping.
- The `initTenantSchema()`-vs-`MIGRATIONS[]` drift class is gone: `createTenant()`
  now runs both layers.
- `expectedMigrationCount` is derived from the directory, so it cannot go stale.

**Bad — and how it is handled**

| Cost | Mitigation |
|---|---|
| The existing `default` DB has the 30 old names recorded | **Legacy adoption**: a DB with all 30 records the catch-up as applied *without executing it*. Critical — the file contains `DROP TABLE IF EXISTS sprint_retrospectives` + recreate, which would have destroyed live data |
| `tsc` ignores `.sql`, so a build could ship none | `scripts/copy-sql-assets.mjs` copies them and **fails the build** if absent; `verify-docker-migrations.mjs` re-checks in CI |
| Procedural migrations cannot be static SQL | Only 2 of 30. Both are data cleanups that are no-ops on a fresh DB; their guard index is preserved |

**Rollback:** `git revert`. The `_migrations` ledger still holds the old 30
names, so the previous runner resumes with no data loss.

## Alternatives considered

**Keep `MIGRATIONS[]`, just fix the 26 gaps.** Rejected: leaves the drift class
in place, so the same bug recurs the next time someone adds a table to one list
and not the other.

**Adopt a migration framework (Prisma, Knex, node-pg-migrate).** Rejected as
disproportionate — a directory of `.sql` files plus a ledger table is ~80 lines
of code and has no version-coupling risk.

## References

`utils/migrationRunner.ts` · `scripts/analyze-migration-coverage.mjs` ·
`__tests__/migrationRunner.test.ts`
