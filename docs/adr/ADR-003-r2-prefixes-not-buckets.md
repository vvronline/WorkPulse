# ADR-003 — R2 folder prefixes, not per-tenant buckets

**Status:** Accepted · **Date:** 2026-08-21

## Context

Moving uploads to Cloudflare R2 ([ADR-004](ADR-004-two-buckets-by-access-pattern.md))
raised the question of how to isolate tenants: a bucket per tenant, or one
bucket with per-tenant key prefixes?

Per-tenant buckets *feel* safer — a hard boundary per customer. Cloudflare's
published limits permit up to 1,000,000 buckets per account, so the idea is not
obviously wrong.

## Decision

**One private bucket, per-tenant key prefixes.**

```
aino-uploads/
└── tenant_<tenantId>/
    └── org_<orgId>/
        ├── avatars/  chat/  branding/  task-comments/
```

This is byte-identical to the previous on-disk layout, so every `avatar`,
`logo_url` and `file_url` already stored in a tenant database stays valid with
**no data migration**.

## Consequences

**Why prefixes win**

| R2 limit | Effect on per-tenant buckets |
|---|---|
| Custom domains: **100 per bucket** | Each bucket needs its own binding |
| Bucket management ops: **50/sec** | Bucket creation sits in the tenant-provisioning path |
| REST API: **1,200 req / 5 min account-wide** | Per-bucket config changes share one budget |
| Objects per bucket: **unlimited** | No scale reason to split |

The decisive point: **CORS, lifecycle and public-access settings are
per-bucket.** One retention-policy change would mean iterating N buckets through
a 1,200-per-5-minute budget. With prefixes it is a single lifecycle rule with a
prefix filter.

**Isolation does not come from bucket boundaries.** The bucket is private and
has no public domain; clients receive a **60-second presigned URL for one
specific key**, minted only *after* the tenant/org/conversation authorization
checks pass. A client can never enumerate or reach another prefix.

**Per-tenant operations still work**

- *Metering* — sum object sizes by prefix (`tenants.max_storage_mb` already exists)
- *Deletion* — `deleteTenant()` calls `deletePrefix('tenant_<id>/')` (A4.5)
- *Isolation* — presigned URLs + the `tenant_<id>` path assertion in `index.ts`

**Escape hatch.** `tenants.storage_bucket` (nullable, defaults to
`aino-uploads`) mirrors the `db_host` pattern from
[ADR-001](ADR-001-database-per-tenant.md). If one customer ever requires
EU-only residency, set that column for them. **Prefixes now do not foreclose
buckets later.**

## Addendum (2026-08-27) — filenames are random; the hierarchy stops at org

Two follow-up questions after the R2 cutover: should the key encode
`team`/`user`, and does a browsable bucket leak anything?

**Filenames are now random.** They were `<userId>_<Date.now()>.<ext>` — both
components guessable, so the key space was enumerable. Authorization was and
remains the real control (presigned URLs minted only after tenant → org →
conversation checks), but a predictable name turns one authorization regression
into *bulk* enumeration. `platform/storage/filenames.ts` now emits
`<prefix>_<128 bits>.<ext>`. This mirrors Slack, whose file IDs (`F012AB3CDE4`)
are opaque rather than descriptive. Existing keys are untouched and still
resolve; only new writes change.

**The hierarchy deliberately stops at `org`.** Adding `team_id` or `user_id` was
considered and rejected:

- **Object keys must encode only immutable facts.** `users.team_id` is a
  nullable, mutable FK. Encoding it would orphan a user's objects on every team
  change, or force a copy+delete migration per move.
- **One object can belong to many contexts.** Forwarding copies `file_url`
  rather than the object, so a single attachment is referenced by N messages in
  different conversations. "Which team's folder?" has no answer. Slack hit the
  same problem and chose flat, opaque IDs.
- **Prefixes are not a security boundary**, so deeper nesting buys no isolation.
- **S3/R2 has no real directories** — the key is one flat string; folders are a
  console rendering.

`tenant_<id>/org_<id>/<kind>/` is what the code actually depends on:
`deletePrefix('tenant_<id>/')` for tenant deletion, prefix sums for metering,
and the `tenant_<id>` assertion in the upload middleware.

**Related fix.** The forwarding behaviour above meant deleting any copy of a
forwarded message deleted the shared object for everyone. `deleteChatAttachment`
(`services/chatAttachments.ts`) now checks for other live references first and
fails closed if that check errors.

## Alternatives considered

**Bucket per tenant.** Rejected on the operational limits above. Data residency
— the one legitimate reason to split — is per-*jurisdiction*, not per-tenant,
and is served by the `storage_bucket` column.

**Deeper `team/user` nesting.** Rejected — see the addendum above. Revisit only
if per-team lifecycle rules are ever needed, since R2 lifecycle policies filter
by prefix.

**Bucket per tenant tier.** Rejected: same config-multiplication problem, with
the added cost of migrating objects when a tenant changes plan.

## References

`platform/storage/keys.ts` · `platform/storage/r2Adapter.ts` ·
[Cloudflare R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
