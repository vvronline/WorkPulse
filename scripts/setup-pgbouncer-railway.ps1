<#
.SYNOPSIS
  Phase E helper: create and configure the PgBouncer Railway service.

.DESCRIPTION
  Non-interactive except for an explicit -Apply switch. Without -Apply it only
  prints the planned operations. It never reads or prints database passwords;
  all credentials are Railway reference variables resolved server-side.

  Run from the linked repository root:
    pwsh ./scripts/setup-pgbouncer-railway.ps1          # dry-run
    pwsh ./scripts/setup-pgbouncer-railway.ps1 -Apply   # create/configure

  After provisioning, follow infra/pgbouncer/README.md to point a STAGING app
  role at the private PgBouncer domain. Do not switch production first.
#>
param([switch]$Apply)

$ErrorActionPreference = "Stop"
$service = "PgBouncer"
$image = "edoburu/pgbouncer:v1.24.1-p1"

$variables = @(
    'DB_HOST=${{Postgres.PGHOST}}',
    'DB_PORT=${{Postgres.PGPORT}}',
    'DB_USER=${{Postgres.PGUSER}}',
    'DB_PASSWORD=${{Postgres.PGPASSWORD}}',
    'DB_NAME=${{Postgres.PGDATABASE}}',
    'POOL_MODE=transaction',
    'DEFAULT_POOL_SIZE=20',
    'MIN_POOL_SIZE=0',
    'RESERVE_POOL_SIZE=5',
    'MAX_CLIENT_CONN=500',
    'MAX_DB_CONNECTIONS=80',
    'LISTEN_PORT=5432',
    'SERVER_TLS_SSLMODE=prefer',
    'IGNORE_STARTUP_PARAMETERS=extra_float_digits,options'
)

Write-Host "PgBouncer Railway plan"
Write-Host "  service: $service"
Write-Host "  image:   $image"
Write-Host "  mode:    transaction"
Write-Host "  vars:    $($variables.Count) (credentials are reference variables)"

if (-not $Apply) {
    Write-Host "DRY RUN — no changes made. Re-run with -Apply to provision."
    exit 0
}

$status = railway status --json | ConvertFrom-Json
if (-not $status.id) { throw "This directory is not linked to a Railway project." }

$existing = railway service list --json | ConvertFrom-Json
if ($existing | Where-Object { $_.name -eq $service }) {
    Write-Host "$service already exists — skipping creation."
} else {
    railway add --service $service --image $image --json | Out-Null
    Write-Host "Created $service."
}

foreach ($entry in $variables) {
    railway variable set $entry --service $service | Out-Null
}

Write-Host "Configured $service. Verify it is healthy before changing DATABASE_URL."
railway service status --service $service --json