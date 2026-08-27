# ADR-004 — Two R2 buckets, split by access pattern

**Status:** Accepted · **Date:** 2026-08-21

## Context

An R2 bucket already existed before this work: `aino-releases`, served publicly
at `cdn.aino.org.in`, holding desktop installers and `latest*.yml` update
manifests (see `docs/OTA_R2_MIGRATION_PLAN.md`). It is **deliberately public** —
`electron-updater` fetches from it unauthenticated.

Phase A3 needed somewhere to put user uploads: avatars, chat attachments, org
logos, task-comment files. The tempting shortcut was to reuse the existing
bucket under an `uploads/` prefix.

## Decision

**Two buckets, separated by access pattern.**

| Bucket | Contents | Access | Domain |
|---|---|---|---|
| `aino-releases` | desktop installers, OTA manifests | **public** | `cdn.aino.org.in` |
| `aino-uploads` | all user content | **private**, presigned only | none |

## Consequences

**Why the split is not optional**

`aino-releases` has a **public custom domain**. Anything in it is reachable by
URL alone. If user uploads shared that bucket, tenant data would be one
misconfigured route or one leaked key away from public exposure — and the
`tenant_<id>` prefix would be no protection at all, because prefixes are not a
security boundary on a publicly-served bucket.

Keeping the two apart means the safe default differs correctly per bucket:
`aino-releases` is public by design; `aino-uploads` has **no public domain at
all**, so the only way to read an object is a presigned URL the server mints
after authorization.

**Also good**

- Independent lifecycle rules — releases are pruned by version; uploads are
  retained per tenant policy.
- Independent credentials, so a token scoped to releases (used by the desktop
  CI workflow) cannot touch user content.
- Blast radius of a leaked key is one bucket.

**Cost:** two sets of credentials and two bindings to manage. Trivial next to
the exposure risk.

## Alternatives considered

**One bucket, `uploads/` prefix.** Rejected: puts private user content in a
bucket with a public custom domain. Convenience is not worth that.

**Three buckets (releases / uploads / exports).** Rejected as premature —
exports share the uploads access pattern exactly, so they live under an
`exports/` prefix. Revisit only if their lifecycle rules diverge.

## References

`platform/storage/index.ts` (`R2_UPLOADS_BUCKET`) ·
`.github/workflows/desktop-release.yml` (`R2_BUCKET`) ·
[ADR-003](ADR-003-r2-prefixes-not-buckets.md)
