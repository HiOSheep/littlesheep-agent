[CmdletBinding()]
param(
  [string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This proof of concept only runs on Windows.' }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$helperPath = Join-Path $PSScriptRoot 'SnapshotHandleNative.cs'
Add-Type -Path $helperPath -ErrorAction Stop
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$nodeRoot = Split-Path -Parent $nodeExe
$powershellRoot = Split-Path -Parent $powershellExe
$windowsSystem = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
$gitExe = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
$gitRoot = if ($gitExe) { Split-Path -Parent (Split-Path -Parent $gitExe) } else { $null }
$runnerScript = Join-Path $PSScriptRoot 'Run-SandboxProcess.ps1'
$builderScript = Join-Path $PSScriptRoot 'build-sandbox-spec.mjs'

if (-not $EvidenceDirectory) {
  $EvidenceDirectory = Join-Path $env:TEMP ('ls-windows-handle-snapshot-poc-' + [Guid]::NewGuid().ToString('N'))
}
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $evidenceRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'EvidenceDirectory must remain below the current user TEMP directory.'
}
if (Test-Path -LiteralPath $evidenceRoot) { throw "EvidenceDirectory already exists: $evidenceRoot" }
$null = New-Item -ItemType Directory -Path $evidenceRoot

$controlRoot = Join-Path $evidenceRoot 'control'
$fixturesRoot = Join-Path $evidenceRoot 'fixtures'
$outsideRoot = Join-Path $fixturesRoot 'outside'
$projectRoot = Join-Path $fixturesRoot 'representative-project'
$storeRoot = Join-Path $fixturesRoot 'pnpm-content-store'
$snapshotParent = Join-Path $evidenceRoot 'snapshots'
$snapshotRoot = Join-Path $snapshotParent 'materialized-project'
$raceSource = Join-Path $fixturesRoot 'race-source'
$raceSnapshot = Join-Path $snapshotParent 'race-snapshot'
$runtimeSource = Join-Path $fixturesRoot 'runtime-source'
$runtimeSnapshot = Join-Path $snapshotParent 'runtime-snapshot'
$unsupportedRoot = Join-Path $fixturesRoot 'unsupported-objects'
$adsRoot = Join-Path $fixturesRoot 'ads-source'
$null = New-Item -ItemType Directory -Path @($controlRoot, $outsideRoot, $projectRoot, $storeRoot, $snapshotParent, $raceSource, $runtimeSource, $unsupportedRoot, $adsRoot)

function Write-FixtureText([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent }
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function New-Junction([string]$LinkPath, [string]$TargetPath) {
  $commandLine = 'mklink /J "{0}" "{1}"' -f $LinkPath, $TargetPath
  $output = @(& $env:ComSpec /d /c $commandLine 2>&1)
  return [pscustomobject]@{ Created = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $LinkPath)); Output = ($output -join ' ') }
}

function New-SandboxSpecification([string]$Workspace, [string]$Name) {
  $specificationPath = Join-Path $controlRoot ($Name + '.spec.bin')
  $readOnlyRoots = @($nodeRoot, $powershellRoot, $windowsSystem)
  if ($gitRoot) { $readOnlyRoots += $gitRoot }
  $builderArguments = @($builderScript, '--out', $specificationPath, '--workspace', $Workspace)
  foreach ($path in ($readOnlyRoots | Sort-Object -Unique)) { $builderArguments += @('--read-only', $path) }
  Push-Location $repoRoot
  try {
    & $nodeExe @builderArguments | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $specificationPath)) {
      throw "Sandbox specification build failed for $Name."
    }
  }
  finally { Pop-Location }
  return $specificationPath
}

