[CmdletBinding()]
param([string]$EvidenceDirectory)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This proof of concept only runs on Windows.' }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$gitExe = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path -Parent (Split-Path -Parent $gitExe)
$nodeRoot = Split-Path -Parent $nodeExe
$powershellRoot = Split-Path -Parent $powershellExe
$windowsRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$windowsSystem = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
$powershellModules = Join-Path $powershellRoot 'Modules'
$sharedPowerShellModules = Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'

if (-not $EvidenceDirectory) {
  $EvidenceDirectory = Join-Path $env:TEMP ('ls-windows-sandbox-poc-' + [Guid]::NewGuid().ToString('N'))
}
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $evidenceRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'EvidenceDirectory must remain below the current user TEMP directory.'
}
if (Test-Path -LiteralPath $evidenceRoot) { throw "EvidenceDirectory already exists: $evidenceRoot" }

$controlRoot = Join-Path $evidenceRoot 'control'
$workspaceTraversalRoot = Join-Path $evidenceRoot 'workspace-scope'
$workspaceRoot = Join-Path $workspaceTraversalRoot 'workspace'
$outsideRoot = Join-Path $evidenceRoot 'outside'
$null = New-Item -ItemType Directory -Path @($controlRoot, $workspaceTraversalRoot, $outsideRoot)
$null = New-Item -ItemType Directory -Path $workspaceRoot
$progressPath = Join-Path $controlRoot 'progress.log'
function Write-ProbeProgress([string]$Step) {
  [IO.File]::AppendAllText($script:progressPath, ([DateTime]::UtcNow.ToString('o') + ' ' + $Step + "`r`n"))
}
Write-ProbeProgress 'fixture-created'
$null = New-Item -ItemType Directory -Path (Join-Path $workspaceRoot 'git-fixture')
$null = New-Item -ItemType Directory -Path @((Join-Path $workspaceRoot 'profile'), (Join-Path $workspaceRoot 'temp'))

$outsideSecret = Join-Path $outsideRoot 'host-secret.txt'
$outsideWrite = Join-Path $outsideRoot 'sandbox-write.txt'
$raceDirectory = Join-Path $workspaceRoot 'replaceable-directory'
$raceOriginalDirectory = Join-Path $workspaceRoot 'replaceable-directory-original'
$outsideRaceDirectory = Join-Path $outsideRoot 'replacement-target'
$raceStartedPath = Join-Path $workspaceRoot 'directory-race-started.txt'
$raceOutsideReadPath = Join-Path $workspaceRoot 'directory-race-outside-read.txt'
$profileGitConfig = Join-Path $env:USERPROFILE '.gitconfig'
$profilePowerShellHistory = Join-Path $env:APPDATA 'Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt'
if (-not (Test-Path -LiteralPath $profileGitConfig)) { $profileGitConfig = '__unavailable__' }
if (-not (Test-Path -LiteralPath $profilePowerShellHistory)) { $profilePowerShellHistory = '__unavailable__' }
$insideSentinel = Join-Path $workspaceRoot 'workspace-readable.txt'
$junctionPath = Join-Path $workspaceRoot 'outside-junction'
$symlinkPath = Join-Path $workspaceRoot 'outside-link.txt'
$hardLinkPath = Join-Path $workspaceRoot 'outside-hardlink.txt'
$protectedSource = Join-Path $repoRoot 'packages\tools\src\builtin\exec.ts'
$reportPath = Join-Path $evidenceRoot 'report.json'
$specificationPath = Join-Path $controlRoot 'sandbox-spec.bin'
$builderScript = Join-Path $PSScriptRoot 'build-sandbox-spec.mjs'
$runnerScript = Join-Path $PSScriptRoot 'Run-SandboxProcess.ps1'

[IO.File]::WriteAllText($outsideSecret, 'host-secret-sentinel')
[IO.File]::WriteAllText($insideSentinel, 'workspace-readable-sentinel')
$null = New-Item -ItemType Directory -Path @($raceDirectory, $outsideRaceDirectory)
[IO.File]::WriteAllText((Join-Path $raceDirectory 'sentinel.txt'), 'workspace-race-sentinel')
[IO.File]::WriteAllText((Join-Path $outsideRaceDirectory 'sentinel.txt'), 'outside-race-sentinel')

$junctionCreated = $false
$junctionError = $null
$mklinkCommand = '/d /c mklink /J "{0}" "{1}"' -f $junctionPath, $outsideRoot
& $env:ComSpec $mklinkCommand | Out-Null
if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $junctionPath)) { $junctionCreated = $true }
else { $junctionError = "mklink /J exit=$LASTEXITCODE" }

$symlinkCreated = $false
$symlinkError = $null
try {
  if (-not ('LsWindowsSandboxSymlinkProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class LsWindowsSandboxSymlinkProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateSymbolicLinkW(string link, string target, uint flags);
}
'@ -ErrorAction Stop
  }
  # This flag requests Windows' unprivileged path when host policy permits it;
  # it does not change host policy or enable Developer Mode.
  $symlinkCreated = [LsWindowsSandboxSymlinkProbe]::CreateSymbolicLinkW($symlinkPath, $outsideSecret, 2)
  if (-not $symlinkCreated) { $symlinkError = "CreateSymbolicLinkW error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
}
catch { $symlinkError = $_.Exception.Message }

$hardLinkCreated = $false
$hardLinkError = $null
try {
  New-Item -ItemType HardLink -Path $hardLinkPath -Target $outsideSecret -ErrorAction Stop | Out-Null
  $hardLinkCreated = Test-Path -LiteralPath $hardLinkPath
}
catch { $hardLinkError = $_.Exception.GetBaseException().GetType().Name }

$runtimeReadRoots = @($nodeRoot, $gitRoot, $powershellRoot, $windowsSystem, $workspaceTraversalRoot)
if (Test-Path -LiteralPath $sharedPowerShellModules) { $runtimeReadRoots += $sharedPowerShellModules }
$runtimeReadRoots = @($runtimeReadRoots | Sort-Object -Unique)
foreach ($runtimePath in $runtimeReadRoots) {
  $normalizedRuntimePath = [IO.Path]::GetFullPath($runtimePath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($normalizedRuntimePath -match '^[A-Za-z]:$') {
    throw "Refusing a volume-root runtime read grant: $runtimePath"
  }
}
$pathValue = @(
  $nodeRoot,
  (Join-Path $gitRoot 'cmd'),
  (Join-Path $gitRoot 'mingw64\bin'),
  (Join-Path $gitRoot 'usr\bin'),
  $powershellRoot,
  $windowsSystem
) -join ';'
$moduleRoots = @($powershellModules)
if (Test-Path -LiteralPath $sharedPowerShellModules) { $moduleRoots += $sharedPowerShellModules }
$modulePathValue = $moduleRoots -join ';'

$buildArguments = @($builderScript, '--out', $specificationPath, '--workspace', $workspaceRoot)
foreach ($path in $runtimeReadRoots) { $buildArguments += @('--read-only', $path) }
& $nodeExe @buildArguments | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $specificationPath)) {
  throw 'Could not build the Windows sandbox specification.'
}

