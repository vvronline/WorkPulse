<#
.SYNOPSIS
  WorkPulse — local production-like build & run (Windows)
.DESCRIPTION
  Builds the client, then starts the server serving the built files.
.PARAMETER SkipBuild
  Skip the client build and reuse the last build in client/dist.
.EXAMPLE
  .\start-local.ps1
  .\start-local.ps1 -SkipBuild
#>
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Client = Join-Path $Root 'client'
$Server = Join-Path $Root 'server'

function Log   ($msg) { Write-Host "[build] $msg" -ForegroundColor Green }
function Warn  ($msg) { Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Abort ($msg) { Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

# ── check prereqs ──
if (-not (Get-Command node   -ErrorAction SilentlyContinue)) { Abort "node is not installed" }
if (-not (Get-Command npm    -ErrorAction SilentlyContinue)) { Abort "npm is not installed" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Abort "docker is not installed" }

# ── install deps if needed ──
function Install-Deps($dir) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Log "Installing dependencies in $(Split-Path -Leaf $dir)…"
        Push-Location $dir
        npm install
        Pop-Location
    }
}

Install-Deps $Client
Install-Deps $Server

# ── start postgres + redis via docker compose (dev overlay) ──
Log "Starting Postgres and Redis via Docker…"
$ComposeFiles = '-f', (Join-Path $Root 'docker-compose.yml'), '-f', (Join-Path $Root 'docker-compose.dev.yml')
& docker compose @ComposeFiles up -d postgres redis
if ($LASTEXITCODE -ne 0) { Abort "docker compose failed to start services" }

# wait until postgres is healthy (up to 60 s)
Log "Waiting for Postgres to be ready…"
$deadline = (Get-Date).AddSeconds(60)
do {
    $health = & docker inspect --format='{{.State.Health.Status}}' workpulse-postgres 2>$null
    if ($health -eq 'healthy') { break }
    if ((Get-Date) -ge $deadline) { Abort "Postgres did not become healthy within 60 s" }
    Start-Sleep -Seconds 2
} while ($true)
Log "Postgres is ready."

# ── build client ──
if (-not $SkipBuild) {
    Log "Building client…"
    Push-Location $Client
    npm run build
    Pop-Location
    Log "Client built → client\dist\"
} else {
    Warn "Skipping client build (-SkipBuild)"
    if (-not (Test-Path (Join-Path $Client 'dist'))) {
        Abort "client\dist not found — run without -SkipBuild first"
    }
}

# ── kill any existing process on port 5000 ──
$port = if ($env:PORT) { $env:PORT } else { '5000' }
$procIds = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -gt 0 }
foreach ($procId in $procIds) {
    Warn "Killing existing process on port $port (PID $procId)"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
if ($procIds) { Start-Sleep -Milliseconds 500 }

# ── load server .env into the current environment ──
# index.ts statically imports db.ts, whose DATABASE_URL check runs before
# dotenv loads (ESM imports are hoisted). Loading env vars here guarantees
# they're present before node starts.
$envFile = Join-Path $Server '.env'
if (Test-Path $envFile) {
    Log "Loading environment from server\.env"
    foreach ($line in Get-Content $envFile) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $trimmed.Substring(0, $eq).Trim()
        $val = $trimmed.Substring($eq + 1).Trim()
        # strip surrounding quotes if present
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
            ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        Set-Item -Path "Env:$key" -Value $val
    }
} else {
    Warn "server\.env not found — relying on existing environment variables"
}

# ── run database migrations ──
Log "Running database migrations…"
Set-Location $Server
& npx tsx migrate.ts
if ($LASTEXITCODE -ne 0) { Abort "database migrations failed" }

# ── start server ──
Log "Starting server on http://localhost:$port"
Log "Open http://localhost:$port in your browser to use WorkPulse"
& npx tsx index.ts
