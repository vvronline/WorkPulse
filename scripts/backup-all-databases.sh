#!/bin/sh
# =============================================================================
# PRE-PUSH BACKUP — full logical backup of the master DB and EVERY tenant DB.
#
# WHY THIS EXISTS (and why it is NOT scripts/a2-dump-databases.sh)
#   a2-dump-databases.sh was written for the A2 migration squash. It dumps the
#   master DB and ONLY the `is_default = TRUE` tenant, because that is all the
#   squash needed. This project is database-per-tenant (ADR-001): every row in
#   `tenants` is a separate PostgreSQL database. A pre-push backup that skips
#   the non-default tenants is not a backup — a failed migration would leave
#   those tenants unrecoverable.
#
#   Use THIS script for the runbook's "back up databases" gate.
#   Use a2-dump-databases.sh only for regenerating the migration baseline.
#
# OUTPUT (into $OUT_DIR, default ./db-backups)
#   master-<ts>.sql              full master dump (platform_users, tenants, ...)
#   tenant-<db_name>-<ts>.sql    one full dump per tenant database
#   MANIFEST-<ts>.txt            what was captured + row counts + restore steps
#
# HOW TO RUN
#   (a) GitHub Actions [RECOMMENDED — the corporate network blocks the Railway
#       Postgres TCP proxy, so a workstation run will simply time out]
#         Actions -> "DB — Full Backup (manual)" -> type CONFIRM
#
#   (b) Any machine with open egress to the Railway Postgres public proxy:
#         export DATABASE_URL='postgresql://postgres:...@<proxy-host>:<port>/railway'
#         sh scripts/backup-all-databases.sh
#
# REQUIREMENT
#   pg_dump/psql major version MUST be >= the server major version (Railway is
#   currently Postgres 18). An older client aborts with a version mismatch.
#
# SAFETY
#   READ-ONLY. Only pg_dump and psql SELECTs. Never drops or alters anything.
#   Never echoes credentials — the connection string is redacted in all output.
# =============================================================================
set -eu

OUT_DIR="${OUT_DIR:-./db-backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "  GitHub Actions -> provided from the DATABASE_PUBLIC_URL secret." >&2
  echo "  Elsewhere      -> export DATABASE_URL='postgresql://...'" >&2
  exit 1
fi

# Redacted echo so logs never leak the password.
SAFE_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's#^(.*)://[^@]*@#\1://<redacted>@#')"
MASTER_DB="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"

echo "============================================================"
echo "PRE-PUSH FULL BACKUP"
echo "============================================================"
echo "  target    : $SAFE_HOST"
echo "  master DB : $MASTER_DB"
echo "  output    : $OUT_DIR"
echo "  timestamp : $TS"
echo ""

# Fail early and clearly on a client/server version mismatch, rather than
# producing a partial dump set.
echo "==> Client: $(pg_dump --version)"
SERVER_VERSION="$(psql "$DATABASE_URL" -A -t -c 'SHOW server_version;' | tr -d '[:space:]')"
echo "==> Server: PostgreSQL $SERVER_VERSION"
echo ""

MANIFEST="$OUT_DIR/MANIFEST-$TS.txt"

# ---------------------------------------------------------------------------
# 1. MASTER — this is the identity database. Losing it loses every login.
# ---------------------------------------------------------------------------
echo "== 1/3  Dumping MASTER ($MASTER_DB) =="
pg_dump "$DATABASE_URL" \
  --no-owner --no-privileges --clean --if-exists \
  -f "$OUT_DIR/master-$TS.sql"
echo "   -> master-$TS.sql ($(wc -c < "$OUT_DIR/master-$TS.sql") bytes)"

# The backup is only useful if the platform admin survives it.
PU_COUNT="$(psql "$DATABASE_URL" -A -t -c 'SELECT COUNT(*) FROM platform_users;' | tr -d '[:space:]')"
if [ "${PU_COUNT:-0}" -lt 1 ]; then
  echo "" >&2
  echo "FATAL: platform_users is EMPTY. This is not a usable backup." >&2
  exit 1