function Test-TcpReachable([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 1500) {
  $client = $null
  try {
    $address = $null
    if ([Net.IPAddress]::TryParse($HostName, [ref]$address)) {
      $client = [Net.Sockets.TcpClient]::new($address.AddressFamily)
      $task = $client.ConnectAsync($address, $Port)
    }
    else {
      $client = New-Object Net.Sockets.TcpClient
      $task = $client.ConnectAsync($HostName, $Port)
    }
    if (-not $task.Wait($TimeoutMilliseconds)) { return 'timeout' }
    $null = $task.GetAwaiter().GetResult()
    return 'connected'
  }
  catch {
    $socketError = $_.Exception.GetBaseException()
    if ($socketError -is [Net.Sockets.SocketException]) { return $socketError.SocketErrorCode.ToString() }
    return 'error:' + $socketError.GetType().Name
  }
  finally { if ($client) { $client.Dispose() } }
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$loopbackPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$hostLoopbackBaseline = Test-TcpReachable '127.0.0.1' $loopbackPort
$externalNetworkHost = 'www.microsoft.com'
$ipv6BaselineTarget = '2606:4700:4700::1111'
$externalUri = [Uri]('https://' + $externalNetworkHost + '/')
$hostAddresses = @()
$hostDnsBaseline = $false
try {
  $hostAddresses = @([Net.Dns]::GetHostAddresses($externalNetworkHost))
  $hostDnsBaseline = $hostAddresses.Count -gt 0
}
catch { }
$hostIpv4 = $hostAddresses | Where-Object AddressFamily -eq ([Net.Sockets.AddressFamily]::InterNetwork) | Select-Object -First 1
$hostIpv6 = $hostAddresses | Where-Object AddressFamily -eq ([Net.Sockets.AddressFamily]::InterNetworkV6) | Select-Object -First 1
$sandboxIpv6Target = if ($hostIpv6) { $hostIpv6.IPAddressToString } else { $ipv6BaselineTarget }
$hostExternalNetworkBaseline = Test-TcpReachable $externalNetworkHost 443 5000
$hostExternalIpv4Baseline = if ($hostIpv4) { Test-TcpReachable $hostIpv4.IPAddressToString 443 5000 } else { 'unavailable-no-ipv4-answer' }
$hostExternalIpv6Baseline = if ($hostIpv6) {
  Test-TcpReachable $hostIpv6.IPAddressToString 443 5000
}
else {
  # A fixed IPv6-only test address distinguishes a missing AAAA answer from an
  # unusable host IPv6 route. It is still only a connectivity probe, not a test
  # of arbitrary IPv6 egress policy.
  Test-TcpReachable $ipv6BaselineTarget 443 5000
}
$defaultProxy = [Net.WebRequest]::DefaultWebProxy
$effectiveProxyUri = $defaultProxy.GetProxy($externalUri)
$hostUsesSystemProxy = -not $defaultProxy.IsBypassed($externalUri)
$hostProxyHttpsBaseline = $null
if ($hostUsesSystemProxy) {
  try {
    $hostProxyResponse = Invoke-WebRequest -Uri $externalUri -Method Head -UseBasicParsing -TimeoutSec 8
    $hostProxyHttpsBaseline = [int]$hostProxyResponse.StatusCode -lt 400
  }
  catch { $hostProxyHttpsBaseline = $false }
}
$hostNodeProxyBaseline = $null
if ($hostUsesSystemProxy) {
  $proxyProbe = "fetch('https://www.microsoft.com/',{method:'HEAD',signal:AbortSignal.timeout(8000)}).then(r=>{process.stdout.write('status='+r.status);process.exitCode=r.status<400?0:3}).catch(e=>{process.stdout.write('error='+((e.cause&&e.cause.code)||e.name));process.exitCode=4})"
  $originalHttpProxy = [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process')
  $originalHttpsProxy = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', $effectiveProxyUri.AbsoluteUri, 'Process')
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $effectiveProxyUri.AbsoluteUri, 'Process')
    $hostNodeProxyOutput = @(& $nodeExe --use-env-proxy -e $proxyProbe 2>&1)
    $hostNodeProxyBaseline = ($LASTEXITCODE -eq 0 -and ($hostNodeProxyOutput -join '') -match '^status=\d+$')
  }
  catch { $hostNodeProxyBaseline = $false }
  finally {
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', $originalHttpProxy, 'Process')
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $originalHttpsProxy, 'Process')
  }
}

function New-Request(
  [string]$Name,
  [string]$Executable,
  [string[]]$Arguments,
  [int]$TimeoutMilliseconds,
  [string]$Specification,
  [string]$CurrentDirectory
) {
  if (-not $Specification) { $Specification = $script:specificationPath }
  if (-not $CurrentDirectory) { $CurrentDirectory = $script:workspaceRoot }
  $identity = 'LSWindowsPoc_' + [Guid]::NewGuid().ToString('N')
  $requestPath = Join-Path $script:controlRoot ($Name + '.request.json')
  $launchPath = Join-Path $script:controlRoot ($Name + '.launch.json')
  $resultPath = Join-Path $script:controlRoot ($Name + '.result.json')
  $errorPath = Join-Path $script:controlRoot ($Name + '.error.json')
  $request = [ordered]@{
    action = 'run'
    workspace = $script:workspaceRoot
    currentDirectory = $CurrentDirectory
    executable = $Executable
    arguments = @($Arguments)
    identity = $identity
    specificationPath = $Specification
    launchMarkerPath = $launchPath
    resultPath = $resultPath
    errorPath = $errorPath
    pathValue = $script:pathValue
    modulePathValue = $script:modulePathValue
    timeoutMilliseconds = $TimeoutMilliseconds
  }
  [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 4))
  return [pscustomobject]@{
    Name = $Name
    Identity = $identity
    RequestPath = $requestPath
    LaunchPath = $launchPath
    ResultPath = $resultPath
    ErrorPath = $errorPath
  }
}

function Start-Runner($Request, [switch]$Wait) {
  $quotedRunner = '"{0}"' -f $script:runnerScript
  $quotedRequest = '"{0}"' -f $Request.RequestPath
  $argumentLine = "-NoProfile -ExecutionPolicy Bypass -File $quotedRunner -RequestPath $quotedRequest"
  $stdout = Join-Path $script:controlRoot ($Request.Name + '.stdout.log')
  $stderr = Join-Path $script:controlRoot ($Request.Name + '.stderr.log')
  if ($Wait) {
    return Start-Process -FilePath $script:powershellExe -ArgumentList $argumentLine -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  }
  return Start-Process -FilePath $script:powershellExe -ArgumentList $argumentLine -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

function Wait-ForFile([string]$Path, [int]$TimeoutMilliseconds = 10000) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    if (Test-Path -LiteralPath $Path) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return (Test-Path -LiteralPath $Path)
}

