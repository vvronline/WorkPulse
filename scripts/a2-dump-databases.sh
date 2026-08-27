#!/bin/sh
# =============================================================================
# A2.1 / A2.2 / A2.3 / A2.4 — Database dumps for the migration squash.
#
# Produces four artifacts:
#   1. master-<ts>.sql            A2.1 — FULL master dump (platform_users,
#                                        tenants, user_directory, app_settings)
#                                        <- THIS IS YOUR IDENTITY. Never lose it.
#   2. master-verify-<ts>.txt     A2.2 — proof the dump contains your admin
#   3. tenant-default-<ts>.sql    A2.3 — FULL default-tenant dump (rollback)
#   4. 0001_baseline-<ts>.sql     A2.4 — SCHEMA-ONLY dump of the default tenant
#                                        = the squashed baseline
#
# WHY A SCRIPT AND NOT initTenantSchema():
#   scripts/analyze-migration-coverage.mjs proved that 26 DDL objects exist
#   ONLY in MIGRATIONS[] and are never created by initTenantSchema() — including
#   device_tokens (push), webauthn_credentials (biometric) and the users.mfa_*
#   columns. The baseline MUST therefore come from a real DB that has all 30
#   migrations applied, not from initTenantSchema().
#
# -----------------------------------------------------------------------------
# HOW TO RUN — pick whichever matches your network
# -----------------------------------------------------------------------------
# (a) Railway one-off job  [RECOMMENDED — no local network needed]
#       Railway -> Postgres service -> "Run a command", paste this script body.
#       DATABASE_URL is injected automatically.
#
# (b) GitHub Actions (workflow_dispatch)
#       Runner has pg_dump + open egress. Set repo secret DATABASE_PUBLIC_URL,
#       then upload the outputs with actions/upload-artifact.
#
# (c) Any machine with open egress (e.g. home network)
#       export DATABASE_URL='postgresql://...@interchange.proxy.rlwy.net:21659/railway'
#       sh scripts/a2-dump-databases.sh
#
# -----------------------------------------------------------------------------
# SAFETY
#   * READ-ONLY. Only runs pg_dump / psql SELECTs.
#   * NEVER drops or alters anything.
#   * Never echoes credentials.
# =============================================================================
set -eu

OUT_DIR="${OUT_DIR:-./a2-dumps}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "  Railway job -> it is injected automatically." >&2
  echo "  Elsewhere   -> export DATABASE_URL='postgresql://...'" >&2
  exit 1
fi

# Redacted echo so logs never leak the password.
SAFE_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's#^(.*)://[^@]*@#\1://<redacted>@#')"
echo "==> Target: $SAFE_HOST"
echo "==> Output: $OUT_DIR"
echo ""

# The master DB name is the final path segment of DATABASE_URL (Railway: 'railway').
MASTER_DB="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
echo "==> Master DB: $MASTER_DB"

# ---------------------------------------------------------------------------
# A2.1 — FULL master dump  <- YOUR IDENTITY
# ---------------------------------------------------------------------------
echo ""
echo "== A2.1  Dumping MASTER (platform_users, tenants, user_directory) =="
pg_dump "$DATABASE_URL" \
  --no-owner --no-privileges --clean --if-exists \
  -f "$OUT_DIR/master-$TS.sql"
echo "   -> master-$TS.sql ($(wc -c < "$OUT_DIR/master-$TS.sql") bytes)"

# ---------------------------------------------------------------------------
# A2.2 — VERIFY the dump really contains the platform admin.
#        A2 is only safe because platform_users lives in MASTER (db.ts:211).
# ---------------------------------------------------------------------------
echo ""
echo "== A2.2  Verifying platform admin is captured =="
VERIFY="$OUT_DIR/master-verify-$TS.txt"
{
  echo "A2.2 verification — $TS"
  echo "Source: $SAFE_HOST"
  echo ""
  echo "--- platform_users (live DB) ---"
  psql "$DATABASE_URL" -A -F'|' -c \
    "SELECT id, username, email, created_at FROM platform_users ORDER BY id;"
  echo ""
  echo "--- tenants (live DB) ---"
  psql "$DATABASE_URL" -A -F'|' -c \
    "SELECT id, slug, status, db_name, is_default FROM tenants ORDER BY id;"
  echo ""
  echo "--- platform_users data present in the dump file? ---"
  echo -n "COPY blocks:   "
  grep -c "COPY public.platform_users" "$OUT_DIR/master-$TS.sql" || echo 0
  echo -n "INSERT stmts:  "
  grep -c "INSERT INTO public.platform_users" "$OUT_DIR/master-$TS.sql" || echo 0
} > "$VERIFY" 2>&1
cat "$VERIFY"

