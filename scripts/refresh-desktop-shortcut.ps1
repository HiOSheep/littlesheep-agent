[CmdletBinding()]
param(
  [string]$ShortcutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appDirectory = Join-Path $repoRoot 'packages\app'

Push-Location $appDirectory
try {
  $electronPath = (& node -e "process.stdout.write(require('electron'))").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $electronPath) {
    throw 'Unable to resolve electron.exe from @littlesheep/app.'
  }
} finally {
  Pop-Location
}

if (-not [System.IO.Path]::IsPathRooted($electronPath)) {
  $electronPath = (Resolve-Path (Join-Path $appDirectory $electronPath)).Path
}
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw "electron.exe was not found at $electronPath"
}

if (-not $ShortcutPath) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $ShortcutPath = Join-Path $desktop 'LittleSheep.lnk'
}

$shell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $electronPath
  $shortcut.Arguments = '.'
  $shortcut.WorkingDirectory = $appDirectory
  $shortcut.IconLocation = "$electronPath,0"
  $shortcut.Description = 'LittleSheep Agent Desktop App'
  $shortcut.Save()
} finally {
  if ($null -ne $shell) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

Write-Host "Desktop shortcut refreshed: $ShortcutPath"
Write-Host "Target: $electronPath"
Write-Host "Working directory: $appDirectory"
