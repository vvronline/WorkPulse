# Helper for the WorkPulse -> AINO rebrand.
#
# Performs literal (non-regex) string replacements while PRESERVING the file's
# existing line endings and encoding. The repo mixes CRLF (most files) and LF
# (e.g. mobile/app.config.ts), so patterns authored with "`n" silently fail to
# match CRLF files -- this normalises the search text to whatever the target
# file actually uses.
#
# Usage:
#   .\scripts\rebrand-replace.ps1 -Path <file> -Old <text> -New <text> [-Count <n>]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Old,
    [Parameter(Mandatory = $true)][string]$New,
    [int]$Count = 0
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "File not found: $Path"
    exit 1
}

$content = [IO.File]::ReadAllText($Path)

# Match the file's dominant line ending so multi-line patterns apply cleanly.
$crlfCount = ([regex]::Matches($content, "`r`n")).Count
$useCrlf = $crlfCount -gt 0

function ConvertTo-FileEol([string]$text, [bool]$crlf) {
    $lf = $text -replace "`r`n", "`n"
    if ($crlf) { return $lf -replace "`n", "`r`n" }
    return $lf
}

$oldNorm = ConvertTo-FileEol $Old $useCrlf
$newNorm = ConvertTo-FileEol $New $useCrlf

$occurrences = ([regex]::Matches($content, [regex]::Escape($oldNorm))).Count
if ($occurrences -eq 0) {
    Write-Output "MISS   $Path"
    exit 2
}

if ($Count -gt 0) {
    $rx = [regex]::new([regex]::Escape($oldNorm))
    $updated = $rx.Replace($content, { param($m) $newNorm }, $Count)
} else {
    $updated = $content.Replace($oldNorm, $newNorm)
}

# Preserve UTF-8 without BOM (the repo convention).
[IO.File]::WriteAllText($Path, $updated, (New-Object Text.UTF8Encoding $false))
Write-Output "OK($occurrences) $Path"