PU_COUNT="$(psql "$DATABASE_URL" -A -t -c 'SELECT COUNT(*) FROM platform_users;' | tr -d '[:space:]')"
if [ "${PU_COUNT:-0}" -lt 1 ]; then
  echo "" >&2
  echo "FATAL: platform_users is EMPTY. Stopping — do NOT proceed to A2.6." >&2
  exit 1
fi
echo ""
echo "   -> OK: $PU_COUNT platform user(s) captured."

# ---------------------------------------------------------------------------
# Resolve the default tenant's DB name from the master DB
# ---------------------------------------------------------------------------
TENANT_DB="$(psql "$DATABASE_URL" -A -t -c \
  "SELECT db_name FROM tenants WHERE is_default = TRUE LIMIT 1;" | tr -d '[:space:]')"

if [ -z "$TENANT_DB" ]; then
  echo ""
  echo "WARNING: no is_default tenant row found."
  echo "         Legacy single-DB deployment — master IS the tenant DB."
  TENANT_DB="$MASTER_DB"
fi
echo ""
echo "==> Default tenant DB: $TENANT_DB"

# Swap the database name in the URL, preserving credentials + query string.
TENANT_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$TENANT_DB\1#")"

# ---------------------------------------------------------------------------
# A2.3 — FULL default-tenant dump (rollback artifact)
# ---------------------------------------------------------------------------
echo ""
echo "== A2.3  Dumping DEFAULT TENANT (rollback artifact) =="
pg_dump "$TENANT_URL" \
  --no-owner --no-privileges --clean --if-exists \
  -f "$OUT_DIR/tenant-default-$TS.sql"
echo "   -> tenant-default-$TS.sql ($(wc -c < "$OUT_DIR/tenant-default-$TS.sql") bytes)"

# ---------------------------------------------------------------------------
# A2.4 — SCHEMA-ONLY dump = the squashed baseline
# ---------------------------------------------------------------------------
echo ""
echo "== A2.4  Generating 0001_baseline (schema-only) =="
pg_dump "$TENANT_URL" \
  --schema-only --no-owner --no-privileges \
  -f "$OUT_DIR/0001_baseline-$TS.sql"
echo "   -> 0001_baseline-$TS.sql ($(wc -c < "$OUT_DIR/0001_baseline-$TS.sql") bytes)"

# ---------------------------------------------------------------------------
# Sanity-check: the baseline MUST contain the objects initTenantSchema() misses
# ---------------------------------------------------------------------------
echo ""
echo "== Baseline coverage check (the known initTenantSchema gaps) =="
MISSING=0
for OBJ in device_tokens webauthn_credentials device_credentials \
           mfa_reset_tokens sprint_burndown_snapshots sprint_retro_votes; do
  if grep -q "CREATE TABLE public.$OBJ" "$OUT_DIR/0001_baseline-$TS.sql"; then
    echo "   OK   table  $OBJ"
  else
    echo "   MISS table  $OBJ"
    MISSING=$((MISSING + 1))
  fi
done
for COL in mfa_secret biometric_login_enabled cycle_started_at lead_started_at; do
  if grep -q "$COL" "$OUT_DIR/0001_baseline-$TS.sql"; then
    echo "   OK   column $COL"
  else
    echo "   MISS column $COL"
    MISSING=$((MISSING + 1))
  fi
done

echo ""
echo "============================================================"
if [ "$MISSING" -eq 0 ]; then
  echo "SUCCESS — baseline contains all previously-missing objects."
  echo ""
  echo "Next steps:"
  echo "  1. Download all 4 files from $OUT_DIR; upload to R2 (PRIVATE bucket)."
  echo "  2. Commit the baseline as:"
  echo "       server/platform/db/migrations/0001_baseline.sql"
  echo "  3. Continue with A2.5 (rewrite migrationRunner.ts)."
else
  echo "WARNING — $MISSING expected object(s) missing from the baseline."
  echo "The source DB may not have all 30 migrations applied."
  echo "Confirm /api/health?detail=true shows minApplied=30, then rerun."
fi
echo "============================================================"
