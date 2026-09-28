[CmdletBinding()]
param(
  # Start the build that is already on disk even though it cannot be proven current.
  [switch]$AllowStaleBuild,
  # Legacy name for -AllowStaleBuild, kept so an existing habit keeps working.
  [switch]$NoBuild,
  # Only (re)point the shortcuts at this launcher, then exit.
  [switch]$ShortcutsOnly,
  # Remove stale runtime staging directories and old Electron versions, then exit.
  [switch]$CleanOnly,
  # Print a failure instead of showing a message box (automation and the launch gate).
  [switch]$NoDialog
)

# LittleSheep launcher: the desktop and Start-menu shortcuts point here instead of at a
# version-specific Electron binary, so upgrading Electron, moving the runtime directory or
# changing application sources never leaves the icon starting stale code.
#
# It does three things, in order, and each one is idempotent:
#   1. keep both shortcuts pointing at this script (the first run installs them);
#   2. make the app build match the sources, unless -AllowStaleBuild is given — an explicit
#      `ensure` rather than a blind rebuild, so a fresh checkout costs a fingerprint read;
#   3. resolve the newest packages/app/runtime/electron-v*-win32-x64 and start it with the
#      app directory as its argument.
#
# Step 2 is fail-closed, and it is the reason this script exists rather than a link to
# LittleSheep.exe. "The build command exited 0" is not evidence that the bundle matches the
# sources, and neither is an empty console: `ensure:app-build` is asked to make the build current
# and then the *fingerprint* is asked, in a second read-only pass, whether it is. When it is not,
# nothing is started — the reason is printed and shown in a message box, because a shortcut runs
# this script with a hidden window and a silent fallback to the previous build is exactly what
# makes a UI change look like it did not work.
#
# It writes nothing inside the repository: the Electron runtime is prepared by
# scripts/prepare-littlesheep-runtime.mjs, the build output lives in packages/app/out, and
# everything the running app caches goes to the user data root. Stale runtime staging
# directories left behind by an interrupted preparation are removed on the way.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Judge external commands by their exit code, never by whether they wrote to stderr: `node`
# reports warnings and progress there, and a silent failure must not read as success.
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appRoot = Join-Path $repoRoot 'packages\app'
$runtimeRoot = Join-Path $appRoot 'runtime'
$scriptPath = $MyInvocation.MyCommand.Path
$ensureScript = Join-Path $repoRoot 'scripts\ensure-app-build.mjs'
$icon = Join-Path $appRoot 'resources\littlesheep.ico'

function Get-ShortcutPaths {
  $paths = [System.Collections.Generic.List[string]]::new()
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) { $paths.Add((Join-Path $desktop 'LittleSheep.lnk')) }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  if (Test-Path $programs) { $paths.Add((Join-Path $programs 'LittleSheep.lnk')) }
  return $paths
}

