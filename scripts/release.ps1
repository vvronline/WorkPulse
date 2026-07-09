<#
.SYNOPSIS
  Automated release script for WorkPulse desktop and mobile apps.
  Reads current versions, auto-increments, bumps package.json, stages all
  changes, lets you edit the commit message, creates git tags, and pushes.

.DESCRIPTION
  This script automates the manual release workflow:
    1. Read current versions from desktop/package.json and mobile/package.json
    2. Auto-bump the version(s) (patch by default; minor / major keywords)
    3. Update the package.json file(s) in-place
    4. Detect other uncommitted changes — ask whether to include them
    5. Stage all files to commit
    6. Suggest a commit message — user can edit or accept
    7. Create git tags (vX.Y.Z for desktop, mobile-vA.B.C for mobile)
    8. Push commits and tags

.PARAMETER Channel
  Which channel(s) to release. One or two of: "desktop", "mobile".
  Used positionally (no - prefix needed for npm run).

.PARAMETER Bump
  Bump level — "patch" (default), "minor", or "major".
  Optional positional arg after the channel name(s).

.PARAMETER DesktopVersion
  Explicit desktop version override (e.g. "2.0.0"). Overrides auto-bump.

.PARAMETER MobileVersion
  Explicit mobile version override (e.g. "2.0.0"). Overrides auto-bump.

.EXAMPLE
  # Desktop patch bump (auto) — via npm
  npm run release -- desktop

.EXAMPLE
  # Desktop minor bump
  npm run release -- desktop minor

.EXAMPLE
  # Desktop major bump
  npm run release -- desktop major

.EXAMPLE
  # Mobile only patch bump
  npm run release -- mobile

.EXAMPLE
  # Mobile minor bump
  npm run release -- mobile minor

.EXAMPLE
  # Both channels patch bump
  npm run release -- desktop mobile

.EXAMPLE
  # Desktop minor + mobile patch
  npm run release -- desktop minor mobile

.EXAMPLE
  # Explicit version override (via PowerShell directly)
  .\scripts\release.ps1 -DesktopVersion "2.0.0"

.NOTES
  - At least one channel must be specified.
  - Tags are named vX.Y.Z (desktop) and mobile-vX.Y.Z (mobile).
  - CI workflows validate tag matches package.json version.
#>

param(
  # Positional args: [desktop|mobile] [patch|minor|major] [desktop|mobile]
  # These are filled from $args when npm strips named params.
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$Channel1,

  [Parameter(Mandatory = $false, Position = 1)]
  [string]$Arg2,

  [Parameter(Mandatory = $false, Position = 2)]
  [string]$Arg3,

  # ── Explicit version overrides (PowerShell direct use) ───────────────
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$DesktopVersion,

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$MobileVersion
)

$ErrorActionPreference = "Stop"

# ═══════════════════════════════════════════════════════════════════════════
# Helper functions
# ═══════════════════════════════════════════════════════════════════════════

function Write-Banner {
  param([string]$Text, [string]$Color = "Magenta")
  $line = "═" * 62
  Write-Host $line -ForegroundColor $Color
  Write-Host "  $Text" -ForegroundColor $Color
  Write-Host $line -ForegroundColor $Color
}

