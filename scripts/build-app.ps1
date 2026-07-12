[CmdletBinding()]
param(
  [switch]$SkipShortcut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location $repoRoot
try {
  Write-Host 'Building LittleSheep desktop app...'
  & pnpm.cmd run build
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