function Get-LauncherTarget {
  # The shortcut has to name the same PowerShell that is running this file, so the icon keeps
  # working after a PowerShell upgrade; the hidden window keeps the console out of the way and
  # the launcher still waits for Electron, so closing the app ends the process tree.
  $target = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
  if (-not $target) { $target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
  return $target
}

function Get-LauncherArguments {
  return "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
}

function Test-SameText {
  param([string]$Left, [string]$Right)
  return [StringComparer]::OrdinalIgnoreCase.Equals([string]$Left, [string]$Right)
}

function Install-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  $target = Get-LauncherTarget
  $arguments = Get-LauncherArguments
  foreach ($path in Get-ShortcutPaths) {
    $existing = $shell.CreateShortcut($path)
    $changed = -not (Test-SameText $existing.TargetPath $target) `
      -or -not (Test-SameText $existing.Arguments $arguments) `
      -or -not (Test-SameText $existing.WorkingDirectory $appRoot) `
      -or ((Test-Path $icon) -and -not (Test-SameText $existing.IconLocation "$icon,0"))
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

function Get-NodePath {
  $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) {
    throw 'node was not found on PATH. The launcher needs Node.js to check the app build.'
  }
  return $command.Source
}

function Invoke-NodeScript {
  # Output and exit code together: the caller reports the reason from the text and decides on the
  # code, so a command that failed while printing nothing cannot pass for one that succeeded.
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $lines = @(& $script:nodePath @Arguments 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
  })
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines }
}

function Get-FingerprintDigest {
  param([string[]]$Lines, [string]$Name)
  $pattern = '"' + $Name + '":\s*"([0-9a-f]{64})"'
  foreach ($line in $Lines) {
    if ($line -match $pattern) { return $Matches[1] }
  }
  return $null
}

function Show-FailureDialog {
  param([string]$Title, [string]$Message)
  if ($NoDialog) { return }
  try {
    $shell = New-Object -ComObject WScript.Shell
    try {
      # Wait for the click on purpose: a shortcut launch has no console to read, so this box is
      # the only place the reason can be seen.
      [void]$shell.Popup($Message, 0, $Title, 16)
    } finally {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
  } catch {
    Write-Warning "The failure dialog could not be shown: $($_.Exception.Message)"
  }
}

function Stop-WithStaleBuild {
  param(
    [Parameter(Mandatory = $true)][string]$Reason,
    [string[]]$Detail = @()
  )
  $optIn = if ($script:staleOptInName) { $script:staleOptInName } else { '-AllowStaleBuild' }
  $message = [System.Collections.Generic.List[string]]::new()
  $message.Add('LittleSheep did not start: the app build on disk is not the one the sources describe,')
  $message.Add('and it could not be brought up to date.')
  $message.Add('')
  $message.Add($Reason)
  if ($Detail.Count -gt 0) {
    $message.Add('')
    foreach ($line in ($Detail | Select-Object -Last 12)) { $message.Add($line) }
  }
  $message.Add('')
  $message.Add('Nothing was started from the previous build.')
  $message.Add('Fix the reason above and launch again, or start the existing build deliberately with:')
  $message.Add("  pwsh -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" $optIn")
  $text = $message -join [Environment]::NewLine
  Write-Host $text
  if ($text.Length -gt 1500) { $text = $text.Substring(0, 1500) + '...' }
  Show-FailureDialog -Title 'LittleSheep - app build is not current' -Message $text
  exit 3
}

$nodePath = Get-NodePath
$script:staleOptInName = if ($AllowStaleBuild) { '-AllowStaleBuild' } elseif ($NoBuild) { '-NoBuild' } else { $null }

Push-Location $repoRoot
try {
  Install-Shortcuts
  if ($ShortcutsOnly) { return }

  Remove-StaleRuntimes
  if ($CleanOnly) { return }

  if ($script:staleOptInName) {
    Write-Warning "Starting the build that is already on disk without checking it ($($script:staleOptInName))."
  } else {
    Write-Host 'Checking the app build...'
    $ensure = Invoke-NodeScript @($ensureScript, '--ensure')
    foreach ($line in $ensure.Lines) { Write-Host $line }
    if ($ensure.ExitCode -ne 0) {
      Stop-WithStaleBuild `
        -Reason "Building the app failed: node scripts/ensure-app-build.mjs --ensure exited with $($ensure.ExitCode)." `
        -Detail $ensure.Lines
    }

    # Second, read-only pass. The build step above is judged by its exit code, and an exit code
    # only says the command ran; this asks the fingerprint whether the artifacts on disk really
    # are the ones the sources describe, and it is the answer that decides whether we launch.
    $verify = Invoke-NodeScript @($ensureScript, '--assert')
    if ($verify.ExitCode -ne 0) {
      Stop-WithStaleBuild `
        -Reason "The app build still does not match its sources after the build ran: node scripts/ensure-app-build.mjs --assert exited with $($verify.ExitCode)." `
        -Detail $verify.Lines
    }
    $inputDigest = Get-FingerprintDigest -Lines $verify.Lines -Name 'inputDigest'
    if ($inputDigest) {
      Write-Host "App build is current (input $inputDigest)."
    } else {
      Write-Host 'App build is current.'
    }
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