function Get-ProcessAlive([int]$ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

$results = [ordered]@{
  filesystem = [ordered]@{}
  execution = [ordered]@{}
  network = [ordered]@{}
  childProcess = [ordered]@{}
  termination = [ordered]@{}
  initialization = [ordered]@{}
}
$capturedErrors = [ordered]@{}
$testScriptPath = Join-Path $workspaceRoot 'probe.ps1'
$nodeProbePath = Join-Path $workspaceRoot 'probe-node.mjs'
$nodeResultPath = Join-Path $workspaceRoot 'node-results.json'
$powershellStartedPath = Join-Path $workspaceRoot 'powershell-payload-started.txt'
$nodeStartedPath = Join-Path $workspaceRoot 'node-payload-started.txt'
$timeoutPidPath = Join-Path $workspaceRoot 'timeout-child.pid'
$cancelPidPath = Join-Path $workspaceRoot 'cancel-child.pid'

$nodeProbe = @'
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const [workspace, outsideFile, outsideWrite, junctionPath, symlinkPath, hardLinkPath, protectedFile, profileGitConfig, profilePowerShellHistory, host, ipv4, ipv6, externalPortText, loopbackPortText, reportPath, startedMarker] = process.argv.slice(1);
const report = {};
fs.writeFileSync(startedMarker, 'started');
function inspectCurrentDirectory() {
  const observations = [];
  try {
    let candidate = process.cwd();
    for (let depth = 0; depth < 6 && candidate; depth += 1) {
      const observation = { depth, stat: false, list: false, realpath: false };
      try { fs.statSync(candidate); observation.stat = true; } catch (error) { observation.statError = error.code; }
      try { fs.readdirSync(candidate); observation.list = true; } catch (error) { observation.listError = error.code; }
      try { fs.realpathSync(candidate); observation.realpath = true; } catch (error) { observation.realpathError = error.code; }
      observations.push(observation);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    return { cwdApiSucceeded: true, relativePathPresent: process.env.PWD === process.cwd(), observations };
  } catch (error) { return { cwdApiSucceeded: false, code: error.code || error.name, observations }; }
}
report.currentDirectory = inspectCurrentDirectory();
function readBlocked(target) {
  try { fs.readFileSync(target, 'utf8'); return { blocked: false }; }
  catch (error) { return { blocked: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code), code: error.code }; }
}
function writeBlocked(target) {
  try { fs.writeFileSync(target, 'sandbox-outside-write-probe', { flag: 'wx' }); fs.unlinkSync(target); return { blocked: false }; }
  catch (error) { return { blocked: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code), code: error.code }; }
}
function writeHandleBlocked(target) {
  try { const handle = fs.openSync(target, 'r+'); fs.closeSync(handle); return { blocked: false }; }
  catch (error) { return { blocked: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code), code: error.code }; }
}
function existingWriteBlocked(target) {
  try { fs.writeFileSync(target, 'sandbox-hardlink-write-probe'); return { blocked: false }; }
  catch (error) { return { blocked: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code), code: error.code }; }
}
function connectResult(target, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target, port: Number(port) });
    const timer = setTimeout(() => { socket.destroy(); resolve({ connected: false, code: 'timeout' }); }, 1800);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ connected: true }); });
    socket.once('error', (error) => { clearTimeout(timer); resolve({ connected: false, code: error.code }); });
  });
}
async function resolveResult(target) {
  try {
    const addresses = await dns.lookup(target, { all: true, verbatim: true });
    return { resolved: addresses.length > 0, ipv4Count: addresses.filter(({ family }) => family === 4).length, ipv6Count: addresses.filter(({ family }) => family === 6).length };
  } catch (error) { return { resolved: false, code: error.code || error.name }; }
}
async function proxyHttpsResult() {
  if (!process.env.HTTPS_PROXY) return { tested: false, connected: null, code: 'proxy-not-configured' };
  try {
    const response = await fetch('https://www.microsoft.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return { tested: true, connected: response.status < 400, status: response.status };
  } catch (error) { return { tested: true, connected: false, code: (error.cause && error.cause.code) || error.name }; }
}
try { report.workspaceRead = fs.readFileSync(path.join(workspace, 'workspace-readable.txt'), 'utf8') === 'workspace-readable-sentinel'; }
catch (error) { report.workspaceRead = false; report.workspaceReadError = error.code; }
try { fs.writeFileSync(path.join(workspace, 'node-write.txt'), 'node-write-ok'); report.workspaceWrite = fs.readFileSync(path.join(workspace, 'node-write.txt'), 'utf8') === 'node-write-ok'; }
catch (error) { report.workspaceWrite = false; report.workspaceWriteError = error.code; }
report.outsideRead = readBlocked(outsideFile);
report.outsideWrite = writeBlocked(outsideWrite);
report.traversalRead = readBlocked(path.resolve(workspace, '..', 'outside', 'host-secret.txt'));
report.junctionRead = junctionPath !== '__unavailable__' ? readBlocked(path.join(junctionPath, 'host-secret.txt')) : { blocked: null, code: 'junction-unavailable' };
report.symlinkRead = symlinkPath !== '__unavailable__' ? readBlocked(symlinkPath) : { blocked: null, code: 'symlink-unavailable' };
report.hardLinkRead = hardLinkPath !== '__unavailable__' ? readBlocked(hardLinkPath) : { blocked: null, code: 'hardlink-unavailable' };
report.hardLinkWrite = hardLinkPath !== '__unavailable__' ? existingWriteBlocked(hardLinkPath) : { blocked: null, code: 'hardlink-unavailable' };
report.protectedWriteHandle = writeHandleBlocked(protectedFile);
report.profileGitConfigRead = profileGitConfig !== '__unavailable__' ? readBlocked(profileGitConfig) : { blocked: null, code: 'file-unavailable' };
report.profilePowerShellHistoryRead = profilePowerShellHistory !== '__unavailable__' ? readBlocked(profilePowerShellHistory) : { blocked: null, code: 'file-unavailable' };
report.externalNetwork = await connectResult(host, externalPortText);
report.externalDns = await resolveResult(host);
report.externalIpv4 = ipv4 !== '__unavailable__' ? await connectResult(ipv4, externalPortText) : { connected: false, code: 'ipv4-unavailable' };
report.externalIpv6 = ipv6 !== '__unavailable__' ? await connectResult(ipv6, externalPortText) : { connected: false, code: 'ipv6-unavailable' };
report.systemProxyHttps = await proxyHttpsResult();
report.loopbackNetwork = await connectResult('127.0.0.1', loopbackPortText);
fs.writeFileSync(reportPath, JSON.stringify(report));
if (!report.workspaceRead || !report.workspaceWrite || !report.outsideRead.blocked || !report.outsideWrite.blocked || !report.traversalRead.blocked || !report.junctionRead.blocked || !report.hardLinkRead.blocked || !report.hardLinkWrite.blocked || !report.protectedWriteHandle.blocked) process.exitCode = 20;
'@ -replace "`r", ''
$nodeProbeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeProbe))