function Invoke-Sandbox([string]$Name, [string]$Workspace, [string]$Specification, [string]$Executable, [string[]]$Arguments, [int]$TimeoutMilliseconds = 20000) {
  $identity = 'LSHandleSnapshotPoc_' + [Guid]::NewGuid().ToString('N')
  $requestPath = Join-Path $controlRoot ($Name + '.request.json')
  $launchPath = Join-Path $controlRoot ($Name + '.launch.json')
  $resultPath = Join-Path $controlRoot ($Name + '.result.json')
  $errorPath = Join-Path $controlRoot ($Name + '.error.json')
  $stdoutPath = Join-Path $controlRoot ($Name + '.stdout.log')
  $stderrPath = Join-Path $controlRoot ($Name + '.stderr.log')
  $request = [ordered]@{
    action = 'run'
    workspace = $Workspace
    currentDirectory = $Workspace
    executable = $Executable
    arguments = @($Arguments)
    identity = $identity
    specificationPath = $Specification
    launchMarkerPath = $launchPath
    resultPath = $resultPath
    errorPath = $errorPath
    pathValue = @($nodeRoot, $powershellRoot, $windowsSystem) -join ';'
    modulePathValue = Join-Path $powershellRoot 'Modules'
    timeoutMilliseconds = $TimeoutMilliseconds
  }
  if ($gitExe) {
    $gitBinRoot = Split-Path -Parent (Split-Path -Parent $gitExe)
    $request.pathValue = @($nodeRoot, (Join-Path $gitBinRoot 'cmd'), (Join-Path $gitBinRoot 'mingw64\bin'), $powershellRoot, $windowsSystem) -join ';'
  }
  [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 5))
  $quotedRunner = '"{0}"' -f $runnerScript
  $quotedRequest = '"{0}"' -f $requestPath
  $argumentLine = "-NoProfile -ExecutionPolicy Bypass -File $quotedRunner -RequestPath $quotedRequest"
  $worker = Start-Process -FilePath $powershellExe -ArgumentList $argumentLine -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $processResult = $null
  $processError = $null
  if (Test-Path -LiteralPath $resultPath) { $processResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json }
  if (Test-Path -LiteralPath $errorPath) { $processError = Get-Content -LiteralPath $errorPath -Raw | ConvertFrom-Json }
  return [pscustomobject]@{
    WorkerExitCode = $worker.ExitCode
    PayloadExitCode = if ($processResult) { $processResult.exitCode } else { $null }
    PayloadStarted = Test-Path -LiteralPath $launchPath
    Error = if ($processError) { [string]$processError.error } else { $null }
    Stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
    Stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    ProcessResult = $processResult
  }
}

$report = [ordered]@{
  generatedAt = [DateTime]::UtcNow.ToString('o')
  backendId = 'windows-handle-snapshot-poc'
  productionIntegration = $false
  threatModel = [ordered]@{
    primary = 'Malicious Agent command; Main, OS, and snapshot builder are trusted.'
    sameUserHostProcess = 'Probed separately; not claimed contained.'
  }
  host = [ordered]@{
    os = (Get-CimInstance Win32_OperatingSystem).Caption
    build = [Environment]::OSVersion.Version.Build
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    nodeVersion = [string](& $nodeExe --version)
    gitVersion = if ($gitExe) { [string](& $gitExe --version) } else { 'unavailable' }
  }
  scope = [ordered]@{ platform = 'win32'; runId = [Guid]::NewGuid().ToString('N'); evidenceRoot = $evidenceRoot; workspaceRoot = $snapshotRoot }
  evidence = [ordered]@{
    handleCopy = $null
    sourceFileReplacementRace = $null
    sourceDirectorySwap = $null
    runtimeSnapshotMutation = $null
    specialObjects = $null
    actualProjectCompatibility = $null
  }
}

