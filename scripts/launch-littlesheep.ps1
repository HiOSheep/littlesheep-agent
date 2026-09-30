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

# LittleSheep launcher: the desktop, Start-menu and taskbar entries start this script through
# scripts/launch-littlesheep.vbs instead of the version-specific Electron binary, so upgrading
# Electron, moving the runtime directory or changing application sources never leaves the icon
# starting stale code.
#
# It does three things, in order, and each one is idempotent:
#   1. keep the desktop and Start-menu shortcuts pointing at the hidden entry (the first run
#      installs them) and repoint a taskbar pin that starts the runtime executable directly;
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
# Step 3 starts the app through CreateProcess with its output redirected, because the shell's
# "打开文件 - 安全警告" for this unsigned local binary is a prompt a hidden-window shortcut cannot
# answer, and because an app that exits during startup has to leave its reason somewhere
# readable. That reason, when there is one, is shown the same way a refusal is.
#
# It writes nothing inside the repository: the Electron runtime is prepared by
# scripts/prepare-littlesheep-runtime.mjs, the build output lives in packages/app/out, the
# running app caches under the user data root, and the app's own stdout/stderr are logged to
# %LOCALAPPDATA%\LittleSheep. Stale runtime staging directories left behind by an interrupted
# preparation are removed on the way.

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
$logDirectory = Join-Path $env:LOCALAPPDATA 'LittleSheep'
$launcherLog = Join-Path $logDirectory 'launcher.log'

function Write-LauncherLog {
  # One line per step, outside the repository. A shortcut launch has no console to read, and the
  # difference between "the click never reached this script", "the gate refused" and "the app died
  # on start" is exactly what has to survive it.
  param([string]$Message)
  try {
    $null = New-Item -ItemType Directory -Path $logDirectory -Force
    Add-Content -LiteralPath $launcherLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message)
  } catch {
    # A log that cannot be written must not stop the launch.
  }
}

function Get-ShortcutPaths {
  $paths = [System.Collections.Generic.List[string]]::new()
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) { $paths.Add((Join-Path $desktop 'LittleSheep.lnk')) }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  if (Test-Path $programs) { $paths.Add((Join-Path $programs 'LittleSheep.lnk')) }
  return $paths
}

function Get-LauncherTarget {
  # Windows Script Host owns no console, so it starts the launcher's PowerShell with a hidden
  # window. Naming PowerShell directly stopped being equivalent on machines whose default terminal
  # application is Windows Terminal: that GUI host opens a visible window for the console anyway,
  # and a launcher waiting inside it dies with the window.
  return (Join-Path $env:SystemRoot 'System32\wscript.exe')
}

