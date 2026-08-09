[CmdletBinding()]
param(
  [string]$ShortcutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appDirectory = Join-Path $repoRoot 'packages\app'
$iconPath = Join-Path $appDirectory 'resources\littlesheep.ico'
$mainBundlePath = Join-Path $appDirectory 'out\main\index.js'
$preloadBundlePath = Join-Path $appDirectory 'out\preload\index.js'
$rendererEntryPath = Join-Path $appDirectory 'out\renderer\index.html'

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "LittleSheep icon was not found at $iconPath"
}
foreach ($buildArtifact in @($mainBundlePath, $preloadBundlePath, $rendererEntryPath)) {
  if (-not (Test-Path -LiteralPath $buildArtifact -PathType Leaf)) {
    throw "LittleSheep build artifact was not found at $buildArtifact. Run the app build first."
  }
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

if (-not $ShortcutPath) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $ShortcutPath = Join-Path $desktop 'LittleSheep.lnk'
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $runtimePath
  $shortcut.Arguments = '.'
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