try {
  # A small pnpm-shaped project keeps .git and node_modules files in the logical
  # workspace while the content store file itself lives outside the workspace.
  Write-FixtureText (Join-Path $projectRoot '.git\HEAD') 'ref: refs/heads/main'
  Write-FixtureText (Join-Path $projectRoot '.git\config') "[core]`n`trepositoryformatversion = 0`n"
  Write-FixtureText (Join-Path $projectRoot 'package.json') '{"name":"p3-a4-fixture","dependencies":{"demo":"1.0.0"}}'
  Write-FixtureText (Join-Path $projectRoot 'pnpm-lock.yaml') "lockfileVersion: '9.0'`n"
  $storeFile = Join-Path $storeRoot 'files\demo\index.js'
  $projectPackageFile = Join-Path $projectRoot 'node_modules\.pnpm\demo@1.0.0\node_modules\demo\index.js'
  Write-FixtureText $storeFile 'module.exports = "from-content-store";'
  $null = New-Item -ItemType Directory -Path (Split-Path -Parent $projectPackageFile) -Force
  if (-not [LsHandleSnapshotNative]::CreateHardLinkW($projectPackageFile, $storeFile, [IntPtr]::Zero)) {
    throw ('Could not create pnpm-style hardlink fixture: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }

  $copySummary = [LsHandleSnapshotNative]::Copy($projectRoot, $snapshotRoot, $null, $null, $null)
  $snapshotPackageFile = Join-Path $snapshotRoot 'node_modules\.pnpm\demo@1.0.0\node_modules\demo\index.js'
  $snapshotBytesBeforeMutation = [IO.File]::ReadAllText($snapshotPackageFile)
  [IO.File]::WriteAllText($snapshotPackageFile, 'changed-inside-independent-snapshot')
  $report.evidence.handleCopy = [ordered]@{
    fileSystem = $copySummary.FileSystem
    promotedAtomically = $copySummary.Promoted
    entryCount = $copySummary.EntryCount
    fileCount = $copySummary.FileCount
    directoryCount = $copySummary.DirectoryCount
    sourceLogicalBytes = $copySummary.LogicalBytes
    copiedBytes = $copySummary.CopiedBytes
    sourceAllocatedBytes = $copySummary.SourceAllocatedBytes
    snapshotAllocatedBytes = $copySummary.DestinationAllocatedBytes
    elapsedMilliseconds = $copySummary.ElapsedMilliseconds
    hardLinkedFilesMaterialized = $copySummary.MaterializedHardlinks
    fileObjectMappings = $copySummary.CopiedFileObjects
    snapshotContentBeforeMutation = $snapshotBytesBeforeMutation
    sourceStoreUnchangedAfterSnapshotEdit = [IO.File]::ReadAllText($storeFile) -eq 'module.exports = "from-content-store";'
    projectHardlinkStillHasTwoNames = (([LsHandleSnapshotNative]::Analyze($projectRoot)).HardLinkedFileCount -gt 0)
    allDestinationObjectsIndependent = @($copySummary.UnsupportedObjects).Count -eq 0 -and $copySummary.Promoted
  }

  # ADS and reparse points are handled as explicit rejected object classes.
  $adsFile = Join-Path $adsRoot 'plain.txt'
  Write-FixtureText $adsFile 'ordinary stream'
  [LsHandleSnapshotNative]::WriteNamedStreamFixture($adsFile, 'ls-a4', 'named stream sentinel')
  $adsResult = [LsHandleSnapshotNative]::Copy($adsRoot, (Join-Path $snapshotParent 'should-reject-ads'), $null, $null, $null)

  $reparseTarget = Join-Path $outsideRoot 'reparse-target'
  $null = New-Item -ItemType Directory -Path $reparseTarget
  Write-FixtureText (Join-Path $reparseTarget 'outside.txt') 'external reparse target'
  $symbolicLinkTarget = Join-Path $outsideRoot 'outside-symlink-target.txt'
  Write-FixtureText $symbolicLinkTarget 'external symbolic-link target'
  $symbolicLinkPath = Join-Path $unsupportedRoot 'symbolic-file'
  $junctionPath = Join-Path $unsupportedRoot 'junction-directory'
  $symbolicLinkCreated = [LsHandleSnapshotNative]::CreateSymbolicLinkW($symbolicLinkPath, $symbolicLinkTarget, 2)
  $symbolicLinkCreateError = if ($symbolicLinkCreated) { $null } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  if ($symbolicLinkCreated -and -not (Test-Path -LiteralPath $symbolicLinkPath)) {
    $symbolicLinkCreated = $false
    $symbolicLinkCreateError = 'reported-success-but-link-path-missing'
  }
  $junctionResult = New-Junction $junctionPath $reparseTarget
  $unsupportedCopy = [LsHandleSnapshotNative]::Copy($unsupportedRoot, (Join-Path $snapshotParent 'should-reject-reparse'), $null, $null, $null)
  $report.evidence.specialObjects = [ordered]@{
    adsFixtureCreated = $true
    namedStreamRejected = -not $adsResult.Promoted -and @($adsResult.UnsupportedObjects | Where-Object { $_ -like 'named-stream:*' }).Count -gt 0
    adsUnsupported = $adsResult.UnsupportedObjects
    symbolicLinkCreated = $symbolicLinkCreated
    symbolicLinkCreateError = $symbolicLinkCreateError
    junctionCreated = $junctionResult.Created
    reparseCopyPromoted = $unsupportedCopy.Promoted
    reparsePointCount = $unsupportedCopy.ReparsePointCount
    reparseUnsupported = $unsupportedCopy.UnsupportedObjects
    allReparseTagsRejected = $unsupportedCopy.ReparsePointCount -eq @($unsupportedCopy.UnsupportedObjects | Where-Object { $_ -like 'reparse:*' }).Count
    unknownReparseTags = 'not-created; policy rejects every observed reparse attribute before following it'
    unsupportedFileSystems = 'not-tested; implementation rejects non-fixed and non-NTFS volumes before traversal'
  }

  # Replace an enumerated regular file with an outside hardlink before its
  # relative open. The file ID check must reject the changed object and clean
  # the staging directory before any bytes are read or promoted.
  $fileSwapSource = Join-Path $fixturesRoot 'file-swap-source'
  $null = New-Item -ItemType Directory -Path $fileSwapSource
  Write-FixtureText (Join-Path $fileSwapSource 'data.txt') 'authorized-file-before-race'
  $fileSwapSecret = Join-Path $outsideRoot 'file-swap-secret.txt'
  Write-FixtureText $fileSwapSecret 'external-file-secret'
  $fileSwapReady = Join-Path $controlRoot 'file-swap-ready'
  $fileSwapRelease = Join-Path $controlRoot 'file-swap-release.json'
  $fileSwapAttackerScript = Join-Path $controlRoot 'replace-source-file.ps1'
  @'
param([string]$SourceRoot, [string]$OutsideFile, [string]$ReadyPath, [string]$ReleasePath, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not (Test-Path -LiteralPath $ReadyPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
$result = [ordered]@{ readyObserved = Test-Path -LiteralPath $ReadyPath; oldFileRenamed = $false; outsideHardlinkInstalled = $false; error = $null }
try {
  if (-not $result.readyObserved) { throw 'copier did not pause after enumerating the source file' }
  Move-Item -LiteralPath (Join-Path $SourceRoot 'data.txt') -Destination (Join-Path $SourceRoot 'data-original.txt') -ErrorAction Stop
  $commandLine = 'mklink /H "{0}" "{1}"' -f (Join-Path $SourceRoot 'data.txt'), $OutsideFile
  $null = @(& $env:ComSpec /d /c $commandLine 2>&1)
  $result.oldFileRenamed = $true
  $result.outsideHardlinkInstalled = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $SourceRoot 'data.txt')))
} catch { $result.error = $_.Exception.Message }
[IO.File]::WriteAllText($ReportPath, ($result | ConvertTo-Json -Depth 4))
[IO.File]::WriteAllText($ReleasePath, ($result | ConvertTo-Json -Depth 4))
'@ | Set-Content -LiteralPath $fileSwapAttackerScript -Encoding UTF8
  $fileSwapReportPath = Join-Path $controlRoot 'file-swap-report.json'
  $fileSwapSnapshot = Join-Path $snapshotParent 'file-swap-snapshot'
  $fileSwapAttackerArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -SourceRoot "{1}" -OutsideFile "{2}" -ReadyPath "{3}" -ReleasePath "{4}" -ReportPath "{5}"' -f $fileSwapAttackerScript, $fileSwapSource, $fileSwapSecret, $fileSwapReady, $fileSwapRelease, $fileSwapReportPath
  $fileSwapAttacker = Start-Process -FilePath $powershellExe -ArgumentList $fileSwapAttackerArgs -PassThru -WindowStyle Hidden
  $fileSwapCopyError = $null
  try { $null = [LsHandleSnapshotNative]::CopyWithEntryPause($fileSwapSource, $fileSwapSnapshot, 'data.txt', $fileSwapReady, $fileSwapRelease) }
  catch { $fileSwapCopyError = $_.Exception.GetBaseException().Message }
  $fileSwapAttacker.WaitForExit(25000) | Out-Null
  $fileSwapHostResult = if (Test-Path -LiteralPath $fileSwapReportPath) { Get-Content -LiteralPath $fileSwapReportPath -Raw | ConvertFrom-Json } else { $null }
  $leftoverStages = @(Get-ChildItem -LiteralPath $snapshotParent -Directory -Filter '.handle-snapshot-stage-*' -ErrorAction SilentlyContinue)
  $report.evidence.sourceFileReplacementRace = [ordered]@{
    independentHostProcess = $true
    attackerProcessExitCode = $fileSwapAttacker.ExitCode
    attack = $fileSwapHostResult
    copierError = $fileSwapCopyError
    copierDetectedIdentityChange = ($fileSwapCopyError -like 'Entry identity changed between handle enumeration and relative open:*')
    destinationPromoted = Test-Path -LiteralPath $fileSwapSnapshot
    stagingDirectoriesLeft = $leftoverStages.Count
    externalSecretContentAfterRun = [IO.File]::ReadAllText($fileSwapSecret)
    externalSecretUnchanged = [IO.File]::ReadAllText($fileSwapSecret) -eq 'external-file-secret'
  }

  # Pause while the original nested source directory handle is open. A separate
  # PowerShell process renames that directory and inserts an outside junction.
  $null = New-Item -ItemType Directory -Path (Join-Path $raceSource 'nested')
  Write-FixtureText (Join-Path $raceSource 'nested\inside.txt') 'read-from-held-original-directory'
  Write-FixtureText (Join-Path $outsideRoot 'outside-secret.txt') 'outside-secret-do-not-copy'
  $raceReady = Join-Path $controlRoot 'source-race-ready'
  $raceRelease = Join-Path $controlRoot 'source-race-release.json'
  $raceAttackerScript = Join-Path $controlRoot 'replace-source-directory.ps1'
  @'
param([string]$SourceRoot, [string]$OutsideRoot, [string]$ReadyPath, [string]$ReleasePath, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not (Test-Path -LiteralPath $ReadyPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
$result = [ordered]@{ readyObserved = Test-Path -LiteralPath $ReadyPath; renameSucceeded = $false; junctionCreated = $false; error = $null }
try {
  if (-not $result.readyObserved) { throw 'snapshot copier did not pause after opening nested directory' }
  Move-Item -LiteralPath (Join-Path $SourceRoot 'nested') -Destination (Join-Path $SourceRoot 'nested-original') -ErrorAction Stop
  $commandLine = 'mklink /J "{0}" "{1}"' -f (Join-Path $SourceRoot 'nested'), $OutsideRoot
  $null = @(& $env:ComSpec /d /c $commandLine 2>&1)
  $result.renameSucceeded = $true
  $result.junctionCreated = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $SourceRoot 'nested')))
} catch { $result.error = $_.Exception.Message }
[IO.File]::WriteAllText($ReportPath, ($result | ConvertTo-Json -Depth 4))
[IO.File]::WriteAllText($ReleasePath, ($result | ConvertTo-Json -Depth 4))
'@ | Set-Content -LiteralPath $raceAttackerScript -Encoding UTF8
  $raceAttackerArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -SourceRoot "{1}" -OutsideRoot "{2}" -ReadyPath "{3}" -ReleasePath "{4}" -ReportPath "{5}"' -f $raceAttackerScript, $raceSource, $reparseTarget, $raceReady, $raceRelease, (Join-Path $controlRoot 'source-race-report.json')
  $raceAttacker = Start-Process -FilePath $powershellExe -ArgumentList $raceAttackerArgs -PassThru -WindowStyle Hidden
  $raceResult = [LsHandleSnapshotNative]::Copy($raceSource, $raceSnapshot, 'nested', $raceReady, $raceRelease)
  $raceAttacker.WaitForExit(25000) | Out-Null
  $raceHostResult = if (Test-Path -LiteralPath (Join-Path $controlRoot 'source-race-report.json')) {
    Get-Content -LiteralPath (Join-Path $controlRoot 'source-race-report.json') -Raw | ConvertFrom-Json
  } else { $null }
  $report.evidence.sourceDirectorySwap = [ordered]@{
    copierUsedHeldDirectoryHandle = $raceResult.SourceDirectorySwapWasAttempted
    independentHostProcess = $true
    attackerProcessExitCode = $raceAttacker.ExitCode
    attack = $raceHostResult
    snapshotPromoted = $raceResult.Promoted
    copiedOriginalObjectContent = (Test-Path -LiteralPath (Join-Path $raceSnapshot 'nested\inside.txt')) -and [IO.File]::ReadAllText((Join-Path $raceSnapshot 'nested\inside.txt')) -eq 'read-from-held-original-directory'
    outsideSecretCopied = Test-Path -LiteralPath (Join-Path $raceSnapshot 'nested\outside-secret.txt')
    unsupportedRaceState = $raceResult.UnsupportedObjects
    elapsedMilliseconds = $raceResult.ElapsedMilliseconds
  }

  # Create a clean runtime snapshot, then mutate its nested directory while the
  # existing experimental AppContainer launcher is executing a payload.
  $null = New-Item -ItemType Directory -Path (Join-Path $runtimeSource 'nested')
  Write-FixtureText (Join-Path $runtimeSource 'nested\workspace-file.txt') 'snapshot-original'
  Write-FixtureText (Join-Path $runtimeSource 'top-level.txt') 'initial-host-visible-value'
  $runtimeCopy = [LsHandleSnapshotNative]::Copy($runtimeSource, $runtimeSnapshot, $null, $null, $null)
  $runtimeOutside = Join-Path $outsideRoot 'runtime-external'
  $null = New-Item -ItemType Directory -Path $runtimeOutside
  Write-FixtureText (Join-Path $runtimeOutside 'outside-sentinel.txt') 'runtime-outside-original'
  $readyMarker = Join-Path $runtimeSnapshot '_host-mutation-ready.txt'
  $releaseMarker = Join-Path $runtimeSnapshot '_host-mutation-release.txt'
  $payloadResultPath = Join-Path $runtimeSnapshot '_payload-result.json'
  $runtimePayloadPath = Join-Path $runtimeSnapshot 'runtime-mutation-probe.ps1'
  @'
param([string]$Workspace)
$ready = Join-Path $Workspace '_host-mutation-ready.txt'
$release = Join-Path $Workspace '_host-mutation-release.txt'
$resultPath = Join-Path $Workspace '_payload-result.json'
[IO.File]::WriteAllText($ready, 'ready')
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath $release) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
$result = [ordered]@{ releaseObserved = Test-Path -LiteralPath $release; topLevelValue = $null; outsideReadSucceeded = $false; outsideWriteSucceeded = $false; outsideReadError = $null; outsideWriteError = $null }
try { $result.topLevelValue = [IO.File]::ReadAllText((Join-Path $Workspace 'top-level.txt')) } catch { $result.topLevelReadError = $_.Exception.GetBaseException().GetType().Name }
$outsideFile = Join-Path $Workspace 'nested\outside-sentinel.txt'
try { $null = [IO.File]::ReadAllText($outsideFile); $result.outsideReadSucceeded = $true } catch { $result.outsideReadError = $_.Exception.GetBaseException().GetType().Name }
try { [IO.File]::WriteAllText($outsideFile, 'modified-from-appcontainer'); $result.outsideWriteSucceeded = $true } catch { $result.outsideWriteError = $_.Exception.GetBaseException().GetType().Name }
[IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 4))
'@ | Set-Content -LiteralPath $runtimePayloadPath -Encoding UTF8

  $runtimeMutatorScript = Join-Path $controlRoot 'mutate-running-snapshot.ps1'
  @'