function Get-LauncherArguments {
  $entry = Join-Path $PSScriptRoot 'launch-littlesheep.vbs'
  # //B keeps a script error from turning into a dialog; //Nologo drops the banner.
  return "//B //Nologo `"$entry`""
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
  Repair-TaskbarPin
}

function Repair-TaskbarPin {
  # Pinning the running window stores a link straight at
  # packages/app/runtime/electron-v*-win32-x64/LittleSheep.exe — the one entry point that skips
  # both the freshness gate and the console-free start, so Windows SmartScreen answers it with
  # "Windows 已保护你的电脑" and the click goes nowhere. Only a pin that already exists and points
  # inside this checkout's runtime is touched; every other taskbar pin is left alone.
  $pin = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\LittleSheep.lnk'
  if (-not (Test-Path -LiteralPath $pin -PathType Leaf)) { return }

  $shell = New-Object -ComObject WScript.Shell
  $existing = $null
  try {
    $existing = $shell.CreateShortcut($pin)
    $target = [string]$existing.TargetPath
    if (Test-SameText $target (Get-LauncherTarget)) {
      Write-Host "Taskbar pin already current: $pin"
      return
    }
    $runtimePrefix = Join-Path $appRoot 'runtime'
    if (-not $target -or -not $target.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Write-Host "Taskbar pin left alone (it does not start this checkout's runtime): $pin"
      return
    }
    $existing.TargetPath = Get-LauncherTarget
    $existing.Arguments = Get-LauncherArguments
    $existing.WorkingDirectory = $appRoot
    if (Test-Path $icon) { $existing.IconLocation = "$icon,0" }
    $existing.Description = 'Start LittleSheep from this checkout (always the current build)'
    $existing.Save()
    Write-Host "Taskbar pin repointed at the launcher: $pin"
    Write-Host 'Explorer may keep launching the previous target until it restarts, or until the pin is unpinned and created again.'
  } finally {
    if ($null -ne $existing) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($existing) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

function Repair-LowIntegrityLabel {
  # Agent-isolation tooling that runs against this checkout lowers the whole tree — including the
  # app's own runtime and its icon — to a Low mandatory integrity label. Two measured symptoms:
  # the app starts at Low integrity, so it can no longer write its data root or its Chromium
  # profile and Chromium's sandbox aborts it before any window exists (exit -2147483645, no
  # stderr); and the shell renders a shortcut whose IconLocation points into the repository with
  # the generic shortcut icon instead of the app's. Neither failure names the label, so the
  # launcher restores it where it breaks the app and says so.
  # A/B measured on this machine: Low label -> exit -2147483645 / generic icon; Medium -> the app
  # starts and the icon renders.
  param([Parameter(Mandatory = $true)][string[]]$Path)

  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not (Test-Path -LiteralPath $icacls)) { return }

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    foreach ($item in $Path) {
      if (-not (Test-Path -LiteralPath $item)) { continue }
      $readListing = {
        param([string]$target)
        return @(& $icacls $target 2>&1 | ForEach-Object {
          if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
        })
      }
      if (-not ((& $readListing $item) -match 'Low Mandatory Level')) { continue }

      $null = & $icacls $item /setintegritylevel Medium 2>&1
      if ((& $readListing $item) -match 'Low Mandatory Level') {
        Write-LauncherLog "Low integrity label could not be repaired on $item"
        continue
      }
      Write-LauncherLog "repaired the Low integrity label on $item"
      Write-Host "Repaired the Low integrity label on $item (Chromium aborts and the icon is lost with it)."
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
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
  Write-LauncherLog "refused: $Reason"
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

$script:staleOptInName = if ($AllowStaleBuild) { '-AllowStaleBuild' } elseif ($NoBuild) { '-NoBuild' } else { $null }

Write-LauncherLog ("start (pid {0}, shortcutsOnly={1}, cleanOnly={2}, allowStaleBuild={3})" -f $PID, [bool]$ShortcutsOnly, [bool]$CleanOnly, [bool]$script:staleOptInName)

Push-Location $repoRoot
try {
  Install-Shortcuts
  if ($ShortcutsOnly) {
    Write-LauncherLog 'shortcuts only: done'
    return
  }

  Remove-StaleRuntimes
  if ($CleanOnly) {
    Write-LauncherLog 'clean only: done'
    return
  }

  if ($script:staleOptInName) {
    Write-LauncherLog "build check skipped ($($script:staleOptInName))"
    Write-Warning "Starting the build that is already on disk without checking it ($($script:staleOptInName))."
  } else {
    # Node is resolved here rather than at the top of the script: pointing the shortcuts and
    # cleaning stale runtimes stay usable on a machine without Node.js.
    $script:nodePath = Get-NodePath
    Write-Host 'Checking the app build...'
    Write-LauncherLog "build check: node $script:nodePath"
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
      Write-LauncherLog "build check passed (input $inputDigest)"
    } else {
      Write-Host 'App build is current.'
      Write-LauncherLog 'build check passed'
    }
  }

  $runtime = Get-CurrentRuntime
  $executable = Join-Path $runtime 'LittleSheep.exe'
  if (-not (Test-Path $executable)) { throw "Runtime executable is missing: $executable" }

  Repair-LowIntegrityLabel -Path @($executable, $icon)

  # Electron runs as plain Node when this is inherited from the calling shell, and then the app
  # dies with "Cannot read properties of undefined (reading 'requestSingleInstanceLock')". The
  # launcher must not pass that on: measured here, clearing it is the difference between a dead
  # process and readiness in about four seconds.
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE }
  Write-Host "Starting LittleSheep from $runtime"

  # Start through CreateProcess, not through the shell. `Start-Process` without a redirect runs
  # ShellExecute, and on this machine the shell answers a locally built, unsigned Electron binary
  # with "打开文件 - 安全警告 / 无法验证发布者" — a prompt owned by a launcher whose window is
  # hidden, so the click reads as "nothing happened" even after Run. Redirecting the app's own
  # output keeps the same bytes on CreateProcess, and the two logs are where a startup failure
  # that never reached a window can be read instead of guessed at.
  $logDirectory = Join-Path $env:LOCALAPPDATA 'LittleSheep'
  $null = New-Item -ItemType Directory -Path $logDirectory -Force
  $outputLog = Join-Path $logDirectory 'launch-output.log'
  $errorLog = Join-Path $logDirectory 'launch-error.log'
  $startedAt = Get-Date
  Write-LauncherLog "starting app: $executable"
  try {
    $process = Start-Process -FilePath $executable -ArgumentList '.' -WorkingDirectory $appRoot -PassThru `
      -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog
  } catch {
    Write-LauncherLog "app could not be started: $($_.Exception.Message)"
    throw
  }
  Write-LauncherLog "app started (pid $($process.Id))"
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $lifetime = (Get-Date) - $startedAt
  Write-LauncherLog ("app exited (code {0}, after {1:N1}s)" -f $exitCode, $lifetime.TotalSeconds)

  if ($exitCode -ne 0 -or $lifetime.TotalSeconds -lt 3) {
    $detail = [System.Collections.Generic.List[string]]::new()
    foreach ($log in @($errorLog, $outputLog)) {
      if (Test-Path -LiteralPath $log) {
        foreach ($line in (Get-Content -LiteralPath $log -Tail 12 -ErrorAction SilentlyContinue)) {
          if (-not [string]::IsNullOrWhiteSpace($line)) { $detail.Add($line) }
        }
      }
    }
    $headline = if ($exitCode -ne 0) {
      "LittleSheep exited with code $exitCode while starting up."
    } else {
      'LittleSheep exited immediately without opening a window. If one is already running, this launch handed off to it; otherwise the logs below say why.'
    }
    $message = [System.Collections.Generic.List[string]]::new()
    $message.Add('LittleSheep did not open.')
    $message.Add('')
    $message.Add($headline)
    if ($detail.Count -gt 0) {
      $message.Add('')
      foreach ($line in $detail) { $message.Add($line) }
    }
    $message.Add('')
    $message.Add("Logs: $outputLog")
    $message.Add("      $errorLog")
    $text = $message -join [Environment]::NewLine
    Write-Host $text
    Write-LauncherLog "app did not open: $headline"
    if ($detail.Count -gt 0) { Write-LauncherLog ("app output: " + ($detail -join ' | ')) }
    if ($text.Length -gt 1500) { $text = $text.Substring(0, 1500) + '...' }
    Show-FailureDialog -Title 'LittleSheep - the app did not open' -Message $text
    exit 5
  }
  Write-LauncherLog 'app window session ended normally'
} catch {
  # Every other refusal gets the same treatment as a stale build: a shortcut launch has no console,
  # so a thrown error would be silent exactly where it matters most.
  $reason = $_.Exception.Message
  Write-LauncherLog "launch failed: $reason"
  Write-Host "LittleSheep did not start: $reason"
  Show-FailureDialog -Title 'LittleSheep - launch failed' -Message "LittleSheep did not start:`n`n$reason"
  exit 4
} finally {
  Pop-Location
}
