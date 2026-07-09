<#
.SYNOPSIS
  Automated release script for WorkPulse desktop and mobile apps.
  Bumps version in package.json, creates git tags, and pushes.

.DESCRIPTION
  This script automates the manual release workflow:
    1. Update desktop/package.json version (if -DesktopVersion provided)
    2. Update mobile/package.json version  (if -MobileVersion provided)
    3. Stage changed package.json files
    4. Commit with a descriptive message
    5. Create git tags (vX.Y.Z for desktop, mobile-vA.B.C for mobile)
    6. Push commits and tags

  The CI workflows (desktop-release.yml, mobile-release.yml) are triggered
  automatically by the pushed tags and will build + publish the releases.

.PARAMETER DesktopVersion
  New version for the desktop app (e.g. "1.7.38").
  Must match the format X.Y.Z (semver without leading 'v').

.PARAMETER MobileVersion
  New version for the mobile app (e.g. "1.2.25").
  Must match the format X.Y.Z (semver without leading 'v').

.EXAMPLE
  # Desktop-only release
  .\scripts\release.ps1 -DesktopVersion "1.7.38"

.EXAMPLE
  # Mobile-only release
  .\scripts\release.ps1 -MobileVersion "1.2.25"

.EXAMPLE
  # Release both desktop and mobile together
  .\scripts\release.ps1 -DesktopVersion "1.7.38" -MobileVersion "1.2.25"

.EXAMPLE
  # Using npm run shortcut from repo root
  npm run release -- -DesktopVersion "1.7.38" -MobileVersion "1.2.25"

.NOTES
  - At least one of -DesktopVersion or -MobileVersion must be provided.
  - The script validates the current version in package.json before bumping.
  - Tags are named vX.Y.Z (desktop) and mobile-vX.Y.Z (mobile).
  - CI workflows validate tag matches package.json version.
#>

param(
  [Parameter(Mandatory = $false, Position = 0)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$DesktopVersion,

  [Parameter(Mandatory = $false, Position = 1)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$MobileVersion
)

$ErrorActionPreference = "Stop"

# ── npm run strips named parameters and passes positional args ─────────
# When invoked via `npm run release -- -DesktopVersion "x"`, npm passes the
# values as positional arguments (it strips the -ParamName prefixes).
# Detect this case by checking $args for unrecognized positional values.
if ([string]::IsNullOrEmpty($DesktopVersion) -and [string]::IsNullOrEmpty($MobileVersion) -and $args.Count -gt 0) {
  # First positional arg -> DesktopVersion, second -> MobileVersion
  if ($args[0] -match '^\d+\.\d+\.\d+$') {
    $DesktopVersion = $args[0]
  }
  if ($args.Count -ge 2 -and $args[1] -match '^\d+\.\d+\.\d+$') {
    $MobileVersion = $args[1]
  }
}

# ── Validate at least one version is provided ──────────────────────────
if (-not $DesktopVersion -and -not $MobileVersion) {
  Write-Host @"

ERROR: You must provide at least one of -DesktopVersion or -MobileVersion.

Usage examples:
  npm run release -- -DesktopVersion "1.7.38"
  npm run release -- -MobileVersion "1.2.25"
  npm run release -- -DesktopVersion "1.7.38" -MobileVersion "1.2.25"
"@ -ForegroundColor Red
  exit 1
}

# ── Helper: bump version in a package.json using Node.js ──────────────
function Update-PackageVersion {
  param(
    [string]$PkgPath,
    [string]$NewVersion,
    [string]$Label
  )

  if (-not (Test-Path $PkgPath)) {
    Write-Host "ERROR: $PkgPath not found" -ForegroundColor Red
    exit 1
  }

  # PowerShell's $PkgPath uses Windows backslashes. node's require() needs
  # forward slashes (or escaped backslashes). Replace \ with / for safety.
  $nodePath = $PkgPath.Replace('\', '/')
  $currentVersion = node -p "require('${nodePath}').version" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to read version from $PkgPath" -ForegroundColor Red
    exit 1
  }
  $currentVersion = $currentVersion.Trim()

  if ($currentVersion -eq $NewVersion) {
    Write-Host "WARNING: ${Label} package.json is already at version $NewVersion — skipping" -ForegroundColor Yellow
    return $false
  }

  Write-Host "Bumping ${Label} version: $currentVersion -> $NewVersion" -ForegroundColor Cyan

  # Use node to update the JSON in-place, preserving formatting.
  # $nodePath uses forward slashes — safe inside the JS template literal below.
  $nodeScript = @"
const fs = require('fs');
const pkgPath = '${nodePath}';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = '${NewVersion}';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('Updated ' + pkgPath + ' to version ' + pkg.version);
"@

  node -e $nodeScript
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to update version in $PkgPath" -ForegroundColor Red
    exit 1
  }
  return $true
}

# ── Resolve paths relative to repo root ────────────────────────────────
$repoRoot = (git rev-parse --show-toplevel 2>$null).Trim()
if (-not $repoRoot) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
Set-Location $repoRoot

Write-Host "Repo root: $repoRoot" -ForegroundColor DarkGray
Write-Host ""

# ── Bump versions ──────────────────────────────────────────────────────
$desktopChanged = $false
$mobileChanged = $false

if ($DesktopVersion) {
  $desktopPkg = Join-Path $repoRoot "desktop" "package.json"
  $desktopChanged = Update-PackageVersion -PkgPath $desktopPkg -NewVersion $DesktopVersion -Label "Desktop"
}

if ($MobileVersion) {
  $mobilePkg = Join-Path $repoRoot "mobile" "package.json"
  $mobileChanged = Update-PackageVersion -PkgPath $mobilePkg -NewVersion $MobileVersion -Label "Mobile"
}

if (-not $desktopChanged -and -not $mobileChanged) {
  Write-Host "No version bumps needed. Exiting." -ForegroundColor Yellow
  exit 0
}

# ── Build commit message ───────────────────────────────────────────────
$parts = @()
if ($DesktopVersion) { $parts += "desktop v$DesktopVersion" }
if ($MobileVersion)  { $parts += "mobile v$MobileVersion"  }
$commitMsg = "chore: release " + ($parts -join ", ")

# ── Stage changed files ────────────────────────────────────────────────
Write-Host ""
Write-Host "Staging changed package.json files..." -ForegroundColor Cyan
$filesToStage = @()
if ($desktopChanged) { $filesToStage += "desktop/package.json" }
if ($mobileChanged)  { $filesToStage += "mobile/package.json"  }

foreach ($f in $filesToStage) {
  git add $f
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git add failed for $f" -ForegroundColor Red
    exit 1
  }
  Write-Host "  Staged: $f" -ForegroundColor Green
}