fi
if ! grep -q "COPY public.platform_users" "$OUT_DIR/master-$TS.sql" \
   && ! grep -q "INSERT INTO public.platform_users" "$OUT_DIR/master-$TS.sql"; then
  echo "" >&2
  echo "FATAL: the master dump contains no platform_users DATA." >&2
  echo "       Refusing to report success — the admin login is not recoverable." >&2
  exit 1
fi
echo "   -> OK: $PU_COUNT platform user(s) captured in the dump file."

# ---------------------------------------------------------------------------
# 2. EVERY TENANT DATABASE (ADR-001: database-per-tenant)
# ---------------------------------------------------------------------------
echo ""
echo "== 2/3  Dumping EVERY tenant database =="

TENANTS="$(psql "$DATABASE_URL" -A -t -F'|' -c \
  "SELECT id, db_name, COALESCE(status,'') FROM tenants ORDER BY id;")"

TENANT_COUNT=0
if [ -z "$TENANTS" ]; then
  echo "   WARNING: no rows in tenants — legacy single-DB deployment."
  echo "            The master dump above is the whole backup."
else
  # A here-doc (not a pipe) keeps the loop in this shell, so TENANT_COUNT
  # survives the loop.
  while IFS='|' read -r T_ID T_DB T_STATUS; do
    [ -z "${T_DB:-}" ] && continue
    TENANT_COUNT=$((TENANT_COUNT + 1))

    # Swap only the database name, preserving credentials and query string.
    T_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$T_DB\1#")"

    echo "   [$TENANT_COUNT] tenant id=$T_ID db=$T_DB status=$T_STATUS"
    pg_dump "$T_URL" \
      --no-owner --no-privileges --clean --if-exists \
      -f "$OUT_DIR/tenant-$T_DB-$TS.sql"
    echo "        -> tenant-$T_DB-$TS.sql ($(wc -c < "$OUT_DIR/tenant-$T_DB-$TS.sql") bytes)"
  done <<TENANT_ROWS
$TENANTS
TENANT_ROWS
fi

# ---------------------------------------------------------------------------
# 3. MANIFEST — the runbook asks for a recorded timestamp + restore steps
# ---------------------------------------------------------------------------
echo ""
echo "== 3/3  Writing manifest =="
{
  echo "AINO full database backup"
  echo "timestamp_utc : $TS"
  echo "source        : $SAFE_HOST"
  echo "server        : PostgreSQL $SERVER_VERSION"
  echo "master_db     : $MASTER_DB"
  echo "platform_users: $PU_COUNT"
  echo "tenant_dbs    : $TENANT_COUNT"
  echo ""
  echo "--- tenants ---"
  psql "$DATABASE_URL" -A -F'|' -c \
    "SELECT id, slug, status, db_name, is_default FROM tenants ORDER BY id;"
  echo ""
  echo "--- files ---"
  ls -l "$OUT_DIR"
  echo ""
  echo "--- RESTORE ---"
  echo "Rolling back the container image does NOT roll back the database."
  echo ""
  echo "  # 1. master (identity: platform_users + the tenants catalog)"
  echo "  psql \"\$DATABASE_URL\" -f master-$TS.sql"
  echo ""
  echo "  # 2. each tenant, into a URL whose final path segment is that db_name"
  echo "  psql \"postgresql://.../<db_name>\" -f tenant-<db_name>-$TS.sql"
  echo ""
  echo "Every dump was taken with --clean --if-exists, so a restore drops and"
  echo "recreates the objects it owns. Restore into the CORRECT database name:"
  echo "restoring a tenant dump into master would destroy the tenant catalog."
} > "$MANIFEST" 2>&1
cat "$MANIFEST"

echo ""
echo "============================================================"
echo "SUCCESS — 1 master + $TENANT_COUNT tenant database(s) captured."
echo "Record this timestamp in the go/no-go record: $TS"
echo "============================================================"