$psProbe = @'
param([string]$Workspace, [string]$OutsideFile, [string]$OutsideWrite, [string]$JunctionPath, [string]$SymlinkPath, [string]$HardLinkPath, [string]$ProtectedFile, [string]$ProfileGitConfig, [string]$ProfilePowerShellHistory, [string]$NodeExe, [string]$NodeProbeBase64, [string]$NodeReport, [string]$NetworkHost, [string]$NetworkIPv4, [string]$NetworkIPv6, [int]$ExternalPort, [int]$LoopbackPort, [string]$StartedMarker)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($StartedMarker, 'started')
trap {
  try { [IO.File]::WriteAllText((Join-Path $Workspace 'powershell-probe-error.txt'), ($_ | Out-String)) }
  catch { }
  exit 91
}
$result = [ordered]@{}
$cwdObservations = @()
try {
  $cwdPath = [Environment]::CurrentDirectory
  $candidate = $cwdPath
  for ($depth = 0; $depth -lt 6 -and $candidate; $depth++) {
    $metadata = $false
    $listed = $false
    try { [void][IO.Directory]::GetLastWriteTimeUtc($candidate); $metadata = $true } catch { }
    try { [void][IO.Directory]::GetFileSystemEntries($candidate); $listed = $true } catch { }
    $cwdObservations += @{ depth = $depth; metadata = $metadata; list = $listed }
    $parent = [IO.Directory]::GetParent($candidate)
    if (-not $parent -or $parent.FullName -eq $candidate) { break }
    $candidate = $parent.FullName
  }
  $result.currentDirectory = @{ cwdApiSucceeded = $true; relativePathPresent = ($env:PWD -eq $cwdPath); observations = $cwdObservations }
}
catch { $result.currentDirectory = @{ cwdApiSucceeded = $false; code = $_.Exception.GetBaseException().GetType().Name; observations = $cwdObservations } }
function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}
function Test-ReadBlocked([string]$Path) {
  try { [void][IO.File]::ReadAllText($Path); return @{ blocked = $false } }
  catch { $exception = $_.Exception.GetBaseException(); $code = $exception.HResult -band 0xffff; $denied = ($code -in @(2, 3, 5, 32)) -or ($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException]); return @{ blocked = $denied; code = ('0x{0:X8}' -f $exception.HResult); errorType = $exception.GetType().FullName } }
}
function Test-OptionalRead([string]$Path) {
  if ($Path -eq '__unavailable__') { return @{ blocked = $null; code = 'file-unavailable' } }
  return Test-ReadBlocked $Path
}
function Test-WriteBlocked([string]$Path) {
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Dispose()
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return @{ blocked = $false }
  }
  catch { $exception = $_.Exception.GetBaseException(); $code = $exception.HResult -band 0xffff; $denied = ($code -in @(2, 3, 5, 32)) -or ($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException]); return @{ blocked = $denied; code = ('0x{0:X8}' -f $exception.HResult); errorType = $exception.GetType().FullName } }
}
function Test-WriteHandleBlocked([string]$Path) {
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $stream.Dispose()
    return @{ blocked = $false }
  }
  catch { $exception = $_.Exception.GetBaseException(); $code = $exception.HResult -band 0xffff; $denied = ($code -in @(2, 3, 5, 32)) -or ($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException]); return @{ blocked = $denied; code = ('0x{0:X8}' -f $exception.HResult); errorType = $exception.GetType().FullName } }
}
function Test-ExistingWriteBlocked([string]$Path) {
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $bytes = [Text.Encoding]::UTF8.GetBytes('sandbox-hardlink-write-probe')
    $stream.SetLength(0)
    $stream.Write($bytes, 0, $bytes.Length)
    return @{ blocked = $false }
  }
  catch { $exception = $_.Exception.GetBaseException(); $code = $exception.HResult -band 0xffff; $denied = ($code -in @(2, 3, 5, 32)) -or ($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException]); return @{ blocked = $denied; code = ('0x{0:X8}' -f $exception.HResult); errorType = $exception.GetType().FullName } }
  finally { if ($stream) { $stream.Dispose() } }
}
function Test-Connect([string]$HostName, [int]$Port) {
  $client = $null
  try {
    $address = $null
    if ([Net.IPAddress]::TryParse($HostName, [ref]$address)) {
      $client = [Net.Sockets.TcpClient]::new($address.AddressFamily)
      $task = $client.ConnectAsync($address, $Port)
    }
    else {
      $client = New-Object Net.Sockets.TcpClient
      $task = $client.ConnectAsync($HostName, $Port)
    }
    if (-not $task.Wait(1800)) { return @{ connected = $false; code = 'timeout' } }
    $null = $task.GetAwaiter().GetResult()
    return @{ connected = $true }
  }
  catch {
    $socketError = $_.Exception.GetBaseException()
    if ($socketError -is [Net.Sockets.SocketException]) { return @{ connected = $false; code = $socketError.SocketErrorCode.ToString() } }
    return @{ connected = $false; code = $socketError.GetType().Name }
  }
  finally { if ($client) { $client.Dispose() } }
}
function Test-Dns([string]$HostName) {
  try {
    $addresses = @([Net.Dns]::GetHostAddresses($HostName))
    $ipv4Count = @($addresses | Where-Object AddressFamily -eq ([Net.Sockets.AddressFamily]::InterNetwork)).Count
    $ipv6Count = @($addresses | Where-Object AddressFamily -eq ([Net.Sockets.AddressFamily]::InterNetworkV6)).Count
    return @{ resolved = ($addresses.Count -gt 0); ipv4Count = $ipv4Count; ipv6Count = $ipv6Count }
  }
  catch { return @{ resolved = $false; code = $_.Exception.GetBaseException().GetType().Name } }
}
function Test-SystemProxyHttps([bool]$Configured) {
  if (-not $Configured) { return @{ tested = $false; connected = $null; code = 'proxy-not-configured' } }
  try {
    $response = Invoke-WebRequest -Uri ('https://' + $NetworkHost + '/') -Method Head -UseBasicParsing -TimeoutSec 5
    return @{ tested = $true; connected = ([int]$response.StatusCode -lt 400); status = [int]$response.StatusCode }
  }
  catch { return @{ tested = $true; connected = $false; code = $_.Exception.GetBaseException().GetType().Name } }
}
$result.workspaceRead = [IO.File]::ReadAllText((Join-Path $Workspace 'workspace-readable.txt')) -eq 'workspace-readable-sentinel'
[IO.File]::WriteAllText((Join-Path $Workspace 'powershell-write.txt'), 'powershell-write-ok')
$result.workspaceWrite = [IO.File]::ReadAllText((Join-Path $Workspace 'powershell-write.txt')) -eq 'powershell-write-ok'
$result.outsideRead = Test-ReadBlocked $OutsideFile
$result.outsideWrite = Test-WriteBlocked $OutsideWrite
$result.traversalRead = Test-ReadBlocked ([IO.Path]::GetFullPath((Join-Path $Workspace '..\outside\host-secret.txt')))
$result.junctionRead = if ($JunctionPath -ne '__unavailable__') { Test-ReadBlocked (Join-Path $JunctionPath 'host-secret.txt') } else { @{ blocked = $null; code = 'junction-unavailable' } }
$result.symlinkRead = if ($SymlinkPath -ne '__unavailable__') { Test-ReadBlocked $SymlinkPath } else { @{ blocked = $null; code = 'symlink-unavailable' } }
$result.hardLinkRead = if ($HardLinkPath -ne '__unavailable__') { Test-ReadBlocked $HardLinkPath } else { @{ blocked = $null; code = 'hardlink-unavailable' } }
$result.hardLinkWrite = if ($HardLinkPath -ne '__unavailable__') { Test-ExistingWriteBlocked $HardLinkPath } else { @{ blocked = $null; code = 'hardlink-unavailable' } }
$result.protectedWriteHandle = Test-WriteHandleBlocked $ProtectedFile
$result.profileGitConfigRead = Test-OptionalRead $ProfileGitConfig
$result.profilePowerShellHistoryRead = Test-OptionalRead $ProfilePowerShellHistory
$result.externalNetwork = Test-Connect $NetworkHost $ExternalPort
$result.externalDns = Test-Dns $NetworkHost
$result.externalIpv4 = if ($NetworkIPv4 -ne '__unavailable__') { Test-Connect $NetworkIPv4 $ExternalPort } else { @{ connected = $false; code = 'ipv4-unavailable' } }
$result.externalIpv6 = if ($NetworkIPv6 -ne '__unavailable__') { Test-Connect $NetworkIPv6 $ExternalPort } else { @{ connected = $false; code = 'ipv6-unavailable' } }
$externalUri = [Uri]('https://' + $NetworkHost + '/')
$systemProxy = [Net.WebRequest]::DefaultWebProxy
$systemProxyConfigured = -not $systemProxy.IsBypassed($externalUri)
$effectiveProxyUri = $systemProxy.GetProxy($externalUri)
$result.systemProxyConfigured = $systemProxyConfigured
$result.systemProxyHttps = Test-SystemProxyHttps $systemProxyConfigured
$result.loopbackNetwork = Test-Connect '127.0.0.1' $LoopbackPort
$nodeStartInfo = New-Object Diagnostics.ProcessStartInfo
$nodeStartInfo.FileName = $NodeExe
$nodeEvalCode = "const source=Buffer.from('$NodeProbeBase64','base64').toString('utf8');const run=new Function('require','process','Buffer','return (async()=>{' + source + '})();');run(require,process,Buffer).catch(error=>{require('node:fs').writeFileSync(process.argv[15],JSON.stringify({fatal:error.stack||error.message}));process.exitCode=30;});"
$nodeArguments = @('-e', $nodeEvalCode, $Workspace, $OutsideFile, $OutsideWrite, $JunctionPath, $SymlinkPath, $HardLinkPath, $ProtectedFile, $ProfileGitConfig, $ProfilePowerShellHistory, $NetworkHost, $NetworkIPv4, $NetworkIPv6, [string]$ExternalPort, [string]$LoopbackPort, $NodeReport, $StartedMarker.Replace('powershell-payload-started.txt', 'node-payload-started.txt'))
$nodeStartInfo.Arguments = (($nodeArguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join ' ')
$nodeStartInfo.Arguments = '--use-env-proxy ' + $nodeStartInfo.Arguments
$nodeStartInfo.EnvironmentVariables['HTTP_PROXY'] = if ($systemProxyConfigured) { $effectiveProxyUri.AbsoluteUri } else { '' }
$nodeStartInfo.EnvironmentVariables['HTTPS_PROXY'] = if ($systemProxyConfigured) { $effectiveProxyUri.AbsoluteUri } else { '' }
$nodeStartInfo.WorkingDirectory = $Workspace
$nodeStartInfo.UseShellExecute = $false
$nodeStartInfo.CreateNoWindow = $true
$nodeProcess = [Diagnostics.Process]::Start($nodeStartInfo)
try { $nodeProcess.WaitForExit(); $result.nodeExitCode = $nodeProcess.ExitCode }
finally { $nodeProcess.Dispose() }
$result.node = if (Test-Path -LiteralPath $NodeReport) { Get-Content -LiteralPath $NodeReport -Raw | ConvertFrom-Json } else { $null }
[IO.File]::WriteAllText((Join-Path $Workspace 'powershell-results.json'), ($result | ConvertTo-Json -Depth 8 -Compress))
if (-not $result.workspaceRead -or -not $result.workspaceWrite -or -not $result.outsideRead.blocked -or -not $result.outsideWrite.blocked -or -not $result.traversalRead.blocked -or -not $result.junctionRead.blocked -or -not $result.hardLinkRead.blocked -or -not $result.hardLinkWrite.blocked -or -not $result.protectedWriteHandle.blocked -or $result.nodeExitCode -ne 0) { exit 20 }
exit 0
'@ -replace "`r", ''

[IO.File]::WriteAllText($nodeProbePath, $nodeProbe)
[IO.File]::WriteAllText($testScriptPath, $psProbe)
$probeTokens = $null
$probeErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($testScriptPath, [ref]$probeTokens, [ref]$probeErrors) | Out-Null
if ($probeErrors.Count -gt 0) { throw "Generated PowerShell probe does not parse: $($probeErrors[0].Message)" }
$nodeCheck = & $nodeExe --check $nodeProbePath 2>&1
if ($LASTEXITCODE -ne 0) { throw "Generated Node.js probe does not parse: $nodeCheck" }
$systemPowerShellArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $testScriptPath,
  $workspaceRoot, $outsideSecret, $outsideWrite, $(if ($junctionCreated) { $junctionPath } else { '__unavailable__' }),
  $(if ($symlinkCreated) { $symlinkPath } else { '__unavailable__' }), $(if ($hardLinkCreated) { $hardLinkPath } else { '__unavailable__' }),
  $protectedSource, $profileGitConfig, $profilePowerShellHistory, $nodeExe, $nodeProbeBase64,
  $nodeResultPath, $externalNetworkHost, $(if ($hostIpv4) { $hostIpv4.IPAddressToString } else { '__unavailable__' }),
  $sandboxIpv6Target, 443, $loopbackPort, $powershellStartedPath)