# ── Show summary before committing ─────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  Ready to commit and push:" -ForegroundColor Magenta
Write-Host "    Commit: $commitMsg" -ForegroundColor White
if ($DesktopVersion) {
  Write-Host "    Tag:    v$DesktopVersion (desktop)" -ForegroundColor White
}
if ($MobileVersion) {
  Write-Host "    Tag:    mobile-v$MobileVersion (mobile)" -ForegroundColor White
}
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host ""

$confirmation = Read-Host "Proceed? [y/N]"
if ($confirmation -ne 'y' -and $confirmation -ne 'Y') {
  Write-Host "Aborted by user." -ForegroundColor Yellow
  exit 0
}

# ── Commit ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Committing..." -ForegroundColor Cyan
git commit -m $commitMsg
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: git commit failed" -ForegroundColor Red
  exit 1
}
Write-Host "  Committed: $commitMsg" -ForegroundColor Green

# ── Create tags ────────────────────────────────────────────────────────
$tagsCreated = @()

if ($DesktopVersion) {
  $tag = "v$DesktopVersion"
  Write-Host "Creating tag: $tag" -ForegroundColor Cyan
  git tag $tag
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git tag failed for $tag" -ForegroundColor Red
    exit 1
  }
  $tagsCreated += $tag
  Write-Host "  Tagged: $tag" -ForegroundColor Green
}

if ($MobileVersion) {
  $tag = "mobile-v$MobileVersion"
  Write-Host "Creating tag: $tag" -ForegroundColor Cyan
  git tag $tag
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git tag failed for $tag" -ForegroundColor Red
    exit 1
  }
  $tagsCreated += $tag
  Write-Host "  Tagged: $tag" -ForegroundColor Green
}

# ── Push ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Pushing commits and tags..." -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: git push failed" -ForegroundColor Red
  exit 1
}

git push --tags
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: git push --tags failed" -ForegroundColor Red
  exit 1
}

# ── Done ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Release pushed successfully!" -ForegroundColor Green
Write-Host "  Tags created: $($tagsCreated -join ', ')" -ForegroundColor White
Write-Host "  CI workflows should now be running:" -ForegroundColor White
if ($DesktopVersion) {
  Write-Host "    -> Desktop: https://github.com/vvronline/WorkPulse/actions/workflows/desktop-release.yml" -ForegroundColor DarkGray
}
if ($MobileVersion) {
  Write-Host "    -> Mobile:  https://github.com/vvronline/WorkPulse/actions/workflows/mobile-release.yml" -ForegroundColor DarkGray
}
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Green