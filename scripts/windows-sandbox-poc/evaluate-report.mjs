import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const typesModuleUrl = pathToFileURL(resolve('packages/types/dist/sandbox-capabilities.js')).href;
const { assessSandboxReadiness, SANDBOX_CAPABILITY_SNAPSHOT_VERSION } = await import(typesModuleUrl);

function allTrue(values) {
  return values.every((value) => value === true);
}

function statusFor(passed, attempted) {
  if (passed) return 'verified';
  return attempted ? 'partial' : 'unavailable';
}

function explain(status, passText, missingText, unavailableText) {
  if (status === 'verified') return passText;
  return status === 'unavailable' ? unavailableText : missingText;
}

function parseJsonString(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

async function readEvidenceJson(path) {
  if (typeof path !== 'string') return undefined;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
}

export async function addSandboxAssessment(report) {
  const evidence = report.evidence;
  const apiAvailable = report.host?.processModelApiAvailable === true;
  const filesystemChecks = [
    evidence.filesystem.workspaceRead,
    evidence.filesystem.workspaceWrite,
    evidence.filesystem.outsideReadDenied,
    evidence.filesystem.outsideWriteDenied,
    evidence.filesystem.pathTraversalDenied,
    evidence.filesystem.junctionDenied,
    evidence.filesystem.symbolicLinkDenied,
    evidence.filesystem.hardLinkReadDenied,
    evidence.filesystem.hardLinkWriteDenied,
    evidence.filesystem.hardLinkTargetUnchanged,
    evidence.filesystem.nestedDirectorySwapSucceeded,
    evidence.filesystem.nestedReplacementReadDenied,
    evidence.filesystem.nestedDirectoryTargetUnchanged,
    evidence.filesystem.protectedSourceWriteDenied,
    evidence.filesystem.profileGitConfigReadDenied,
    evidence.filesystem.profilePowerShellHistoryReadDenied,
    evidence.filesystem.directoryReplacementBlocked,
  ];
  const proxyChecks = evidence.network.hostSystemProxyConfigured === true
    && evidence.network.hostSystemProxyHttpsBaseline === true
    && evidence.network.hostNodeProxyHttpsBaseline === true
    && evidence.network.powershellSystemProxyBlocked === true
    && evidence.network.nodeSystemProxyBlocked === true;
  const networkChecks = [
    evidence.network.hostExternalBaseline === 'connected',
    evidence.network.hostDnsBaseline === true,
    evidence.network.hostExternalIpv4Baseline === 'connected',
    evidence.network.hostExternalIpv6Baseline === 'connected',
    evidence.network.hostLoopbackBaseline === 'connected',
    evidence.network.powershellExternalDenied,
    evidence.network.nodeExternalDenied,
    evidence.network.powershellIpv4Denied,
    evidence.network.nodeIpv4Denied,
    evidence.network.powershellIpv6Denied,
    evidence.network.nodeIpv6Denied,
    evidence.network.powershellDnsDenied,
    evidence.network.nodeDnsDenied,
    evidence.network.powershellLoopbackDenied,
    evidence.network.nodeLoopbackDenied,
    proxyChecks,
  ];
  const childChecks = [
    evidence.childProcess.powershellLaunchedNode,
    evidence.childProcess.nodeRestrictionsMatched,
    evidence.childProcess.gitVersion,
    evidence.childProcess.gitInit,
    evidence.childProcess.gitStatus,
  ];
  const terminationChecks = [
    evidence.termination.timeoutObserved,
    evidence.termination.timeoutTreeTerminated,
    evidence.termination.hostCancellationObserved,
    evidence.termination.hostCancellationTreeTerminated,
  ];

  const checks = {
    filesystem: allTrue(filesystemChecks),
    network: allTrue(networkChecks),
    childProcess: allTrue(childChecks),
    processTree: allTrue(terminationChecks),
  };
  const payloadStarted = evidence.execution?.powershellPayloadStarted === true
    || evidence.execution?.nodePayloadStarted === true;
  const gitVersionProcessResult = parseJsonString(report.raw?.gitVersionProcessResult)
    ?? await readEvidenceJson(report.raw?.gitVersionProcessResultPath);
  const shellProcessResult = parseJsonString(report.raw?.shellProcessResult)
    ?? await readEvidenceJson(report.raw?.shellProcessResultPath);
  const gitProbeReachedPayload = gitVersionProcessResult?.exitCode === 0;
  const descendantStarted = evidence.termination?.timeoutDescendantStarted === true
    || evidence.termination?.cancellationDescendantStarted === true;
  const rootExitCode = shellProcessResult?.rootExitCodeBeforeTermination || shellProcessResult?.exitCode;
  const rootExitCodeHex = Number.isInteger(rootExitCode)
    ? `0x${(rootExitCode >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
    : null;
  const payloadUnavailableReason = !apiAvailable
    ? 'The experimental processmodel export is unavailable on this host.'
    : rootExitCodeHex
      ? `The API export is present, but the sandbox payload failed during process initialization (root status ${rootExitCodeHex}); no payload probes ran.`
      : 'No sandbox payload reached its first probe marker.';
  const terminationUnavailableReason = descendantStarted
    ? 'A sandbox descendant was not observed to survive into the timeout or cancellation probe.'
    : payloadStarted
      ? 'No tracked Node descendant PID was observed, so process-tree cleanup could not be verified.'
      : payloadUnavailableReason;
  const statuses = {
    'native-file-read-confinement': 'unavailable',
    'native-file-write-confinement': 'unavailable',
    'process-filesystem-confinement': statusFor(checks.filesystem, payloadStarted),
    'process-network-confinement': statusFor(checks.network, payloadStarted),
    'child-process-containment': statusFor(checks.childProcess, payloadStarted || gitProbeReachedPayload),
    'process-tree-termination': statusFor(checks.processTree, descendantStarted),
  };
  const reasons = {
    'native-file-read-confinement': 'This PoC launches shell processes; it does not assess native file tools.',
    'native-file-write-confinement': 'This PoC launches shell processes; it does not assess native file tools.',
    'process-filesystem-confinement': explain(statuses['process-filesystem-confinement'], 'Workspace, outside-root, junction, symlink, hard-link, traversal, protected-source, and replacement probes passed.', 'At least one filesystem probe failed or could not run after payload startup; hard-link aliases are included in the confinement gate.', payloadUnavailableReason),
    'process-network-confinement': explain(statuses['process-network-confinement'], 'Host-positive DNS, IPv4, IPv6, loopback, and system-proxy paths were blocked to PowerShell and its Node child.', 'A host-positive DNS, address-family, loopback, or configured-proxy check was incomplete or not denied after payload startup.', payloadUnavailableReason),
    'child-process-containment': explain(statuses['child-process-containment'], 'Node inherited the restrictions; Git version, init, and status completed inside the allowed scope.', 'A child-process restriction or Git compatibility probe failed after payload startup.', payloadUnavailableReason),
    'process-tree-termination': explain(statuses['process-tree-termination'], 'Timeout and forced worker termination both ended the tracked Node child.', 'Timeout/cancellation or descendant cleanup was incomplete after a child started.', terminationUnavailableReason),
  };

  const snapshot = {
    version: SANDBOX_CAPABILITY_SNAPSHOT_VERSION,
    backendId: report.backendId,
    scope: report.scope,
    capabilities: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, reason: reasons[id] }])),
  };
  return {
    ...report,
    capabilitySnapshot: snapshot,
    shellReadiness: assessSandboxReadiness('shell', report.scope, snapshot),
    readinessIsAuthorization: false,
  };
}

export function addSnapshotAssessment(report) {
  const evidence = report.evidence ?? {};
  const directHardLinkAttempted = evidence.directWorkspaceHardLink?.payloadStarted === true;
  const snapshotWriteAttempted = evidence.snapshotProcess?.payloadStarted === true;
  const gitAttempted = evidence.git?.payloadStarted === true;
  const filesystemAttempted = directHardLinkAttempted || snapshotWriteAttempted;
  const childAttempted = evidence.snapshotProcess?.payloadResult?.nodeChildExitCode !== undefined || gitAttempted;
  const nodeFileExitCode = evidence.snapshotProcess?.payloadResult?.nodeFileEntryExitCode;
  const nodeChildExitCode = evidence.snapshotProcess?.payloadResult?.nodeChildExitCode;
  const gitExitCode = evidence.git?.payloadExitCode;
  const gitError = evidence.git?.trace2ErrorMessage;
  const childProbeReasons = [];
  if (nodeFileExitCode !== undefined) {
    childProbeReasons.push(`Node file-entry exit=${nodeFileExitCode}; Node -e child exit=${nodeChildExitCode}.`);
  }
  if (gitAttempted) {
    childProbeReasons.push(`Git init exit=${gitExitCode}${gitError ? ` (${gitError})` : ''}.`);
  }
  const statuses = {
    'native-file-read-confinement': 'unavailable',
    'native-file-write-confinement': 'unavailable',
    'process-filesystem-confinement': filesystemAttempted ? 'partial' : 'unavailable',
    'process-network-confinement': 'unavailable',
    'child-process-containment': childAttempted ? 'partial' : 'unavailable',
    'process-tree-termination': 'unavailable',
  };
  const reasons = {
    'native-file-read-confinement': 'This experiment launches processes and does not assess LS native file tools.',
    'native-file-write-confinement': 'This experiment launches processes and does not assess LS native file tools.',
    'process-filesystem-confinement': directHardLinkAttempted && evidence.directWorkspaceHardLink.outsideTargetChanged
      ? 'Direct workspace authorization allowed a hard-link alias to modify an outside sentinel. A separate clean copy isolated the tested object, but hard-link, reparse, copy-race, metadata-stream, and concurrent-mutation coverage is incomplete.'
      : 'The experiment did not establish full process filesystem confinement; the copy tests cover only a clean fixture and preflight rejection cases.',
    'process-network-confinement': 'Network confinement was not tested in this snapshot experiment; this run had no host-positive IPv6 baseline.',
    'child-process-containment': childAttempted
      ? `${childProbeReasons.join(' ')} These narrow probes do not establish general child-process compatibility or process-tree containment.`
      : 'Child-process restrictions and runtime compatibility were not tested.',
    'process-tree-termination': 'This experiment did not test timeout, cancellation, abnormal exit, or escaped descendants.',
  };
  const snapshot = {
    version: SANDBOX_CAPABILITY_SNAPSHOT_VERSION,
    backendId: report.backendId,
    scope: report.scope,
    capabilities: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, reason: reasons[id] }])),
  };
  return {
    ...report,
    capabilitySnapshot: snapshot,
    shellReadiness: assessSandboxReadiness('shell', report.scope, snapshot),
    readinessIsAuthorization: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error('Usage: evaluate-report.mjs REPORT.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const assessed = report.backendId === 'windows-snapshot-filesystem-poc'
    ? addSnapshotAssessment(report)
    : await addSandboxAssessment(report);
  await writeFile(reportPath, `${JSON.stringify(assessed, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(assessed.shellReadiness)}\n`);
}
