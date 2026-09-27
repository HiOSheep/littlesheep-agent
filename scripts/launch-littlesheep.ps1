[CmdletBinding()]
param(
  # Skip the freshness check (used by tests and by anyone who just built).
  [switch]$NoBuild,
  # Only (re)point the shortcuts at this launcher, then exit.
  [switch]$ShortcutsOnly,
  # Remove stale runtime staging directories and old Electron versions, then exit.
  [switch]$CleanOnly
)

# LittleSheep launcher: the desktop and Start-menu shortcuts point here instead of at a
# version-specific Electron binary, so upgrading Electron, moving the runtime directory or
# changing application sources never leaves the icon starting stale code.
#
# It does three things, in order, and each one is idempotent:
#   1. keep both shortcuts pointing at this script (the first run installs them);
#   2. make the app build match the sources, unless -NoBuild is given — an explicit
#      `ensure` rather than a blind rebuild, so a fresh checkout costs a fingerprint read;
#   3. resolve the newest packages/app/runtime/electron-v*-win32-x64 and start it with the
#      app directory as its argument.
#
# It writes nothing inside the repository: the Electron runtime is prepared by
# scripts/prepare-littlesheep-runtime.mjs, the build output lives in packages/app/out, and
# everything the running app caches goes to the user data root. Stale runtime staging
# directories left behind by an interrupted preparation are removed on the way.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appRoot = Join-Path $repoRoot 'packages\app'
$runtimeRoot = Join-Path $appRoot 'runtime'
$scriptPath = $MyInvocation.MyCommand.Path

function Get-ShortcutPaths {
  $paths = [System.Collections.Generic.List[string]]::new()
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) { $paths.Add((Join-Path $desktop 'LittleSheep.lnk')) }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  if (Test-Path $programs) { $paths.Add((Join-Path $programs 'LittleSheep.lnk')) }
  return $paths
}

function Install-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  # A hidden PowerShell keeps the console window out of the way; the launcher still waits
  # for Electron so that closing the app ends the process tree.
  $target = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
  if (-not $target) { $target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
  $icon = Join-Path $appRoot 'build\icon.ico'
  foreach ($path in Get-ShortcutPaths) {
    $existing = $shell.CreateShortcut($path)
    $changed = $existing.TargetPath -ne $target `
      -or $existing.Arguments -ne $arguments `
      -or $existing.WorkingDirectory -ne $appRoot
    if (-not $changed) {
      Write-Host "Shortcut already current: $path"
      continue
    }
    $existing.TargetPath = $target
    $existing.Arguments = $arguments
    $existing.WorkingDirectory = $appRoot
    if (Test-Path $icon) { $existing.IconLocation = "$icon,0" }
    $existing.Description = 'Start LittleSheep from this checkout (always the current build)'
    $existing.Save()
    Write-Host "Shortcut updated: $path"
  }
}

function Remove-StaleRuntimes {
  if (-not (Test-Path $runtimeRoot)) { return }
  $installed = @(Get-ChildItem $runtimeRoot -Directory |
    Where-Object { $_.Name -match '^electron-v[\d.]+-win32-x64$' } |
    Sort-Object { [version]($_.Name -replace '^electron-v' -replace '-win32-x64$') } -Descending)
  # Staging directories carry a numeric suffix; they only exist because a preparation run was
  # interrupted, and nothing launches from them.
  $stale = @(Get-ChildItem $runtimeRoot -Directory | Where-Object { $_.Name -match '^electron-v[\d.]+-win32-x64-\d+$' })
  $obsolete = if ($installed.Count -gt 1) { $installed[1..($installed.Count - 1)] } else { @() }
  foreach ($directory in @($stale) + @($obsolete)) {
    $size = [math]::Round((Get-ChildItem $directory.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    Remove-Item $directory.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed stale runtime: $($directory.Name) ($size MiB)"
  }
  if ($installed.Count -eq 0) {
    throw "No Electron runtime under $runtimeRoot. Run: node scripts/prepare-littlesheep-runtime.mjs"
  }
}

function Get-CurrentRuntime {
  $installed = @(Get-ChildItem $runtimeRoot -Directory |
    Where-Object { $_.Name -match '^electron-v[\d.]+-win32-x64$' } |
    Sort-Object { [version]($_.Name -replace '^electron-v' -replace '-win32-x64$') } -Descending)
  if ($installed.Count -eq 0) {
    throw "No Electron runtime under $runtimeRoot. Run: node scripts/prepare-littlesheep-runtime.mjs"
  }
  return $installed[0].FullName
}

Push-Location $repoRoot
try {
  Install-Shortcuts
  if ($ShortcutsOnly) { return }

  Remove-StaleRuntimes
  if ($CleanOnly) { return }

  if (-not $NoBuild) {
    Write-Host 'Checking the app build...'
    & pnpm.cmd run ensure:app-build
    if ($LASTEXITCODE -ne 0) { throw "ensure:app-build exited with code $LASTEXITCODE." }
  }

  $runtime = Get-CurrentRuntime
  $executable = Join-Path $runtime 'LittleSheep.exe'
  if (-not (Test-Path $executable)) { throw "Runtime executable is missing: $executable" }

  # Electron runs as plain Node when this is inherited from the calling shell, and then the app
  # dies with "Cannot read properties of undefined (reading 'requestSingleInstanceLock')". The
  # launcher must not pass that on: measured here, clearing it is the difference between a dead
  # process and readiness in about four seconds.
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE }
  Write-Host "Starting LittleSheep from $runtime"
  $process = Start-Process -FilePath $executable -ArgumentList '.' -WorkingDirectory $appRoot -PassThru
  $process.WaitForExit()
} finally {
  Pop-Location
}
