[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Judge native commands by their exit code, never by whether they wrote to stderr.
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib\pnpm-executable.ps1')

Push-Location $repoRoot
try {
  Write-Host 'Starting LittleSheep in development mode...'
  $pnpm = Resolve-PnpmExecutable -RepoRoot $repoRoot
  & $pnpm --filter '@littlesheep/app' dev
  if ($LASTEXITCODE -ne 0) {
    throw "LittleSheep exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
