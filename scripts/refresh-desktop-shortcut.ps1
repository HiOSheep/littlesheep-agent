[CmdletBinding()]
param(
  [string]$ShortcutPath,
  # Re-save the link even when TargetPath, Arguments, WorkingDirectory and
  # IconLocation already match. Skipping that write is the default because
  # re-saving an existing .lnk discards the state Explorer keeps beside the file
  # (pin state, icon position), so an "unchanged" refresh is not free.
  [switch]$Force,
  # Best-effort mode for the pnpm lifecycle (`predev` / `prebuild`). There,
  # "this desktop has no shortcut" is a state rather than an error, so it
  # reports a reason and exits 0. A genuine failure (missing icon, unwritable
  # link, unreadable PowerShell) still throws.
  [switch]$IfPresent
)

# Keep the desktop shortcut on the launcher.
#
# The link target is `scripts/launch-littlesheep.ps1`, NOT the version-specific
# `packages/app/runtime/electron-v<version>-<platform>-<arch>/LittleSheep.exe`. Both fix the
# original reason this script exists — an Electron upgrade used to leave the icon starting the
# previous Chromium, whose silent fallbacks (no `corner-shape` in Chromium 136, for instance)
# looked like a change that did not take effect. The launcher fixes that better: it resolves the
# newest prepared runtime at every click.
#
# What a link straight at LittleSheep.exe cannot do is ask whether the build in
# `packages/app/out` is the one the sources describe — it just starts those bytes. That is the
# other half of the same symptom: after a build that did not actually happen, the icon quietly
# started the previous bundle and the UI change "did not work" after a restart. Only the launcher
# carries the fail-closed freshness gate, so the link has to go through it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..\packages\app')).Path
$iconPath = Join-Path $appDirectory 'resources\littlesheep.ico'
$launcherPath = Join-Path $PSScriptRoot 'launch-littlesheep.ps1'

if (-not $ShortcutPath) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $ShortcutPath = Join-Path $desktop 'LittleSheep.lnk'
}

# Resolve the link first. In best-effort mode this is the cheapest possible exit:
# a desktop with no shortcut needs nothing else.
if ($IfPresent -and -not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
  Write-Host "Desktop shortcut left alone: no shortcut at $ShortcutPath."
  Write-Host 'Run pnpm run refresh:desktop-shortcut to create it.'
  return
}

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "LittleSheep icon was not found at $iconPath"
}
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  throw "LittleSheep launcher was not found at $launcherPath"
}

# A hidden PowerShell keeps the console window out of the way; the launcher still waits for
# Electron, so closing the app ends the process tree. The two strings below are the same shape
# `scripts/launch-littlesheep.ps1` installs for itself, and that script re-asserts them on every
# launch, so a drift between the two writers is corrected rather than left behind.
#
# `scripts/lib/desktop-shortcut.mjs` runs this file through `powershell.exe`, i.e. Windows
# PowerShell 5.1, so the syntax here has to stay 5.1-compatible (no `?.`).
$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$expectedTarget = if ($pwshCommand) { $pwshCommand.Source } else { $null }
if (-not $expectedTarget) {
  $expectedTarget = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}
$expectedArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""

$iconPath = (Resolve-Path -LiteralPath $iconPath).Path
$appDirectory = (Resolve-Path -LiteralPath $appDirectory).Path

if (-not $Force) {
  # Compare before writing. Those four properties fully describe the link, so a
  # match means a re-save could only disturb state kept outside the file.
  $currentIsSufficient = $false
  $probe = $null
  $existing = $null
  try {
    $probe = New-Object -ComObject WScript.Shell
    $existing = $probe.CreateShortcut($ShortcutPath)
    $currentIcon = [string]$existing.IconLocation
    $iconSeparator = $currentIcon.LastIndexOf(',')
    $currentIconPath = if ($iconSeparator -ge 0) {
      $currentIcon.Substring(0, $iconSeparator).Trim('"')
    } else {
      $currentIcon.Trim('"')
    }
    if (
      [StringComparer]::OrdinalIgnoreCase.Equals([string]$existing.TargetPath, $expectedTarget) -and
      [StringComparer]::OrdinalIgnoreCase.Equals([string]$existing.Arguments, $expectedArguments) -and
      [StringComparer]::OrdinalIgnoreCase.Equals([string]$existing.WorkingDirectory, $appDirectory) -and
      [StringComparer]::OrdinalIgnoreCase.Equals($currentIconPath, $iconPath)
    ) {
      $currentIsSufficient = $true
    }
  } catch {
    # An unreadable link is a reason to rewrite it, never a reason to skip.
    $currentIsSufficient = $false
  } finally {
    if ($null -ne $existing) {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($existing)
    }
    if ($null -ne $probe) {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($probe)
    }
  }
  if ($currentIsSufficient) {
    Write-Host "Desktop shortcut already current: $ShortcutPath"
    Write-Host "Target: $expectedTarget"
    Write-Host "Arguments: $expectedArguments"
    Write-Host "Working directory: $appDirectory"
    Write-Host "Icon: $iconPath"
    return
  }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $expectedTarget
  $shortcut.Arguments = $expectedArguments
  $shortcut.WorkingDirectory = $appDirectory
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = 'Start LittleSheep from this checkout (always the current build)'
  $shortcut.Save()

  # Read the saved link back before reporting success. This catches COM or
  # path-normalization failures that would otherwise leave a dead shortcut.
  $saved = $null
  $saved = $shell.CreateShortcut($ShortcutPath)
  try {
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($saved.TargetPath, $expectedTarget)) {
      throw "Shortcut target verification failed: expected $expectedTarget, got $($saved.TargetPath)"
    }
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$saved.Arguments, $expectedArguments)) {
      throw "Shortcut argument verification failed: expected $expectedArguments, got $($saved.Arguments)"
    }
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($saved.WorkingDirectory, $appDirectory)) {
      throw "Shortcut working-directory verification failed: expected $appDirectory, got $($saved.WorkingDirectory)"
    }
    $iconLocation = [string]$saved.IconLocation
    $separator = $iconLocation.LastIndexOf(',')
    $savedIconPath = if ($separator -ge 0) {
      $iconLocation.Substring(0, $separator).Trim('"')
    } else {
      $iconLocation.Trim('"')
    }
    if (-not (Test-Path -LiteralPath $savedIconPath -PathType Leaf)) {
      throw "Shortcut icon verification failed: $($saved.IconLocation)"
    }
  } finally {
    if ($null -ne $saved) {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($saved)
    }
  }
} finally {
  if ($null -ne $shortcut) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  }
  if ($null -ne $shell) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

Write-Host "Desktop shortcut refreshed: $ShortcutPath"
Write-Host "Target: $expectedTarget"
Write-Host "Arguments: $expectedArguments"
Write-Host "Working directory: $appDirectory"
Write-Host "Icon: $iconPath"