$shellRequest = New-Request 'shell-files-and-network' $powershellExe $systemPowerShellArguments 30000 ''
$shellWorker = Start-Runner $shellRequest -Wait
Write-ProbeProgress 'shell-probe-finished'
$shellResultsPath = Join-Path $workspaceRoot 'powershell-results.json'
if (Test-Path -LiteralPath $shellResultsPath) { $shellResults = Get-Content -LiteralPath $shellResultsPath -Raw | ConvertFrom-Json }
else {
  $shellResults = $null
  if (Test-Path -LiteralPath $shellRequest.ErrorPath) { $capturedErrors.shell = Get-Content -LiteralPath $shellRequest.ErrorPath -Raw | ConvertFrom-Json }
}

$results.filesystem.workspaceRead = [bool]($shellResults -and $shellResults.workspaceRead -and $shellResults.node.workspaceRead)
$results.filesystem.workspaceWrite = [bool]($shellResults -and $shellResults.workspaceWrite -and $shellResults.node.workspaceWrite)
$results.filesystem.outsideReadDenied = [bool]($shellResults -and $shellResults.outsideRead.blocked -and $shellResults.node.outsideRead.blocked)
$results.filesystem.outsideWriteDenied = [bool]($shellResults -and $shellResults.outsideWrite.blocked -and $shellResults.node.outsideWrite.blocked)
$results.filesystem.pathTraversalDenied = [bool]($shellResults -and $shellResults.traversalRead.blocked -and $shellResults.node.traversalRead.blocked)
$results.filesystem.junctionDenied = [bool]($junctionCreated -and $shellResults -and $shellResults.junctionRead.blocked -and $shellResults.node.junctionRead.blocked)
$results.filesystem.symbolicLinkDenied = if ($symlinkCreated -and $shellResults) { [bool]($shellResults.symlinkRead.blocked -and $shellResults.node.symlinkRead.blocked) } else { $null }
$results.filesystem.hardLinkReadDenied = if ($hardLinkCreated -and $shellResults) { [bool]($shellResults.hardLinkRead.blocked -and $shellResults.node.hardLinkRead.blocked) } else { $null }
$results.filesystem.hardLinkWriteDenied = if ($hardLinkCreated -and $shellResults) { [bool]($shellResults.hardLinkWrite.blocked -and $shellResults.node.hardLinkWrite.blocked) } else { $null }
$results.filesystem.hardLinkTargetUnchanged = [IO.File]::ReadAllText($outsideSecret) -eq 'host-secret-sentinel'
$results.filesystem.protectedSourceWriteDenied = [bool]($shellResults -and $shellResults.protectedWriteHandle.blocked -and $shellResults.node.protectedWriteHandle.blocked)
$results.filesystem.profileGitConfigReadDenied = [bool]($shellResults -and $shellResults.profileGitConfigRead.blocked -and $shellResults.node.profileGitConfigRead.blocked)
$results.filesystem.profilePowerShellHistoryReadDenied = [bool]($shellResults -and $shellResults.profilePowerShellHistoryRead.blocked -and $shellResults.node.profilePowerShellHistoryRead.blocked)

