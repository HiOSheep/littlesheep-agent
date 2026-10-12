[CmdletBinding()]
param(
  [string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This proof of concept only runs on Windows.' }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$gitExe = (Get-Command git.exe -ErrorAction Stop).Source
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$nodeRoot = Split-Path -Parent $nodeExe
$gitRoot = Split-Path -Parent (Split-Path -Parent $gitExe)
$powershellRoot = Split-Path -Parent $powershellExe
$windowsSystem = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
$wprCommand = Get-Command wpr.exe -ErrorAction SilentlyContinue
$wprProfilesAvailable = $false
if ($wprCommand) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $wprProfilesOutput = @(& $wprCommand.Source -profiles 2>&1)
  $wprProfilesExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $wprProfilesAvailable = ($wprProfilesExitCode -eq 0 -and (($wprProfilesOutput -join "`n") -match '(?m)^\s*FileIO\s+File I/O activity'))
}
$runnerScript = Join-Path $PSScriptRoot 'Run-SandboxProcess.ps1'
$builderScript = Join-Path $PSScriptRoot 'build-sandbox-spec.mjs'

if (-not $EvidenceDirectory) {
  $EvidenceDirectory = Join-Path $env:TEMP ('ls-windows-snapshot-poc-' + [Guid]::NewGuid().ToString('N'))
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
$directWorkspace = Join-Path $fixturesRoot 'direct-workspace'
$hardlinkWorkspace = Join-Path $fixturesRoot 'hardlink-source'
$reparseWorkspace = Join-Path $fixturesRoot 'reparse-source'
$cleanWorkspace = Join-Path $fixturesRoot 'clean-source'
$snapshotParent = Join-Path $evidenceRoot 'isolated-run'
$snapshotWorkspace = Join-Path $snapshotParent 'workspace'
$null = New-Item -ItemType Directory -Path @($controlRoot, $outsideRoot, $directWorkspace, $hardlinkWorkspace, $reparseWorkspace, $cleanWorkspace, $snapshotParent)
$null = New-Item -ItemType Directory -Path @((Join-Path $directWorkspace 'profile'), (Join-Path $directWorkspace 'temp'), (Join-Path $hardlinkWorkspace 'profile'), (Join-Path $hardlinkWorkspace 'temp'), (Join-Path $reparseWorkspace 'profile'), (Join-Path $reparseWorkspace 'temp'), (Join-Path $cleanWorkspace 'profile'), (Join-Path $cleanWorkspace 'temp'), (Join-Path $cleanWorkspace 'src'))

if (-not ('LsWindowsSnapshotFileInfo' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class LsWindowsSnapshotIdentity {
  public string FileId { get; set; }
  public uint LinkCount { get; set; }
  public uint Attributes { get; set; }
}

public static class LsWindowsSnapshotFileInfo {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME { public uint Low; public uint High; }

  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public FILETIME CreationTime;
    public FILETIME LastAccessTime;
    public FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint desiredAccess, uint shareMode,
    IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateHardLinkW(string linkName, string existingFileName, IntPtr securityAttributes);

  public static LsWindowsSnapshotIdentity Inspect(string path) {
    const uint FILE_READ_ATTRIBUTES = 0x80;
    const uint FILE_SHARE_READ = 1;
    const uint FILE_SHARE_WRITE = 2;
    const uint FILE_SHARE_DELETE = 4;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    using (SafeFileHandle handle = CreateFileW(path, FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW metadata handle failed");
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(handle, out information))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandle failed");
      return new LsWindowsSnapshotIdentity {
        FileId = information.VolumeSerialNumber.ToString("X8") + ":" +
          information.FileIndexHigh.ToString("X8") + information.FileIndexLow.ToString("X8"),
        LinkCount = information.NumberOfLinks,
        Attributes = information.FileAttributes
      };
    }
  }
}
'@ -ErrorAction Stop
}

function Get-FileIdentity([string]$Path) {
  return [LsWindowsSnapshotFileInfo]::Inspect($Path)
}

function Get-FileHashHex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash
}

function Get-SnapshotEntries([string]$SourceRoot) {
  $source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $rootInfo = Get-Item -LiteralPath $source -Force
  if (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'unsupported-reparse-point:workspace-root'
  }

  $entries = New-Object 'System.Collections.Generic.List[object]'
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($source)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in (Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('unsupported-reparse-point:' + $item.FullName.Substring($source.Length).TrimStart('\'))
      }
      $relativePath = $item.FullName.Substring($source.Length).TrimStart('\')
      if ($item.PSIsContainer) {
        $entries.Add([pscustomobject]@{ RelativePath = $relativePath; IsDirectory = $true; FileId = $null })
        $pending.Push($item.FullName)
        continue
      }

      $identity = Get-FileIdentity $item.FullName
      if ($identity.LinkCount -ne 1) {
        throw ('hardlink-count:' + $relativePath + ':' + $identity.LinkCount)
      }
      $entries.Add([pscustomobject]@{ RelativePath = $relativePath; IsDirectory = $false; FileId = $identity.FileId })
    }
  }
  return $entries.ToArray()
}

function New-IsolatedSnapshot([string]$SourceRoot, [string]$DestinationRoot) {
  $entries = @(Get-SnapshotEntries $SourceRoot)
  if (Test-Path -LiteralPath $DestinationRoot) { throw 'snapshot-destination-already-exists' }
  $stage = Join-Path (Split-Path -Parent $DestinationRoot) ('.snapshot-stage-' + [Guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $stage
  try {
    foreach ($entry in $entries) {
      $sourcePath = Join-Path $SourceRoot $entry.RelativePath
      $destinationPath = Join-Path $stage $entry.RelativePath
      if ($entry.IsDirectory) {
        $null = New-Item -ItemType Directory -Path $destinationPath
        continue
      }

      $before = Get-FileIdentity $sourcePath
      if ($before.FileId -ne $entry.FileId -or $before.LinkCount -ne 1 -or (($before.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw ('source-changed-after-preflight:' + $entry.RelativePath)
      }
      [IO.File]::Copy($sourcePath, $destinationPath, $false)
      $after = Get-FileIdentity $sourcePath
      $copy = Get-FileIdentity $destinationPath
      if ($after.FileId -ne $entry.FileId -or $after.LinkCount -ne 1 -or $copy.FileId -eq $entry.FileId -or $copy.LinkCount -ne 1) {
        throw ('file-identity-changed-during-copy:' + $entry.RelativePath)
      }
    }
    Move-Item -LiteralPath $stage -Destination $DestinationRoot -ErrorAction Stop
  }
  catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    throw
  }

  return [pscustomobject]@{ FileCount = @($entries | Where-Object { -not $_.IsDirectory }).Count; DirectoryCount = @($entries | Where-Object IsDirectory).Count; PromotedBySameParentRename = $true }
}

function New-SandboxSpecification([string]$Workspace, [string]$Name) {
  $specificationPath = Join-Path $controlRoot ($Name + '.spec.bin')
  $readOnlyRoots = @($nodeRoot, $gitRoot, $powershellRoot, $windowsSystem) | Sort-Object -Unique
  $builderArguments = @($builderScript, '--out', $specificationPath, '--workspace', $Workspace)
  foreach ($path in $readOnlyRoots) { $builderArguments += @('--read-only', $path) }
  Push-Location $repoRoot
  try {
    & $nodeExe @builderArguments | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $specificationPath)) {
      throw "sandbox specification build failed for $Name"
    }
  }
  finally { Pop-Location }
  return $specificationPath
}

function Invoke-Sandbox([string]$Name, [string]$Workspace, [string]$Specification, [string]$Executable, [string[]]$Arguments, [int]$TimeoutMilliseconds = 20000) {
  $identity = 'LSSnapshotPoc_' + [Guid]::NewGuid().ToString('N')
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
    pathValue = @($nodeRoot, (Join-Path $gitRoot 'cmd'), (Join-Path $gitRoot 'mingw64\bin'), (Join-Path $gitRoot 'usr\bin'), $powershellRoot, $windowsSystem) -join ';'
    modulePathValue = Join-Path $powershellRoot 'Modules'
    timeoutMilliseconds = $TimeoutMilliseconds
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
    Stdout = if (Test-Path -LiteralPath $stdoutPath) { $text = Get-Content -LiteralPath $stdoutPath -Raw; if ($null -eq $text) { '' } else { $text.Trim() } } else { '' }
    Stderr = if (Test-Path -LiteralPath $stderrPath) { $text = Get-Content -LiteralPath $stderrPath -Raw; if ($null -eq $text) { '' } else { $text.Trim() } } else { '' }
  }
}

function Try-StartFileIoTrace([string]$TracePath) {
  if (-not $wprProfilesAvailable) {
    return [pscustomobject]@{ Started = $false; Reason = 'Windows Performance Recorder FileIO profile is unavailable.'; Output = 'WPR FileIO unavailable.' }
  }
  $status = @(& wpr.exe -status 2>&1)
  $statusText = $status -join "`n"
  if ($statusText -notmatch 'WPR is not recording') {
    return [pscustomobject]@{ Started = $false; Reason = 'WPR already has a recording; did not attach to or stop it.'; Output = $statusText }
  }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $start = @(& wpr.exe -start FileIO -filemode 2>&1)
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($exitCode -ne 0) {
    $startText = $start -join "`n"
    $reason = if ($startText -match '0x80070005') { 'WPR FileIO capture failed with ACCESS_DENIED (0x80070005).' } else { 'WPR FileIO capture failed; no elevation or provider availability was assumed.' }
    return [pscustomobject]@{ Started = $false; Reason = $reason; Output = $reason }
  }
  return [pscustomobject]@{ Started = $true; Reason = $null; Output = ($start -join "`n"); TracePath = $TracePath }
}

function Stop-FileIoTrace($TraceState) {
  if (-not $TraceState -or -not $TraceState.Started) { return $TraceState }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $stop = @(& wpr.exe -stop $TraceState.TracePath 'short P3-A3 sandbox Git init probe' 2>&1)
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $TraceState | Add-Member -NotePropertyName StopExitCode -NotePropertyValue $exitCode -Force
  $TraceState | Add-Member -NotePropertyName StopOutput -NotePropertyValue ($stop -join "`n") -Force
  return $TraceState
}

$report = [ordered]@{
  generatedAt = [DateTime]::UtcNow.ToString('o')
  backendId = 'windows-snapshot-filesystem-poc'
  productionIntegration = $false
  host = [ordered]@{
    os = (Get-CimInstance Win32_OperatingSystem).Caption
    build = [Environment]::OSVersion.Version.Build
    architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    nodeVersion = [string](& $nodeExe --version)
    gitVersion = [string](& $gitExe --version)
    ipv6DefaultRoutePresent = [bool](Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue)
    wprFileIoProfileAvailable = $wprProfilesAvailable
    experimentalPayloadStarted = $false
  }
  scope = [ordered]@{ platform = 'win32'; runId = [Guid]::NewGuid().ToString('N'); workspaceRoot = $snapshotWorkspace; evidenceRoot = $evidenceRoot }
  evidence = [ordered]@{
    directWorkspaceHardLink = [ordered]@{}
    snapshotPreflight = [ordered]@{}
    snapshotProcess = [ordered]@{}
    git = [ordered]@{}
    ipv6 = [ordered]@{ hostDefaultRoute = $false; sandboxEgress = 'not-tested-no-host-positive-baseline' }
    concurrentSnapshotMutation = 'not-tested'
    stableCreateProcessAppContainer = 'researched-only-not-implemented'
  }
}

try {
  $outsideSentinel = Join-Path $outsideRoot 'outside-sentinel.txt'
  $directHardLink = Join-Path $directWorkspace 'outside-hardlink.txt'
  [IO.File]::WriteAllText($outsideSentinel, 'outside-sentinel-original')
  [IO.File]::WriteAllText((Join-Path $directWorkspace 'profile\placeholder.txt'), 'profile')
  [IO.File]::WriteAllText((Join-Path $directWorkspace 'temp\placeholder.txt'), 'temp')
  [IO.File]::WriteAllText((Join-Path $hardlinkWorkspace 'profile\placeholder.txt'), 'profile')
  [IO.File]::WriteAllText((Join-Path $hardlinkWorkspace 'temp\placeholder.txt'), 'temp')
  if (-not [LsWindowsSnapshotFileInfo]::CreateHardLinkW($directHardLink, $outsideSentinel, [IntPtr]::Zero)) {
    throw ('Could not create actual NTFS hardlink fixture: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $outsideId = Get-FileIdentity $outsideSentinel
  $aliasId = Get-FileIdentity $directHardLink
  $report.evidence.directWorkspaceHardLink = [ordered]@{
    sameFileObject = $outsideId.FileId -eq $aliasId.FileId
    linkCount = $outsideId.LinkCount
    initialSentinel = [IO.File]::ReadAllText($outsideSentinel)
  }

  $directSpec = New-SandboxSpecification $directWorkspace 'direct-workspace'
  $directPayloadPath = Join-Path $directWorkspace 'write-hardlink.ps1'
  $directPayloadResult = Join-Path $directWorkspace 'payload-result.txt'
  [IO.File]::WriteAllText($directPayloadPath, @'
param([string]$AliasPath, [string]$ResultPath)
[IO.File]::WriteAllText($AliasPath, 'modified-through-direct-workspace-hardlink')
[IO.File]::WriteAllText($ResultPath, 'payload-ran')
'@)
  $directRun = Invoke-Sandbox 'direct-workspace-hardlink' $directWorkspace $directSpec $powershellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $directPayloadPath, $directHardLink, $directPayloadResult)
  $directTargetContent = [IO.File]::ReadAllText($outsideSentinel)
  $report.evidence.directWorkspaceHardLink.sandboxWorkerExitCode = $directRun.WorkerExitCode
  $report.evidence.directWorkspaceHardLink.payloadStarted = $directRun.PayloadStarted
  $report.evidence.directWorkspaceHardLink.outsideTargetChanged = $directTargetContent -eq 'modified-through-direct-workspace-hardlink'
  $report.evidence.directWorkspaceHardLink.finalTargetContent = $directTargetContent
  $report.evidence.directWorkspaceHardLink.launchError = $directRun.Error

  $hardlinkAlias = Join-Path $hardlinkWorkspace 'alias-to-outside.txt'
  if (-not [LsWindowsSnapshotFileInfo]::CreateHardLinkW($hardlinkAlias, $outsideSentinel, [IntPtr]::Zero)) {
    throw ('Could not create hardlink snapshot rejection fixture: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  try {
    $null = New-IsolatedSnapshot $hardlinkWorkspace (Join-Path $snapshotParent 'should-not-exist-hardlink')
    $hardlinkRejected = $false
    $hardlinkReason = $null
  }
  catch {
    $hardlinkRejected = $_.Exception.Message -like 'hardlink-count:*'
    $hardlinkReason = $_.Exception.Message
  }
  $report.evidence.snapshotPreflight.hardlinkFixtureRejected = $hardlinkRejected
  $report.evidence.snapshotPreflight.hardlinkRejectionReason = $hardlinkReason
  $report.evidence.snapshotPreflight.hardlinkDestinationCreated = Test-Path -LiteralPath (Join-Path $snapshotParent 'should-not-exist-hardlink')
  $report.evidence.snapshotPreflight.hardlinkTargetContentAfterDirectProbe = [IO.File]::ReadAllText($outsideSentinel)

  $reparseTarget = Join-Path $outsideRoot 'reparse-target'
  $reparseLink = Join-Path $reparseWorkspace 'outside-junction'
  $null = New-Item -ItemType Directory -Path $reparseTarget
  [IO.File]::WriteAllText((Join-Path $reparseTarget 'sentinel.txt'), 'junction-target-sentinel')
  $junctionOutput = @(& $env:ComSpec /d /c ('mklink /J "{0}" "{1}"' -f $reparseLink, $reparseTarget) 2>&1)
  $junctionCreated = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $reparseLink))
  $reparseReject = $null
  $reparseRejected = $false
  if ($junctionCreated) {
    try {
      $null = New-IsolatedSnapshot $reparseWorkspace (Join-Path $snapshotParent 'should-not-exist-junction')
    }
    catch {
      $reparseRejected = $_.Exception.Message -like 'unsupported-reparse-point:*'
      $reparseReject = $_.Exception.Message
    }
  }
  $report.evidence.snapshotPreflight.junctionCreated = $junctionCreated
  $report.evidence.snapshotPreflight.junctionRejected = $reparseRejected
  $report.evidence.snapshotPreflight.junctionRejectionReason = $reparseReject
  $report.evidence.snapshotPreflight.junctionDestinationCreated = Test-Path -LiteralPath (Join-Path $snapshotParent 'should-not-exist-junction')
  if (-not $junctionCreated) { $report.evidence.snapshotPreflight.junctionCreationOutput = $junctionOutput -join ' ' }

  [IO.File]::WriteAllText((Join-Path $cleanWorkspace 'profile\placeholder.txt'), 'profile')
  [IO.File]::WriteAllText((Join-Path $cleanWorkspace 'temp\placeholder.txt'), 'temp')
  $cleanSourceFile = Join-Path $cleanWorkspace 'src\shared.txt'
  $cleanNestedFile = Join-Path $cleanWorkspace 'src\nested.txt'
  [IO.File]::WriteAllText($cleanSourceFile, 'source-content-before-sandbox')
  [IO.File]::WriteAllText($cleanNestedFile, 'nested-content-before-sandbox')
  $cleanSourceId = Get-FileIdentity $cleanSourceFile
  $snapshotSummary = New-IsolatedSnapshot $cleanWorkspace $snapshotWorkspace
  $snapshotFile = Join-Path $snapshotWorkspace 'src\shared.txt'
  $snapshotFileId = Get-FileIdentity $snapshotFile
  $report.evidence.snapshotPreflight.cleanSnapshotCreated = Test-Path -LiteralPath $snapshotWorkspace
  $report.evidence.snapshotPreflight.cleanSnapshotFileCount = $snapshotSummary.FileCount
  $report.evidence.snapshotPreflight.snapshotPromotedBySameParentRename = $snapshotSummary.PromotedBySameParentRename
  $report.evidence.snapshotPreflight.cleanSnapshotObjectIndependent = $cleanSourceId.FileId -ne $snapshotFileId.FileId
  $report.evidence.snapshotPreflight.cleanSnapshotContentMatchesSource = (Get-FileHashHex $cleanSourceFile) -eq (Get-FileHashHex $snapshotFile)
  $report.evidence.snapshotPreflight.cleanSourceLinkCount = $cleanSourceId.LinkCount
  $report.evidence.snapshotPreflight.snapshotLinkCount = $snapshotFileId.LinkCount

  $snapshotSpec = New-SandboxSpecification $snapshotWorkspace 'isolated-snapshot'
  $nodePayloadPath = Join-Path $snapshotWorkspace 'write-child.mjs'
  $shellPayloadPath = Join-Path $snapshotWorkspace 'snapshot-payload.ps1'
  $shellPayloadResult = Join-Path $snapshotWorkspace 'payload-result.json'
  [IO.File]::WriteAllText($nodePayloadPath, @'
import fs from 'node:fs';
const target = process.argv[2];
fs.writeFileSync(target, 'modified-by-node-child');
'@)
  [IO.File]::WriteAllText($shellPayloadPath, @'
param([string]$Workspace, [string]$NodeExe, [string]$NodeScript, [string]$ResultPath)
$report = [ordered]@{}
try {
  [IO.File]::WriteAllText((Join-Path $Workspace 'src\shared.txt'), 'modified-by-sandbox-powershell')
  $report.powershellWrite = $true
}
catch { $report.powershellWrite = $false; $report.powershellError = $_.Exception.GetBaseException().GetType().Name }
try {
  function Invoke-NodeProbe([string]$Arguments) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $NodeExe
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $Workspace
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
      $stdoutTask = $process.StandardOutput.ReadToEndAsync()
      $stderrTask = $process.StandardError.ReadToEndAsync()
      $process.WaitForExit()
      return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdoutTask.Result.Trim(); Stderr = $stderrTask.Result.Trim() }
    }
    finally { $process.Dispose() }
  }
  $nodeTarget = Join-Path $Workspace 'src\nested.txt'
  $fileRun = Invoke-NodeProbe ('"' + $NodeScript + '"')
  $report.nodeFileEntryExitCode = $fileRun.ExitCode
  $report.nodeFileEntryStderr = $fileRun.Stderr
  $nodeCode = "require('node:fs').writeFileSync(process.argv[1], 'modified-by-node-child')"
  $evalRun = Invoke-NodeProbe ('-e "' + $nodeCode + '" "' + $nodeTarget + '"')
  $report.nodeChildExitCode = $evalRun.ExitCode
  $report.nodeChildStdout = $evalRun.Stdout
  $report.nodeChildStderr = $evalRun.Stderr
}
catch { $report.nodeChildExitCode = -1; $report.nodeChildError = $_.Exception.GetBaseException().GetType().Name }
[IO.File]::WriteAllText($ResultPath, ($report | ConvertTo-Json -Compress))
'@)
  $snapshotRun = Invoke-Sandbox 'snapshot-powershell-node' $snapshotWorkspace $snapshotSpec $powershellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $shellPayloadPath, $snapshotWorkspace, $nodeExe, $nodePayloadPath, $shellPayloadResult)
  $snapshotPayload = $null
  if (Test-Path -LiteralPath $shellPayloadResult) { $snapshotPayload = Get-Content -LiteralPath $shellPayloadResult -Raw | ConvertFrom-Json }
  $report.evidence.snapshotProcess.workerExitCode = $snapshotRun.WorkerExitCode
  $report.evidence.snapshotProcess.payloadStarted = $snapshotRun.PayloadStarted
  $report.evidence.snapshotProcess.payloadExitCode = $snapshotRun.PayloadExitCode
  $report.evidence.snapshotProcess.payloadResult = $snapshotPayload
  $report.evidence.snapshotProcess.launchError = $snapshotRun.Error
  $report.evidence.snapshotProcess.sourceSharedFileUnchanged = [IO.File]::ReadAllText($cleanSourceFile) -eq 'source-content-before-sandbox'
  $report.evidence.snapshotProcess.sourceNestedFileUnchanged = [IO.File]::ReadAllText($cleanNestedFile) -eq 'nested-content-before-sandbox'
  $report.evidence.snapshotProcess.snapshotSharedFileChanged = [IO.File]::ReadAllText($snapshotFile) -eq 'modified-by-sandbox-powershell'
  $report.evidence.snapshotProcess.snapshotNestedFileChangedByNode = [IO.File]::ReadAllText((Join-Path $snapshotWorkspace 'src\nested.txt')) -eq 'modified-by-node-child'
  $report.evidence.snapshotProcess.outsideSentinelUnchangedAfterSnapshotRun = [IO.File]::ReadAllText($outsideSentinel) -eq 'modified-through-direct-workspace-hardlink'

  $gitTracePath = Join-Path $controlRoot 'git-fileio.etl'
  $traceState = Try-StartFileIoTrace $gitTracePath
  $gitWorkspace = Join-Path $snapshotWorkspace 'git-fixture'
  $null = New-Item -ItemType Directory -Path $gitWorkspace
  try {
    $gitRun = Invoke-Sandbox 'snapshot-git-init' $snapshotWorkspace $snapshotSpec $gitExe @('init', '--quiet', $gitWorkspace)
  }
  finally { $traceState = Stop-FileIoTrace $traceState }
  $report.evidence.git.workerExitCode = $gitRun.WorkerExitCode
  $report.evidence.git.payloadStarted = $gitRun.PayloadStarted
  $report.evidence.git.payloadExitCode = $gitRun.PayloadExitCode
  $report.evidence.git.repositoryCreated = Test-Path -LiteralPath (Join-Path $gitWorkspace '.git')
  $report.evidence.git.launchError = $gitRun.Error
  $gitTrace2Path = Join-Path $snapshotWorkspace 'git-trace2.json'
  $report.evidence.git.trace2Path = if (Test-Path -LiteralPath $gitTrace2Path) { $gitTrace2Path } else { $null }
  if (Test-Path -LiteralPath $gitTrace2Path) {
    $trace2Events = @(Get-Content -LiteralPath $gitTrace2Path | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
    $gitErrorEvent = $trace2Events | Where-Object { $_.event -eq 'error' } | Select-Object -First 1
    $report.evidence.git.trace2ErrorMessage = if ($gitErrorEvent) { [string]$gitErrorEvent.msg } else { $null }
  }
  $report.evidence.git.fileIoTrace = [ordered]@{
    started = [bool]$traceState.Started
    reason = $traceState.Reason
    startOutput = $traceState.Output
    stopExitCode = $traceState.StopExitCode
    stopOutput = $traceState.StopOutput
    path = if ($traceState.Started -and (Test-Path -LiteralPath $gitTracePath)) { $gitTracePath } else { $null }
    analyzed = $false
  }

  $report.host.experimentalPayloadStarted = [bool]($directRun.PayloadStarted -or $snapshotRun.PayloadStarted)
  $report.evidence.ipv6.hostDefaultRoute = $report.host.ipv6DefaultRoutePresent
  $report.evidence.ipv6.sandboxEgress = if ($report.host.ipv6DefaultRoutePresent) { 'not-tested' } else { 'not-tested-no-host-positive-baseline' }
}
catch {
  $report.evidence.harnessError = $_.Exception.Message
  $report.evidence.harnessErrorLine = $_.InvocationInfo.ScriptLineNumber
  $report.evidence.harnessErrorStatement = $_.InvocationInfo.Line
  $report.evidence.harnessErrorStack = $_.ScriptStackTrace
}

$reportPath = Join-Path $evidenceRoot 'report.json'
[IO.File]::WriteAllText($reportPath, ((ConvertTo-Json -InputObject $report -Depth 10) + "`n"))
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
Push-Location $repoRoot
try {
  & $pnpm --filter @littlesheep/types build
  if ($LASTEXITCODE -ne 0) { throw 'Could not build @littlesheep/types for the capability assessment.' }
  & $nodeExe (Join-Path $PSScriptRoot 'evaluate-report.mjs') $reportPath
  if ($LASTEXITCODE -ne 0) { throw 'Could not evaluate the snapshot experiment through @littlesheep/types.' }
}
finally { Pop-Location }
$assessedReport = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
Write-Output (Get-Content -LiteralPath $reportPath -Raw)
Write-Output "evidence=$evidenceRoot"

if ($report.evidence.harnessError) { exit 1 }
if (-not $report.evidence.directWorkspaceHardLink.outsideTargetChanged) { exit 2 }
if (-not $report.evidence.snapshotPreflight.hardlinkFixtureRejected -or $report.evidence.snapshotPreflight.hardlinkDestinationCreated) { exit 3 }
if (-not $report.evidence.snapshotPreflight.junctionCreated -or -not $report.evidence.snapshotPreflight.junctionRejected -or $report.evidence.snapshotPreflight.junctionDestinationCreated) { exit 4 }
if (-not $report.evidence.snapshotPreflight.cleanSnapshotObjectIndependent) { exit 5 }
if (-not $report.evidence.snapshotPreflight.cleanSnapshotContentMatchesSource -or -not $report.evidence.snapshotPreflight.snapshotPromotedBySameParentRename) { exit 8 }
if (-not $report.evidence.snapshotProcess.payloadStarted -or $report.evidence.snapshotProcess.payloadExitCode -ne 0) { exit 6 }
if (-not $report.evidence.snapshotProcess.sourceSharedFileUnchanged -or -not $report.evidence.snapshotProcess.sourceNestedFileUnchanged -or -not $report.evidence.snapshotProcess.snapshotSharedFileChanged -or -not $report.evidence.snapshotProcess.snapshotNestedFileChangedByNode -or $report.evidence.snapshotProcess.payloadResult.nodeChildExitCode -ne 0) { exit 7 }
if ($assessedReport.shellReadiness.ready -ne $false -or $assessedReport.readinessIsAuthorization -ne $false) { exit 9 }
if (@($assessedReport.capabilitySnapshot.capabilities.PSObject.Properties | Where-Object { $_.Value.status -eq 'verified' }).Count -gt 0) { exit 10 }