param([string]$Workspace, [string]$OutsideRoot, [string]$ReadyPath, [string]$ReleasePath, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not (Test-Path -LiteralPath $ReadyPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
$result = [ordered]@{ readyObserved = Test-Path -LiteralPath $ReadyPath; rootRenameSucceeded = $false; rootRenameBlocked = $false; nestedRenameSucceeded = $false; junctionCreated = $false; topLevelFileReplacementSucceeded = $false; error = $null }
try {
  if (-not $result.readyObserved) { throw 'sandbox did not publish the ready marker' }
  $rootMovedAside = $Workspace + '.host-root-replacement'
  try {
    Move-Item -LiteralPath $Workspace -Destination $rootMovedAside -ErrorAction Stop
    $result.rootRenameSucceeded = $true
    Move-Item -LiteralPath $rootMovedAside -Destination $Workspace -ErrorAction Stop
  } catch { $result.rootRenameBlocked = $true }
  Move-Item -LiteralPath (Join-Path $Workspace 'nested') -Destination (Join-Path $Workspace 'nested-original') -ErrorAction Stop
  $result.nestedRenameSucceeded = $true
  $commandLine = 'mklink /J "{0}" "{1}"' -f (Join-Path $Workspace 'nested'), $OutsideRoot
  $null = @(& $env:ComSpec /d /c $commandLine 2>&1)
  $result.junctionCreated = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $Workspace 'nested')))
  $topLevel = Join-Path $Workspace 'top-level.txt'
  $replacement = Join-Path $Workspace 'top-level.host-replacement'
  $backup = Join-Path $Workspace 'top-level.host-backup'
  [IO.File]::WriteAllText($replacement, 'host-mutated-during-sandbox-run')
  [IO.File]::Replace($replacement, $topLevel, $backup)
  $result.topLevelFileReplacementSucceeded = $true
} catch { $result.error = $_.Exception.Message }
[IO.File]::WriteAllText($ReportPath, ($result | ConvertTo-Json -Depth 4))
[IO.File]::WriteAllText($ReleasePath, 'release')
'@ | Set-Content -LiteralPath $runtimeMutatorScript -Encoding UTF8
  $runtimeSpec = New-SandboxSpecification $runtimeSnapshot 'runtime-mutation'
  $runtimeMutatorArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Workspace "{1}" -OutsideRoot "{2}" -ReadyPath "{3}" -ReleasePath "{4}" -ReportPath "{5}"' -f $runtimeMutatorScript, $runtimeSnapshot, $runtimeOutside, $readyMarker, $releaseMarker, (Join-Path $controlRoot 'runtime-mutation-report.json')
  $runtimeMutator = Start-Process -FilePath $powershellExe -ArgumentList $runtimeMutatorArgs -PassThru -WindowStyle Hidden
  $runtimeRun = Invoke-Sandbox 'runtime-mutation' $runtimeSnapshot $runtimeSpec $powershellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runtimePayloadPath, $runtimeSnapshot) 20000
  $runtimeMutator.WaitForExit(25000) | Out-Null
  $runtimeHostResult = if (Test-Path -LiteralPath (Join-Path $controlRoot 'runtime-mutation-report.json')) {
    Get-Content -LiteralPath (Join-Path $controlRoot 'runtime-mutation-report.json') -Raw | ConvertFrom-Json
  } else { $null }
  $runtimePayloadResult = if (Test-Path -LiteralPath $payloadResultPath) { Get-Content -LiteralPath $payloadResultPath -Raw | ConvertFrom-Json } else { $null }
  $report.evidence.runtimeSnapshotMutation = [ordered]@{
    snapshotBuildPromoted = $runtimeCopy.Promoted
    sandboxPayloadStarted = $runtimeRun.PayloadStarted
    sandboxPayloadExitCode = $runtimeRun.PayloadExitCode
    sandboxLaunchError = $runtimeRun.Error
    hostMutationProcessExitCode = $runtimeMutator.ExitCode
    independentHostMutation = $runtimeHostResult
    sandboxObserved = $runtimePayloadResult
    externalSentinelContentAfterRun = [IO.File]::ReadAllText((Join-Path $runtimeOutside 'outside-sentinel.txt'))
    externalSentinelUnchanged = [IO.File]::ReadAllText((Join-Path $runtimeOutside 'outside-sentinel.txt')) -eq 'runtime-outside-original'
    resultFiles = [ordered]@{ attacker = Join-Path $controlRoot 'runtime-mutation-report.json'; payload = $payloadResultPath }
  }
  $runtimeChecksPassed = $runtimeRun.PayloadStarted -and $runtimeRun.PayloadExitCode -eq 0 -and
    $runtimeHostResult.rootRenameBlocked -and $runtimeHostResult.nestedRenameSucceeded -and
    $runtimeHostResult.junctionCreated -and $runtimeHostResult.topLevelFileReplacementSucceeded -and
    $runtimePayloadResult.releaseObserved -and $runtimePayloadResult.topLevelValue -eq 'host-mutated-during-sandbox-run' -and
    -not $runtimePayloadResult.outsideReadSucceeded -and -not $runtimePayloadResult.outsideWriteSucceeded -and
    $report.evidence.runtimeSnapshotMutation.externalSentinelUnchanged
  $report.evidence.acceptanceChecks = [ordered]@{
    handleCopyCreatedIndependentObjects = $copySummary.Promoted -and $report.evidence.handleCopy.sourceStoreUnchangedAfterSnapshotEdit
    sourceDirectoryReplacementStayedOnHeldObject = $raceResult.Promoted -and $raceResult.SourceDirectorySwapWasAttempted -and
      $raceHostResult.renameSucceeded -and $raceHostResult.junctionCreated -and $report.evidence.sourceDirectorySwap.copiedOriginalObjectContent -and
      -not $report.evidence.sourceDirectorySwap.outsideSecretCopied
    sourceFileReplacementWasRejected = $report.evidence.sourceFileReplacementRace.attack.oldFileRenamed -and
      $report.evidence.sourceFileReplacementRace.attack.outsideHardlinkInstalled -and
      $report.evidence.sourceFileReplacementRace.copierDetectedIdentityChange -and
      -not $report.evidence.sourceFileReplacementRace.destinationPromoted -and
      $report.evidence.sourceFileReplacementRace.stagingDirectoriesLeft -eq 0 -and
      $report.evidence.sourceFileReplacementRace.externalSecretUnchanged
    adsAndJunctionWereRejected = $report.evidence.specialObjects.namedStreamRejected -and
      $unsupportedCopy.ReparsePointCount -gt 0 -and -not $unsupportedCopy.Promoted
    runtimeSnapshotHostMutationEvidenceComplete = [bool]$runtimeChecksPassed
    actualProjectCensusCompleted = $null
  }

  # Read-only census of the actual LS repository, including its real .git and
  # node_modules. No copy is performed because this is a potentially large tree.
  $actualTimer = [Diagnostics.Stopwatch]::StartNew()
  try {
    $actual = [LsHandleSnapshotNative]::Analyze($repoRoot)
    $actualTimer.Stop()
    $reparseSamples = @($actual.UnsupportedObjects | Where-Object { $_ -like 'reparse:*' } | Select-Object -First 30)
    $reparseTagCounts = @($actual.UnsupportedObjects | Where-Object { $_ -like 'reparse:*' } | ForEach-Object { ($_ -split ':')[-1] } | Group-Object | ForEach-Object {
      [ordered]@{ tag = $_.Name; count = $_.Count }
    })
    $namedStreamSamples = @($actual.UnsupportedObjects | Where-Object { $_ -like 'named-stream:*' } | Select-Object -First 30)
    $report.evidence.actualProjectCompatibility = [ordered]@{
      projectRoot = $repoRoot
      scanSucceeded = $true
      scanElapsedMilliseconds = $actual.ElapsedMilliseconds
      entries = $actual.EntryCount
      files = $actual.FileCount
      directories = $actual.DirectoryCount
      hardLinkedFilePaths = $actual.HardLinkedFileCount
      reparsePoints = $actual.ReparsePointCount
      namedStreamFiles = $actual.NamedStreamFileCount
      unknownStreamStatusFiles = $actual.UnknownStreamStatusCount
      logicalPayloadBytes = $actual.LogicalBytes
      sourceAllocatedBytes = $actual.SourceAllocatedBytes
      unsupportedObjectCount = $actual.UnsupportedObjects.Count
      reparseSamples = $reparseSamples
      reparseTagCounts = $reparseTagCounts
      namedStreamSamples = $namedStreamSamples
      snapshotAttempt = 'not-run-for-whole-repository; bounded to metadata census because real node_modules can be large'
      fullSnapshotDiskUseEstimateBytes = $actual.LogicalBytes
      fullSnapshotCopyTimeEstimateMilliseconds = $null
    }
  } catch {
    $actualTimer.Stop()
    $report.evidence.actualProjectCompatibility = [ordered]@{
      projectRoot = $repoRoot
      scanSucceeded = $false
      scanElapsedMilliseconds = $actualTimer.ElapsedMilliseconds
      error = $_.Exception.GetBaseException().Message
      snapshotAttempt = 'not-run'
    }
  }

  $report.evidence.acceptanceChecks.actualProjectCensusCompleted = [bool]$report.evidence.actualProjectCompatibility.scanSucceeded
  $reportPath = Join-Path $evidenceRoot 'report.json'
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12))
  Push-Location $repoRoot
  try {
    & $nodeExe (Join-Path $PSScriptRoot 'evaluate-report.mjs') $reportPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox capability assessment failed.' }
  } finally { Pop-Location }
  $assessed = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  $assessed | ConvertTo-Json -Depth 16
  if ($report.evidence.acceptanceChecks.handleCopyCreatedIndependentObjects -and
    $report.evidence.acceptanceChecks.sourceFileReplacementWasRejected -and
    $report.evidence.acceptanceChecks.sourceDirectoryReplacementStayedOnHeldObject -and
    $report.evidence.acceptanceChecks.adsAndJunctionWereRejected -and
    $report.evidence.acceptanceChecks.runtimeSnapshotHostMutationEvidenceComplete -and
    $report.evidence.acceptanceChecks.actualProjectCensusCompleted) { exit 0 }
  exit 2
} catch {
  $report.error = $_.Exception.GetBaseException().Message
  $report.errorAt = $_.ScriptStackTrace
  $reportPath = Join-Path $evidenceRoot 'report-partial.json'
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12))
  throw
}