$directoryRaceScriptPath = Join-Path $workspaceRoot 'directory-race.ps1'
$directoryRaceScript = @'
param([string]$Workspace, [string]$StartedPath, [string]$OutsideReadPath)
[IO.File]::WriteAllText($StartedPath, 'started')
$target = Join-Path $Workspace 'replaceable-directory\sentinel.txt'
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  try {
    if ([IO.File]::ReadAllText($target) -eq 'outside-race-sentinel') {
      [IO.File]::WriteAllText($OutsideReadPath, 'outside-target-read-through-replacement')
      exit 23
    }
  }
  catch { }
  Start-Sleep -Milliseconds 25
}
'@ -replace "`r", ''
[IO.File]::WriteAllText($directoryRaceScriptPath, $directoryRaceScript)
$raceTokens = $null
$raceErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($directoryRaceScriptPath, [ref]$raceTokens, [ref]$raceErrors) | Out-Null
if ($raceErrors.Count -gt 0) { throw "Generated directory-race probe does not parse: $($raceErrors[0].Message)" }
$directoryRaceRequest = New-Request 'directory-replacement-race' $powershellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $directoryRaceScriptPath, $workspaceRoot, $raceStartedPath, $raceOutsideReadPath) 8000 ''
$directoryRaceWorker = Start-Runner $directoryRaceRequest
$directoryRaceStarted = Wait-ForFile $raceStartedPath 5000
$directorySwapSucceeded = $false
$directorySwapError = $null
try {
  if ($directoryRaceStarted) {
    Move-Item -LiteralPath $raceDirectory -Destination $raceOriginalDirectory -ErrorAction Stop
    $raceJunctionCommand = '/d /c mklink /J "{0}" "{1}"' -f $raceDirectory, $outsideRaceDirectory
    & $env:ComSpec $raceJunctionCommand | Out-Null
    $directorySwapSucceeded = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $raceDirectory))
    if (-not $directorySwapSucceeded) { $directorySwapError = "junction replacement exit=$LASTEXITCODE" }
  }
  else { $directorySwapError = 'sandbox race payload did not start' }
  if (-not $directoryRaceWorker.HasExited) { $directoryRaceWorker.WaitForExit(10000) | Out-Null }
}
catch { $directorySwapError = $_.Exception.GetBaseException().GetType().Name }
finally {
  if (-not $directoryRaceWorker.HasExited) { Stop-Process -Id $directoryRaceWorker.Id -Force; $directoryRaceWorker.WaitForExit() }
  if (Test-Path -LiteralPath $raceDirectory) {
    $raceItem = Get-Item -LiteralPath $raceDirectory -Force
    if (($raceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      & $env:ComSpec ('/d /c rmdir "{0}"' -f $raceDirectory) | Out-Null
    }
  }
  if (Test-Path -LiteralPath $raceOriginalDirectory) { Move-Item -LiteralPath $raceOriginalDirectory -Destination $raceDirectory -ErrorAction Stop }
}
$results.filesystem.nestedDirectoryReplacementStarted = $directoryRaceStarted
$results.filesystem.nestedDirectorySwapSucceeded = $directorySwapSucceeded
$results.filesystem.nestedReplacementReadDenied = ($directorySwapSucceeded -and -not (Test-Path -LiteralPath $raceOutsideReadPath))
$results.filesystem.nestedDirectorySwapError = $directorySwapError
$results.filesystem.nestedDirectoryTargetUnchanged = [IO.File]::ReadAllText((Join-Path $outsideRaceDirectory 'sentinel.txt')) -eq 'outside-race-sentinel'

$results.execution.powershellPayloadStarted = Test-Path -LiteralPath $powershellStartedPath
$results.execution.nodePayloadStarted = Test-Path -LiteralPath $nodeStartedPath
$results.network.hostExternalBaseline = $hostExternalNetworkBaseline
$results.network.hostDnsBaseline = $hostDnsBaseline
$results.network.hostExternalIpv4Baseline = $hostExternalIpv4Baseline
$results.network.hostExternalIpv6Baseline = $hostExternalIpv6Baseline
$results.network.hostSystemProxyConfigured = $hostUsesSystemProxy
$results.network.hostSystemProxyHttpsBaseline = $hostProxyHttpsBaseline
$results.network.hostNodeProxyHttpsBaseline = $hostNodeProxyBaseline
$results.network.hostLoopbackBaseline = $hostLoopbackBaseline
$results.network.powershellExternalDenied = [bool]($shellResults -and -not $shellResults.externalNetwork.connected -and $shellResults.externalNetwork.code -notin @('timeout', 'ECONNREFUSED'))
$results.network.nodeExternalDenied = [bool]($shellResults -and $shellResults.node.externalNetwork -and -not $shellResults.node.externalNetwork.connected -and $shellResults.node.externalNetwork.code -notin @('timeout', 'ECONNREFUSED'))
$results.network.powershellIpv4Denied = [bool]($shellResults -and -not $shellResults.externalIpv4.connected -and $shellResults.externalIpv4.code -notin @('timeout', 'ECONNREFUSED'))
$results.network.nodeIpv4Denied = [bool]($shellResults -and $shellResults.node.externalIpv4 -and -not $shellResults.node.externalIpv4.connected -and $shellResults.node.externalIpv4.code -notin @('timeout', 'ECONNREFUSED'))
$results.network.powershellIpv6Denied = if ($hostExternalIpv6Baseline -eq 'connected') { [bool]($shellResults -and -not $shellResults.externalIpv6.connected -and $shellResults.externalIpv6.code -notin @('timeout', 'ECONNREFUSED')) } else { $null }
$results.network.nodeIpv6Denied = if ($hostExternalIpv6Baseline -eq 'connected') { [bool]($shellResults -and $shellResults.node.externalIpv6 -and -not $shellResults.node.externalIpv6.connected -and $shellResults.node.externalIpv6.code -notin @('timeout', 'ECONNREFUSED')) } else { $null }
$results.network.powershellDnsDenied = [bool]($shellResults -and -not $shellResults.externalDns.resolved)
$results.network.nodeDnsDenied = [bool]($shellResults -and $shellResults.node.externalDns -and -not $shellResults.node.externalDns.resolved)
$results.network.powershellSystemProxyBlocked = if ($hostUsesSystemProxy) { [bool]($shellResults -and $shellResults.systemProxyConfigured -and $shellResults.systemProxyHttps.tested -and -not $shellResults.systemProxyHttps.connected) } else { $null }
$results.network.nodeSystemProxyBlocked = if ($hostUsesSystemProxy) { [bool]($shellResults -and $shellResults.node.systemProxyHttps.tested -and -not $shellResults.node.systemProxyHttps.connected) } else { $null }
$results.network.powershellLoopbackDenied = [bool]($shellResults -and -not $shellResults.loopbackNetwork.connected -and $shellResults.loopbackNetwork.code -notin @('timeout', 'ECONNREFUSED'))
$results.network.nodeLoopbackDenied = [bool]($shellResults -and $shellResults.node.loopbackNetwork -and -not $shellResults.node.loopbackNetwork.connected -and $shellResults.node.loopbackNetwork.code -notin @('timeout', 'ECONNREFUSED'))
$results.childProcess.powershellLaunchedNode = Test-Path -LiteralPath $nodeStartedPath
$results.childProcess.nodeRestrictionsMatched = [bool]($results.filesystem.outsideReadDenied -and $results.filesystem.outsideWriteDenied -and $results.filesystem.hardLinkReadDenied -and $results.filesystem.hardLinkWriteDenied -and $results.network.nodeExternalDenied -and $results.network.nodeIpv4Denied -and $results.network.nodeDnsDenied)

$gitVersionRequest = New-Request 'git-version' $gitExe @('--version') 15000 '' $gitRoot
$gitVersionWorker = Start-Runner $gitVersionRequest -Wait
$gitVersionResult = if (Test-Path -LiteralPath $gitVersionRequest.ResultPath) { Get-Content -LiteralPath $gitVersionRequest.ResultPath -Raw | ConvertFrom-Json } else { $null }
$gitInitRequest = New-Request 'git-init' $gitExe @('init', '--quiet', (Join-Path $workspaceRoot 'git-fixture')) 15000 '' $workspaceRoot
$gitInitWorker = Start-Runner $gitInitRequest -Wait
$gitInitPassed = ($gitInitWorker.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $workspaceRoot 'git-fixture\.git')))
$gitInitRuntimeCwdRequest = New-Request 'git-init-runtime-cwd' $gitExe @('init', '--quiet', (Join-Path $workspaceRoot 'git-fixture-runtime-cwd')) 15000 '' $gitRoot
$gitInitRuntimeCwdWorker = Start-Runner $gitInitRuntimeCwdRequest -Wait
$gitInitSystemCwdRequest = New-Request 'git-init-system-cwd' $gitExe @('init', '--quiet', (Join-Path $workspaceRoot 'git-fixture-system-cwd')) 15000 '' $windowsSystem
$gitInitSystemCwdWorker = Start-Runner $gitInitSystemCwdRequest -Wait
$gitHostSeededFixture = $false
Push-Location $workspaceRoot
try {
  & $gitExe -c safe.directory='*' init --quiet (Join-Path $workspaceRoot 'git-fixture')
  $gitHostSeededFixture = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $workspaceRoot 'git-fixture\.git')))
}
finally { Pop-Location }
$gitStatusRequest = New-Request 'git-status' $gitExe @('-C', (Join-Path $workspaceRoot 'git-fixture'), 'status', '--short') 15000 '' $workspaceRoot
$gitStatusWorker = Start-Runner $gitStatusRequest -Wait
$gitStatusRuntimeCwdRequest = New-Request 'git-status-runtime-cwd' $gitExe @('-C', (Join-Path $workspaceRoot 'git-fixture'), 'status', '--short') 15000 '' $gitRoot
$gitStatusRuntimeCwdWorker = Start-Runner $gitStatusRuntimeCwdRequest -Wait

