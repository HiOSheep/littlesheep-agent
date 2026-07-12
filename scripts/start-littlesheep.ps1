[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location $repoRoot
try {
  Write-Host 'Starting LittleSheep in development mode...'
  & pnpm.cmd --filter '@littlesheep/app' dev
  if ($LASTEXITCODE -ne 0) {
    throw "LittleSheep exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
