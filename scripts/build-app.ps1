[CmdletBinding()]
param(
  [switch]$SkipShortcut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Judge native commands by their exit code, never by whether they wrote to stderr.
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib\pnpm-executable.ps1')

Push-Location $repoRoot
try {
  Write-Host 'Building LittleSheep desktop app...'
  $pnpm = Resolve-PnpmExecutable -RepoRoot $repoRoot
  & $pnpm run build
  if ($LASTEXITCODE -ne 0) {
    throw "LittleSheep app build failed with exit code $LASTEXITCODE."
  }

  if (-not $SkipShortcut) {
    & (Join-Path $PSScriptRoot 'refresh-desktop-shortcut.ps1')
  }
} finally {
  Pop-Location
}

Write-Host 'LittleSheep desktop app is ready.'
