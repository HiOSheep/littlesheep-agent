[CmdletBinding()]
param(
  [string]$ShortcutPath,
  # Re-save the link even when TargetPath, Arguments, WorkingDirectory and
  # IconLocation already match. Skipping that write is the default because
  # re-saving an existing .lnk discards the state Explorer keeps beside the file
  # (pin state, icon position), so an "unchanged" refresh is not free.
  [switch]$Force,
  # Best-effort mode for the pnpm lifecycle (`predev` / `prebuild`). There,
  # "the app has not been built yet" and "this desktop has no shortcut" are
  # states rather than errors, so they report a reason and exit 0. A genuine
  # failure (missing icon, broken runtime, unwritable link) still throws.
  [switch]$IfPresent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appDirectory = Join-Path $repoRoot 'packages\app'
$iconPath = Join-Path $appDirectory 'resources\littlesheep.ico'
$mainBundlePath = Join-Path $appDirectory 'out\main\index.js'
$preloadBundlePath = Join-Path $appDirectory 'out\preload\index.js'
$rendererEntryPath = Join-Path $appDirectory 'out\renderer\index.html'

if (-not $ShortcutPath) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $ShortcutPath = Join-Path $desktop 'LittleSheep.lnk'
}

# Resolve the link first. In best-effort mode this is the cheapest possible exit:
# a desktop with no shortcut needs neither a prepared runtime nor a build.
if ($IfPresent -and -not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
  Write-Host "Desktop shortcut left alone: no shortcut at $ShortcutPath."
  Write-Host 'Run pnpm run refresh:desktop-shortcut to create it.'
  return
}

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "LittleSheep icon was not found at $iconPath"
}
$missingArtifacts = @()
foreach ($buildArtifact in @($mainBundlePath, $preloadBundlePath, $rendererEntryPath)) {
  if (-not (Test-Path -LiteralPath $buildArtifact -PathType Leaf)) {
    $missingArtifacts += $buildArtifact
  }
}
if ($missingArtifacts.Count -gt 0) {
  if ($IfPresent) {
    Write-Host 'Desktop shortcut left alone: the app build is not ready yet.'
    Write-Host "Missing: $($missingArtifacts -join ', ')"
    return
  }
  throw "LittleSheep build artifact was not found at $($missingArtifacts[0]). Run the app build first."
}

Push-Location $appDirectory
try {
  $runtimePath = (& node (Join-Path $PSScriptRoot 'prepare-littlesheep-runtime.mjs')).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $runtimePath) {
    throw 'Unable to prepare LittleSheep.exe from @littlesheep/app.'
  }
} finally {
  Pop-Location
}

if (-not [System.IO.Path]::IsPathRooted($runtimePath)) {
  $runtimePath = (Resolve-Path (Join-Path $appDirectory $runtimePath)).Path
}
if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
  throw "LittleSheep.exe was not found at $runtimePath"
}
$runtimePath = (Resolve-Path -LiteralPath $runtimePath).Path
$appDirectory = (Resolve-Path -LiteralPath $appDirectory).Path
$iconPath = (Resolve-Path -LiteralPath $iconPath).Path

$expectedArguments = '.'

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
      [StringComparer]::OrdinalIgnoreCase.Equals([string]$existing.TargetPath, $runtimePath) -and
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
    Write-Host "Target: $runtimePath"
    Write-Host "Working directory: $appDirectory"
    Write-Host "Icon: $iconPath"
    return
  }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $runtimePath
  $shortcut.Arguments = $expectedArguments
  $shortcut.WorkingDirectory = $appDirectory
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = 'LittleSheep Agent Desktop App'
  $shortcut.Save()

  # Read the saved link back before reporting success. This catches COM or
  # path-normalization failures that would otherwise leave a dead shortcut.
  $saved = $null
  $saved = $shell.CreateShortcut($ShortcutPath)
  try {
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($saved.TargetPath, $runtimePath)) {
      throw "Shortcut target verification failed: expected $runtimePath, got $($saved.TargetPath)"
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
Write-Host "Target: $runtimePath"
Write-Host "Working directory: $appDirectory"
Write-Host "Icon: $iconPath"
