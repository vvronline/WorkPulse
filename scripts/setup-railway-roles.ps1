<#
.SYNOPSIS
  Phase F helper: create AINO web/realtime/worker services on Railway.

.DESCRIPTION
  Dry-run by default. With -Apply, creates missing services from the same GitHub
  repository and sets only non-secret role configuration. Shared secrets and
  reference variables must be copied/referenced in the Railway dashboard before
  deployment; this script deliberately never reads or prints them.

  pwsh ./scripts/setup-railway-roles.ps1
  pwsh ./scripts/setup-railway-roles.ps1 -Apply
#>
param([switch]$Apply)

$ErrorActionPreference = "Stop"
$repo = "vvronline/WorkPulse"
$branch = "master"
$services = @(
    @{ Name = "aino-web";      Role = "web" },
    @{ Name = "aino-realtime"; Role = "realtime" },
    @{ Name = "aino-worker";   Role = "worker" }
)

railway status --json | Out-Null
Write-Host "Railway role-service plan (repo $repo, branch $branch)"
foreach ($item in $services) {
    Write-Host "  $($item.Name): ROLE=$($item.Role), health=/readyz"
}

if (-not $Apply) {
    Write-Host "DRY RUN — no changes made. Re-run with -Apply to create/configure services."
    exit 0
}

$existing = railway service list --json | ConvertFrom-Json
foreach ($item in $services) {
    if (-not ($existing | Where-Object { $_.name -eq $item.Name })) {
        railway add --service $item.Name --repo $repo --branch $branch --json | Out-Null
        Write-Host "Created $($item.Name)."
    }
    railway variable set "ROLE=$($item.Role)" --service $item.Name | Out-Null
    railway variable set "SERVE_SPA=false" --service $item.Name | Out-Null
    railway variable set "NODE_ENV=production" --service $item.Name | Out-Null
}

Write-Host "Services created. Before deploy, configure shared DATABASE_URL, REDIS_URL, JWT_SECRET,"
Write-Host "R2 upload credentials, mail/push secrets, private domains and /readyz health checks."