$cwdProbeSource = @'
const fs = require('node:fs');
const path = require('node:path');
const output = process.argv[1];
const observations = [];
try {
  let candidate = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const row = { depth, stat: false, list: false, realpath: false };
    try { fs.statSync(candidate); row.stat = true; } catch (error) { row.statError = error.code; }
    try { fs.readdirSync(candidate); row.list = true; } catch (error) { row.listError = error.code; }
    try { fs.realpathSync(candidate); row.realpath = true; } catch (error) { row.realpathError = error.code; }
    observations.push(row);
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  fs.writeFileSync(output, JSON.stringify({ cwdApiSucceeded: true, cwd: process.cwd(), observations }));
} catch (error) {
  try { fs.writeFileSync(output, JSON.stringify({ cwdApiSucceeded: false, code: error.code || error.name, observations })); } catch { }
  process.exitCode = 21;
}
'@ -replace "`r", ''
$cwdProbeResults = [ordered]@{}
foreach ($cwdTest in @(
  @{ Name = 'workspace'; Path = $workspaceRoot },
  @{ Name = 'git-runtime'; Path = $gitRoot },
  @{ Name = 'windows-system'; Path = $windowsSystem }
)) {
  $cwdReportPath = Join-Path $workspaceRoot ('cwd-' + $cwdTest.Name + '.json')
  $cwdRequest = New-Request ('cwd-' + $cwdTest.Name) $nodeExe @('-e', $cwdProbeSource, $cwdReportPath) 10000 '' $cwdTest.Path
  $cwdWorker = Start-Runner $cwdRequest -Wait
  $cwdProbeResults[$cwdTest.Name] = if (Test-Path -LiteralPath $cwdReportPath) {
    Get-Content $cwdReportPath -Raw | ConvertFrom-Json
  }
  else {
    $cwdError = if (Test-Path -LiteralPath $cwdRequest.ErrorPath) { Get-Content $cwdRequest.ErrorPath -Raw | ConvertFrom-Json } else { $null }
    @{ exitCode = $cwdWorker.ExitCode; reportMissing = $true; sandboxError = if ($cwdError) { $cwdError.error } else { $null } }
  }
}
Write-ProbeProgress 'git-probes-finished'
$results.childProcess.gitVersion = [bool]($gitVersionWorker.ExitCode -eq 0 -and $gitVersionResult -and $gitVersionResult.exitCode -eq 0)
$results.childProcess.gitInit = $gitInitPassed
$results.childProcess.gitStatus = ($gitStatusWorker.ExitCode -eq 0)
$results.childProcess.gitInitRuntimeCwd = ($gitInitRuntimeCwdWorker.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $workspaceRoot 'git-fixture-runtime-cwd\.git')))
$results.childProcess.gitInitSystemCwd = ($gitInitSystemCwdWorker.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $workspaceRoot 'git-fixture-system-cwd\.git')))
$results.childProcess.gitHostSeededFixture = $gitHostSeededFixture
$results.childProcess.gitStatusRuntimeCwd = ($gitStatusRuntimeCwdWorker.ExitCode -eq 0)
$results.childProcess.gitWorkingDirectoryDiagnostics = $cwdProbeResults

$timeoutProbe = @'
param([string]$NodeExe, [string]$PidPath, [string]$ErrorPath)
trap {
  try { [IO.File]::WriteAllText($ErrorPath, ($_.Exception.GetType().FullName + ':' + ('0x{0:X8}' -f $_.Exception.HResult))) }
  catch { }
  exit 92
}
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = $NodeExe
$nodeScript = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)"
function Quote-Argument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}
$startInfo.Arguments = '-e ' + (Quote-Argument $nodeScript) + ' ' + (Quote-Argument $PidPath)
$startInfo.WorkingDirectory = Split-Path -Parent $PidPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$child = [Diagnostics.Process]::Start($startInfo)
try { $child.WaitForExit(); exit $child.ExitCode }
finally { $child.Dispose() }
'@ -replace "`r", ''
$timeoutScriptPath = Join-Path $workspaceRoot 'timeout.ps1'
[IO.File]::WriteAllText($timeoutScriptPath, $timeoutProbe)
$timeoutTokens = $null
$timeoutErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($timeoutScriptPath, [ref]$timeoutTokens, [ref]$timeoutErrors) | Out-Null
if ($timeoutErrors.Count -gt 0) { throw "Generated timeout PowerShell probe does not parse: $($timeoutErrors[0].Message)" }
$timeoutErrorPath = Join-Path $workspaceRoot 'timeout-child.error.txt'
$timeoutRequest = New-Request 'timeout-child' $powershellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $timeoutScriptPath, $nodeExe, $timeoutPidPath, $timeoutErrorPath) 2500 ''
$timeoutWorker = Start-Runner $timeoutRequest -Wait
$timeoutChildPid = if (Test-Path -LiteralPath $timeoutPidPath) { [int](Get-Content -LiteralPath $timeoutPidPath -Raw) } else { 0 }
$timeoutResult = if (Test-Path -LiteralPath $timeoutRequest.ResultPath) { Get-Content -LiteralPath $timeoutRequest.ResultPath -Raw | ConvertFrom-Json } else { $null }
Write-ProbeProgress 'timeout-probe-finished'
$timeoutTargetWasRunning = ($timeoutResult -and $timeoutResult.rootWaitBeforeTermination -eq 258 -and $timeoutResult.rootExitCodeBeforeTermination -eq 259)
$results.termination.timeoutObserved = ($timeoutWorker.ExitCode -eq 124 -and $timeoutTargetWasRunning -and $timeoutChildPid -gt 0)
$results.termination.timeoutTreeTerminated = ($results.termination.timeoutObserved -and -not (Get-ProcessAlive $timeoutChildPid) -and $timeoutResult.treeTerminated)

$cancelScriptPath = Join-Path $workspaceRoot 'cancel.ps1'
[IO.File]::WriteAllText($cancelScriptPath, $timeoutProbe)
$cancelErrorPath = Join-Path $workspaceRoot 'cancel-child.error.txt'
$cancelRequest = New-Request 'cancel-child' $powershellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $cancelScriptPath, $nodeExe, $cancelPidPath, $cancelErrorPath) 120000 ''
$cancelWorker = Start-Runner $cancelRequest
$cancelLaunched = Wait-ForFile $cancelRequest.LaunchPath
$cancelChildLaunched = Wait-ForFile $cancelPidPath
$cancelChildPid = if ($cancelChildLaunched) { [int](Get-Content -LiteralPath $cancelPidPath -Raw) } else { 0 }
$cancelLaunch = if ($cancelLaunched) { Get-Content -LiteralPath $cancelRequest.LaunchPath -Raw | ConvertFrom-Json } else { $null }
$cancelRootWasAlive = [bool]($cancelLaunch -and (Get-ProcessAlive ([int]$cancelLaunch.processId)))
$replacementBlocked = $false
if ($cancelLaunched) {
  $replacementPath = Join-Path $evidenceRoot 'workspace-replaced'
  try {
    Move-Item -LiteralPath $workspaceRoot -Destination $replacementPath -ErrorAction Stop
  }
  catch { $replacementBlocked = $true }
  if (Test-Path -LiteralPath $replacementPath) {
    Move-Item -LiteralPath $replacementPath -Destination $workspaceRoot -ErrorAction Stop
  }
}
if (-not $cancelWorker.HasExited) { Stop-Process -Id $cancelWorker.Id -Force }
$cancelWorker.WaitForExit()
$cancelCleanupWatch = [Diagnostics.Stopwatch]::StartNew()
while ($cancelChildPid -gt 0 -and (Get-ProcessAlive $cancelChildPid) -and $cancelCleanupWatch.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 50 }
$cancelChildStopped = ($cancelChildPid -gt 0 -and -not (Get-ProcessAlive $cancelChildPid))
$cleanupRequestPath = Join-Path $controlRoot 'cancel-profile-cleanup.request.json'
[IO.File]::WriteAllText($cleanupRequestPath, (@{ action = 'delete-profile'; identity = $cancelRequest.Identity } | ConvertTo-Json -Compress))
$cleanupRequest = [pscustomobject]@{ Name = 'cancel-profile-cleanup'; RequestPath = $cleanupRequestPath }
$cleanupWorker = Start-Runner $cleanupRequest -Wait
Write-ProbeProgress 'cancellation-and-cleanup-finished'
$results.termination.hostCancellationObserved = $cancelLaunched
$results.termination.hostCancellationTreeTerminated = $cancelChildStopped
$results.termination.timeoutDescendantStarted = $timeoutChildPid -gt 0
$results.termination.cancellationDescendantStarted = $cancelChildPid -gt 0
$results.filesystem.directoryReplacementBlocked = $replacementBlocked
$listener.Stop()

