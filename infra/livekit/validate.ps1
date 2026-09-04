# infra/livekit/validate.ps1
#
# Local validation for this service definition. Uses only `docker` /
# `docker compose` — tools already required to run this image — no other
# tooling is installed or invoked.
#
# What this checks, in order:
#   1. `docker compose build` — builds Dockerfile. The Dockerfile itself runs
#      `bash -n entrypoint.sh` and `bash -n healthcheck.sh` as a RUN step, so
#      a shell syntax error fails the build right here.
#   2. `docker compose up -d` — starts livekit (LIVEKIT_LOCAL_DEV=true) and a
#      throwaway Redis. entrypoint.sh must render a valid livekit.yaml and
#      exec livekit-server successfully.
#   3. Poll the container's own HEALTHCHECK (curl against LiveKit's `GET /`
#      liveness probe) until it reports healthy, or dump logs and fail.
#   4. Tear the stack down unconditionally.
#
# This does not exercise the Railway TCP-proxy port-forwarding path (that
# requires RAILWAY_TCP_PROXY_* variables that only exist on Railway) — it
# only proves the image builds, boots, and passes its health check.
#
# LIVEKIT_API_KEY/LIVEKIT_API_SECRET are generated fresh, in-process, as
# random local-only values on every run (never Write-Host'd, never written to
# a file) — docker-compose.yml intentionally has no default/hardcoded value
# for either.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$composeFile = Join-Path $PSScriptRoot "docker-compose.yml"

# Local-only test credentials, generated fresh for this run and never
# printed/logged. docker-compose.yml has no default for these (`${VAR:?...}`)
# so they must be supplied via the environment; passing them as process-level
# env vars here (never Write-Host'd, never written to disk) keeps them out of
# both the transcript and docker-compose.yml itself.
function New-LocalOnlySecret([int]$byteLength) {
    $bytes = New-Object byte[] $byteLength
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    -join ($bytes | ForEach-Object { $_.ToString("x2") })
}
$env:LIVEKIT_API_KEY = New-LocalOnlySecret 16    # 32 hex chars
$env:LIVEKIT_API_SECRET = New-LocalOnlySecret 32 # 64 hex chars, >= the 32-char minimum entrypoint.sh enforces

function Fail([string]$msg) {
    Write-Host "[validate] FAILED: $msg" -ForegroundColor Red
    docker compose -f $composeFile logs 2>&1 | Write-Host
    docker compose -f $composeFile down -v | Out-Null
    exit 1
}

Write-Host "[validate] docker compose build (includes bash -n syntax check in Dockerfile)..."
docker compose -f $composeFile build
if ($LASTEXITCODE -ne 0) { Fail "docker compose build failed" }

Write-Host "[validate] starting livekit + redis..."
docker compose -f $composeFile up -d
if ($LASTEXITCODE -ne 0) { Fail "docker compose up failed" }

$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    $status = (docker inspect --format "{{.State.Health.Status}}" workpulse-livekit-dev 2>$null)
    Write-Host "[validate] livekit health: $status"
    if ($status -eq "healthy") { $healthy = $true; break }
    if ($status -eq "unhealthy") { break }
}

if (-not $healthy) {
    Fail "livekit container did not become healthy within ~60s"
}

Write-Host "[validate] OK - image built, container started, and its HEALTHCHECK passed." -ForegroundColor Green
docker compose -f $composeFile down -v | Out-Null
