[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$RequestPath)

$ErrorActionPreference = 'Stop'
$request = $null
$nativeLoaded = $false

try {
  if ($env:OS -ne 'Windows_NT') { throw 'This proof of concept only runs on Windows.' }
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  Add-Type -Path (Join-Path $PSScriptRoot 'SandboxProcessApi.cs') -ErrorAction Stop
  $nativeLoaded = $true

  if ($request.action -eq 'delete-profile') {
    $deleted = [LsWindowsSandboxProcess]::DeleteProfile([string]$request.identity)
    if (-not $deleted) { throw 'AppContainer profile cleanup failed.' }
    exit 0
  }

  $reason = ''
  if (-not [LsWindowsSandboxProcess]::ApiAvailable([ref]$reason)) {
    throw "Sandbox backend unavailable: $reason; refusing unsandboxed launch."
  }

  $result = [LsWindowsSandboxProcess]::Run(
    [string]$request.executable,
    [string[]]$request.arguments,
    [string]$request.workspace,
    [string]$request.currentDirectory,
    [string]$request.identity,
    [string]$request.specificationPath,
    [string]$request.launchMarkerPath,
    [string]$request.resultPath,
    [string]$request.pathValue,
    [string]$request.modulePathValue,
    [int]$request.timeoutMilliseconds
  )
  exit $result.ExitCode
}
catch {
  $message = $_.Exception.Message
  [Console]::Error.WriteLine("sandbox_poc_error: {0}", $message)
  if ($request -and $request.errorPath) {
    try {
      [IO.File]::WriteAllText([string]$request.errorPath, (@{ error = $message } | ConvertTo-Json -Compress))
    }
    catch { }
  }
  exit 70
}
finally {
  if ($nativeLoaded -and $request -and $request.action -ne 'delete-profile' -and $request.identity) {
    try {
      if (-not [LsWindowsSandboxProcess]::DeleteProfile([string]$request.identity)) {
        [Console]::Error.WriteLine('sandbox_poc_warning: AppContainer profile cleanup failed.')
      }
    }
    catch {
      # An abruptly terminated worker skips this block; the parent harness owns
      # profile cleanup for that cancellation test.
    }
  }
}