$badSpecPath = Join-Path $controlRoot 'invalid-spec.bin'
[IO.File]::WriteAllBytes($badSpecPath, [byte[]](0x01, 0x02, 0x03, 0x04))
$badPayloadMarker = Join-Path $workspaceRoot 'invalid-spec-payload-ran.txt'
$badSpecScriptPath = Join-Path $workspaceRoot 'invalid-spec.ps1'
[IO.File]::WriteAllText($badSpecScriptPath, "[IO.File]::WriteAllText('$badPayloadMarker', 'ran')")
$badSpecRequest = New-Request 'invalid-spec' $powershellExe @('-NoProfile', '-File', $badSpecScriptPath) 10000 $badSpecPath
$badSpecWorker = Start-Runner $badSpecRequest -Wait
Write-ProbeProgress 'invalid-spec-probe-finished'
$results.initialization.invalidSpecificationRefused = ($badSpecWorker.ExitCode -eq 70 -and -not (Test-Path -LiteralPath $badSpecRequest.LaunchPath) -and -not (Test-Path -LiteralPath $badPayloadMarker))
$results.initialization.noHostFallback = -not (Test-Path -LiteralPath $badPayloadMarker)

$os = Get-CimInstance Win32_OperatingSystem
$computerSystem = Get-CimInstance Win32_ComputerSystem
Write-ProbeProgress 'host-facts-finished'
$apiAvailable = $false
$apiReason = 'processmodel API probe was not run'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'SandboxProcessApi.cs') -ErrorAction Stop
  $apiAvailable = [LsWindowsSandboxProcess]::ApiAvailable([ref]$apiReason)
}
catch { $apiReason = $_.Exception.Message }
Write-ProbeProgress 'api-probe-finished'
$report = [ordered]@{
  generatedAt = [DateTime]::UtcNow.ToString('o')
  backendId = 'windows-processmodel-experimental-poc'
  productionIntegration = $false
  host = [ordered]@{
    os = $os.Caption
    build = $os.BuildNumber
    architecture = $os.OSArchitecture
    hypervisorPresent = [bool]$computerSystem.HypervisorPresent
    windowsSandboxExecutablePresent = Test-Path -LiteralPath (Join-Path $windowsSystem 'WindowsSandbox.exe')
    processModelApiAvailable = $apiAvailable
    processModelApiReason = $apiReason
    nodeVersion = [string](& $nodeExe --version)
    gitVersion = [string](& $gitExe --version)
    powershellVersion = $PSVersionTable.PSVersion.ToString()
  }
  scope = [ordered]@{
    platform = 'win32'
    runId = [Guid]::NewGuid().ToString('N')
    workspaceRoot = $workspaceRoot
  }
  evidence = $results
  raw = [ordered]@{
    shellWorkerExitCode = $shellWorker.ExitCode
    shellWorkerError = if ($capturedErrors.shell) { [string]($capturedErrors.shell | ConvertTo-Json -Depth 5 -Compress) } else { $null }
    shellPayloadErrorPath = if (Test-Path -LiteralPath (Join-Path $workspaceRoot 'powershell-probe-error.txt')) { Join-Path $workspaceRoot 'powershell-probe-error.txt' } else { $null }
    shellPayloadResultPath = if (Test-Path -LiteralPath $shellResultsPath) { $shellResultsPath } else { $null }
    gitInitExitCode = $gitInitWorker.ExitCode
    gitInitProcessResultPath = if (Test-Path -LiteralPath $gitInitRequest.ResultPath) { $gitInitRequest.ResultPath } else { $null }
    gitStatusExitCode = $gitStatusWorker.ExitCode
    gitStatusProcessResultPath = if (Test-Path -LiteralPath $gitStatusRequest.ResultPath) { $gitStatusRequest.ResultPath } else { $null }
    gitTrace2Path = if (Test-Path -LiteralPath (Join-Path $workspaceRoot 'git-trace2.json')) { Join-Path $workspaceRoot 'git-trace2.json' } else { $null }
    timeoutWorkerExitCode = $timeoutWorker.ExitCode
    timeoutWorkerReportedTimeout = [bool]($timeoutResult -and $timeoutResult.timedOut)
    timeoutRootWaitBeforeTermination = if ($timeoutResult) { $timeoutResult.rootWaitBeforeTermination } else { $null }
    timeoutRootExitCodeBeforeTermination = if ($timeoutResult) { $timeoutResult.rootExitCodeBeforeTermination } else { $null }
    timeoutChildErrorPath = if (Test-Path -LiteralPath $timeoutErrorPath) { $timeoutErrorPath } else { $null }
    shellProcessResultPath = if (Test-Path -LiteralPath $shellRequest.ResultPath) { $shellRequest.ResultPath } else { $null }
    gitVersionWorkerExitCode = $gitVersionWorker.ExitCode
    gitVersionProcessResultPath = if (Test-Path -LiteralPath $gitVersionRequest.ResultPath) { $gitVersionRequest.ResultPath } else { $null }
    cancellationWorkerExitCode = $cancelWorker.ExitCode
    cancellationRootWasAliveBeforeWorkerStop = $cancelRootWasAlive
    cancellationDescendantPidObserved = $cancelChildPid
    cancellationChildErrorPath = if (Test-Path -LiteralPath $cancelErrorPath) { $cancelErrorPath } else { $null }
    invalidSpecWorkerExitCode = $badSpecWorker.ExitCode
    junctionCreationError = $junctionError
    symbolicLinkCreationError = $symlinkError
    externalNetworkBaseline = $hostExternalNetworkBaseline
    externalDnsBaseline = $hostDnsBaseline
    externalIpv4Baseline = $hostExternalIpv4Baseline
    externalIpv6Baseline = $hostExternalIpv6Baseline
    externalIpv6Target = $sandboxIpv6Target
    externalIpv6SandboxProbe = if ($shellResults) {
      @{ powershell = $shellResults.externalIpv6; node = $shellResults.node.externalIpv6 }
    }
    else { $null }
    systemProxyConfigured = $hostUsesSystemProxy
    systemProxyHttpsBaseline = $hostProxyHttpsBaseline
    nodeSystemProxyHttpsBaseline = $hostNodeProxyBaseline
    loopbackBaseline = $hostLoopbackBaseline
  }
}
Write-ProbeProgress 'report-object-built'
Write-ProbeProgress 'serialize-host-start'
$hostJson = ConvertTo-Json -InputObject $report.host -Depth 4 -Compress
Write-ProbeProgress 'serialize-scope-start'
$scopeJson = ConvertTo-Json -InputObject $report.scope -Depth 4 -Compress
Write-ProbeProgress 'serialize-evidence-start'
$evidenceJson = ConvertTo-Json -InputObject $report.evidence -Depth 6 -Compress
Write-ProbeProgress 'serialize-raw-start'
$rawJson = ConvertTo-Json -InputObject $report.raw -Depth 4 -Compress
Write-ProbeProgress 'serialize-scalars-start'
$generatedAtJson = ConvertTo-Json -InputObject ([string]$report.generatedAt) -Compress
$backendIdJson = ConvertTo-Json -InputObject ([string]$report.backendId) -Compress
$workspaceRootJson = ConvertTo-Json -InputObject ([string]$report.scope.workspaceRoot) -Compress
$reportJson = '{"generatedAt":' + $generatedAtJson + ',"backendId":' + $backendIdJson + ',"productionIntegration":false,"host":' + $hostJson + ',"scope":' + $scopeJson + ',"evidence":' + $evidenceJson + ',"raw":' + $rawJson + '}'
Write-ProbeProgress 'report-serialized'
[IO.File]::WriteAllText($reportPath, ($reportJson + "`n"))
Write-ProbeProgress 'report-written'

Push-Location $repoRoot
try {
  & $pnpm --filter @littlesheep/types build
  Write-ProbeProgress 'types-built'
  if ($LASTEXITCODE -ne 0) { throw 'Could not build @littlesheep/types for the capability assessment.' }
  & $nodeExe (Join-Path $PSScriptRoot 'evaluate-report.mjs') $reportPath
  Write-ProbeProgress 'capability-assessment-written'
}
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Could not evaluate the capability report through @littlesheep/types.' }
Write-Output (Get-Content -LiteralPath $reportPath -Raw)
Write-Output "evidence=$evidenceRoot"