function Read-VersionFromPackage {
  param([string]$PkgPath)
  $nodePath = $PkgPath.Replace('\', '/')
  $ver = node -p "require('${nodePath}').version" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Failed to read version from $PkgPath" }
  return $ver.Trim()
}

function Write-VersionToPackage {
  param([string]$PkgPath, [string]$NewVersion)
  $nodePath = $PkgPath.Replace('\', '/')
  $script = @"
const fs = require('fs');
const pkgPath = '${nodePath}';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = '${NewVersion}';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
"@
  node -e $script
  if ($LASTEXITCODE -ne 0) { throw "Failed to update version in $PkgPath" }
}

function Bump-Version {
  param(
    [string]$Current,
    [string]$Level = "patch"
  )
  $parts = $Current.Split('.')
  $maj = [int]$parts[0]
  $min = [int]$parts[1]
  $pat = [int]$parts[2]

  switch ($Level) {
    "major" {
      $maj++
      $min = 0
      $pat = 0
    }
    "minor" {
      $min++
      $pat = 0
    }
    default {
      # patch
      $pat++
    }
  }
  return "$maj.$min.$pat"
}

# ═══════════════════════════════════════════════════════════════════════════
# Parse positional arguments: [desktop|mobile] [patch|minor|major] [desktop|mobile]
# Works both via npm (positional) and pwsh directly (named/switch).
# ═══════════════════════════════════════════════════════════════════════════

$allPositional = @($Channel1, $Arg2, $Arg3 | Where-Object { $_ })

$releaseDesktop  = $false
$releaseMobile   = $false
$desktopBump     = "patch"
$mobileBump      = "patch"

foreach ($arg in $allPositional) {
  switch ($arg.ToLower()) {
    "desktop" { $releaseDesktop = $true }
    "mobile"  { $releaseMobile  = $true }
    "patch"   { $desktopBump = "patch";  $mobileBump = "patch"  }
    "minor"   { $desktopBump = "minor";  $mobileBump = "minor"  }
    "major"   { $desktopBump = "major";  $mobileBump = "major"  }
    default   {
      Write-Host "ERROR: Unrecognized argument: '$arg'" -ForegroundColor Red
      Write-Host "Expected: desktop, mobile, patch, minor, major" -ForegroundColor Red
      exit 1
    }
  }
}

# Explicit version overrides take precedence
if ($DesktopVersion) {
  $releaseDesktop = $true
}
if ($MobileVersion) {
  $releaseMobile = $true
}

# ── Validate at least one channel ──────────────────────────────────────
if (-not $releaseDesktop -and -not $releaseMobile) {
  Write-Host @"

ERROR: You must specify at least one release channel.

Usage examples:
  npm run release -- desktop              # desktop patch bump
  npm run release -- desktop minor        # desktop minor bump
  npm run release -- desktop major        # desktop major bump
  npm run release -- mobile               # mobile patch bump
  npm run release -- desktop mobile       # both patch bumps
  npm run release -- desktop minor mobile # desktop minor + mobile patch
"@ -ForegroundColor Red
  exit 1
}

# ═══════════════════════════════════════════════════════════════════════════
# Resolve repo root
# ═══════════════════════════════════════════════════════════════════════════

$repoRoot = (git rev-parse --show-toplevel 2>$null).Trim()
if (-not $repoRoot) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
Set-Location $repoRoot

Write-Host "Repo root: $repoRoot" -ForegroundColor DarkGray
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════
# Compute new versions
# ═══════════════════════════════════════════════════════════════════════════

$desktopPkg = Join-Path $repoRoot "desktop" "package.json"
$mobilePkg  = Join-Path $repoRoot "mobile"  "package.json"

$desktopOldVersion = ""
$desktopNewVersion = ""
$mobileOldVersion  = ""
$mobileNewVersion  = ""

if ($releaseDesktop) {
  $desktopOldVersion = Read-VersionFromPackage $desktopPkg
  if ($DesktopVersion) {
    $desktopNewVersion = $DesktopVersion
  } else {
    $desktopNewVersion = Bump-Version -Current $desktopOldVersion -Level $desktopBump
  }
  Write-Host "Desktop: $desktopOldVersion -> $desktopNewVersion ($desktopBump bump)" -ForegroundColor Cyan
}

if ($releaseMobile) {
  $mobileOldVersion = Read-VersionFromPackage $mobilePkg
  if ($MobileVersion) {
    $mobileNewVersion = $MobileVersion
  } else {
    $mobileNewVersion = Bump-Version -Current $mobileOldVersion -Level $mobileBump
  }
  Write-Host "Mobile:  $mobileOldVersion -> $mobileNewVersion ($mobileBump bump)" -ForegroundColor Cyan
}

Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════
# Bump package.json files
# ═══════════════════════════════════════════════════════════════════════════

$filesStaged = @()

if ($releaseDesktop -and $desktopNewVersion -ne $desktopOldVersion) {
  Write-VersionToPackage -PkgPath $desktopPkg -NewVersion $desktopNewVersion
  git add "desktop/package.json" 2>$null
  $filesStaged += "desktop/package.json"
}
elseif ($releaseDesktop) {
  Write-Host "Desktop: already at $desktopNewVersion — skipping" -ForegroundColor Yellow
}

if ($releaseMobile -and $mobileNewVersion -ne $mobileOldVersion) {
  Write-VersionToPackage -PkgPath $mobilePkg -NewVersion $mobileNewVersion
  git add "mobile/package.json" 2>$null
  $filesStaged += "mobile/package.json"
}
elseif ($releaseMobile) {
  Write-Host "Mobile:  already at $mobileNewVersion — skipping" -ForegroundColor Yellow
}

if ($filesStaged.Count -eq 0) {
  Write-Host "No version bumps needed. Exiting." -ForegroundColor Yellow
  exit 0
}

# ═══════════════════════════════════════════════════════════════════════════
# Detect other uncommitted/untracked changes
# ═══════════════════════════════════════════════════════════════════════════

Write-Host ""
$otherChanges = @(git status --porcelain 2>$null | Where-Object { $_ -match '\S' })

if ($otherChanges.Count -gt 0) {
  Write-Host "Other uncommitted changes detected:" -ForegroundColor Yellow
  foreach ($line in $otherChanges) {
    $statusCode = $line.Substring(0, 2).Trim()
    $fileName = $line.Substring(2).Trim()
    $indicator = switch ($statusCode) {
      "M"  { "modified"  }
      "A"  { "added"     }
      "D"  { "deleted"   }
      "R"  { "renamed"   }
      "C"  { "copied"    }
      "??" { "untracked" }
      default { $statusCode }
    }
    Write-Host "  [$indicator] $fileName" -ForegroundColor DarkYellow
  }
  Write-Host ""

  $includeOthers = Read-Host "Include these in the release commit? [Y/n]"
  if ($includeOthers -ne 'n' -and $includeOthers -ne 'N') {
    git add --all
    if ($LASTEXITCODE -ne 0) {
      Write-Host "ERROR: Failed to stage additional files" -ForegroundColor Red
      exit 1
    }
    Write-Host "All changes staged." -ForegroundColor Green
  }
  else {
    Write-Host "Skipping additional changes — only package.json(s) will be committed." -ForegroundColor DarkGray
  }
}

Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════
# Build suggested commit message
# ═══════════════════════════════════════════════════════════════════════════

$tagParts = @()
if ($releaseDesktop) { $tagParts += "desktop v$desktopNewVersion" }
if ($releaseMobile)  { $tagParts += "mobile v$mobileNewVersion" }
$suggestedMsg = "chore: release " + ($tagParts -join ", ")

# ═══════════════════════════════════════════════════════════════════════════
# Show summary & get confirmation
# ═══════════════════════════════════════════════════════════════════════════

$allStaged = @(git diff --cached --name-only 2>$null | Where-Object { $_ -match '\S' })

Write-Banner "Ready to commit and push"

Write-Host "  Files to commit:" -ForegroundColor White
foreach ($f in $allStaged) {
  Write-Host "    $f" -ForegroundColor DarkGray
}
Write-Host ""

if ($releaseDesktop) {
  Write-Host "  Tag:    v$desktopNewVersion (desktop)" -ForegroundColor White
}
if ($releaseMobile) {
  Write-Host "  Tag:    mobile-v$mobileNewVersion (mobile)" -ForegroundColor White
}

Write-Host ""
Write-Host "Suggested commit message:" -ForegroundColor White
Write-Host "  $suggestedMsg" -ForegroundColor Gray
Write-Host ""

$commitMsg = Read-Host "Commit message (Enter to accept, or type a new one)"
if ([string]::IsNullOrWhiteSpace($commitMsg)) {
  $commitMsg = $suggestedMsg
}

Write-Host ""
$confirmation = Read-Host "Proceed with commit, tag & push? [y/N]"
if ($confirmation -ne 'y' -and $confirmation -ne 'Y') {
  Write-Host "Aborted by user." -ForegroundColor Yellow
  exit 0
}

# ═══════════════════════════════════════════════════════════════════════════
# Commit
# ═══════════════════════════════════════════════════════════════════════════

Write-Host ""
Write-Host "Committing..." -ForegroundColor Cyan
git commit -m $commitMsg
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: git commit failed" -ForegroundColor Red
  exit 1
}
Write-Host "  Committed: $commitMsg" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════════════════
# Create tags
# ═══════════════════════════════════════════════════════════════════════════

$tagsCreated = @()

if ($releaseDesktop) {
  $tag = "v$desktopNewVersion"
  Write-Host "Creating tag: $tag" -ForegroundColor Cyan
  git tag $tag
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git tag failed for $tag" -ForegroundColor Red
    exit 1
  }
  $tagsCreated += $tag
  Write-Host "  Tagged: $tag" -ForegroundColor Green
}

if ($releaseMobile) {
  $tag = "mobile-v$mobileNewVersion"
  Write-Host "Creating tag: $tag" -ForegroundColor Cyan
  git tag $tag
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git tag failed for $tag" -ForegroundColor Red
    exit 1
  }
  $tagsCreated += $tag
  Write-Host "  Tagged: $tag" -ForegroundColor Green
}

# ═══════════════════════════════════════════════════════════════════════════
# Push
# ═══════════════════════════════════════════════════════════════════════════

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

# ═══════════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════════

Write-Host ""
Write-Banner "Release pushed successfully!" "Green"
Write-Host "  Tags: $($tagsCreated -join ', ')" -ForegroundColor White
Write-Host "  CI workflows:" -ForegroundColor White
if ($releaseDesktop) {
  Write-Host "    -> Desktop: https://github.com/vvronline/WorkPulse/actions/workflows/desktop-release.yml" -ForegroundColor DarkGray
}
if ($releaseMobile) {
  Write-Host "    -> Mobile:  https://github.com/vvronline/WorkPulse/actions/workflows/mobile-release.yml" -ForegroundColor DarkGray
}
Write-Host ""