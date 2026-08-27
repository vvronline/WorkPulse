-- =============================================================================
-- 0001_shards_and_storage.sql   (MASTER database)
--
-- Phase A4 — make tenancy shard-ready and storage-overridable.
--
-- WHY NOW
--   Both changes are free at zero customer tenants and painful later. Adding a
--   shard column once 50 tenants exist means backfilling every row and
--   reasoning about live traffic; adding it now is two DDL statements.
--
-- WHAT THIS ENABLES
--   The single-Postgres ceiling stops being a rewrite. `tenants.db_host` and
--   `getTenantPool(dbName, dbHost)` already support connecting a tenant to a
--   different host — this formalises WHICH host, so shard #2 is a row in a
--   table rather than a code change.
--
-- IDEMPOTENT: safe to re-run.
-- =============================================================================

-- ── Shard registry ──────────────────────────────────────────────────────────
-- One row per Postgres host that can hold tenant databases.
CREATE TABLE IF NOT EXISTS shards (
    id            SERIAL PRIMARY KEY,
    name          TEXT        NOT NULL UNIQUE,
    host          TEXT        NOT NULL,
    port          INTEGER     NOT NULL DEFAULT 5432,
    -- Soft cap used by least-loaded placement. NULL = unlimited.
    capacity      INTEGER,
    -- Denormalised counter maintained by createTenant/deleteTenant so
    -- placement does not need a COUNT(*) across the tenants table.
    tenant_count  INTEGER     NOT NULL DEFAULT 0,
    -- Only active shards receive NEW tenants. Existing tenants on an inactive
    -- shard keep working — this is how a shard is drained before retirement.
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    -- Optional region tag for future data-residency placement.
    region        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shards_active_count
    ON shards (is_active, tenant_count)
    WHERE is_active = TRUE;

-- Seed shard #1 = the current primary. `host = ''` is a sentinel meaning
-- "same host as DATABASE_URL", so this row stays correct even when the
-- managed database's hostname changes (e.g. a Railway credential rotation).
INSERT INTO shards (name, host, port, is_active, region)
VALUES ('primary', '', 5432, TRUE, NULL)
ON CONFLICT (name) DO NOTHING;

-- ── Tenant -> shard link ────────────────────────────────────────────────────
-- Nullable: NULL means "the default/primary shard", so every existing row
-- stays valid with no backfill.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shard_id INTEGER REFERENCES shards(id);

CREATE INDEX IF NOT EXISTS idx_tenants_shard ON tenants (shard_id);

-- ── Per-tenant storage bucket override (ADR-003 escape hatch) ───────────────
-- NULL means "use R2_UPLOADS_BUCKET". Set per-tenant only when a customer
-- requires their objects in a specific bucket/jurisdiction. Mirrors the
-- db_host pattern: prefixes now do not foreclose separate buckets later.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_bucket TEXT;

-- Backfill the counter so placement starts from the real number.
UPDATE shards s
   SET tenant_count = (
        SELECT COUNT(*) FROM tenants t
         WHERE t.status <> 'deleted'
           AND (t.shard_id = s.id OR (t.shard_id IS NULL AND s.name = 'primary'))
   )
 WHERE s.name = 'primary';
