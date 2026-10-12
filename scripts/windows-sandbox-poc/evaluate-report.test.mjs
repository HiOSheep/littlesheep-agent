import { describe, expect, it } from 'vitest';
import { addHandleSnapshotAssessment, addSandboxAssessment, addSnapshotAssessment } from './evaluate-report.mjs';

function createPassingReport() {
  return {
    backendId: 'windows-processmodel-experimental-poc',
    host: { processModelApiAvailable: true },
    scope: { platform: 'win32', runId: 'test-run', workspaceRoot: 'C:\\poc\\workspace' },
    evidence: {
      filesystem: {
        workspaceRead: true,
        workspaceWrite: true,
        outsideReadDenied: true,
        outsideWriteDenied: true,
        pathTraversalDenied: true,
        junctionDenied: true,
        symbolicLinkDenied: true,
        hardLinkReadDenied: true,
        hardLinkWriteDenied: true,
        hardLinkTargetUnchanged: true,
        nestedDirectorySwapSucceeded: true,
        nestedReplacementReadDenied: true,
        nestedDirectoryTargetUnchanged: true,
        protectedSourceWriteDenied: true,
        profileGitConfigReadDenied: true,
        profilePowerShellHistoryReadDenied: true,
        directoryReplacementBlocked: true,
      },
      network: {
        hostExternalBaseline: 'connected',
        hostDnsBaseline: true,
        hostExternalIpv4Baseline: 'connected',
        hostExternalIpv6Baseline: 'connected',
        hostLoopbackBaseline: 'connected',
        hostSystemProxyConfigured: true,
        hostSystemProxyHttpsBaseline: true,
        hostNodeProxyHttpsBaseline: true,
        powershellExternalDenied: true,
        nodeExternalDenied: true,
        powershellIpv4Denied: true,
        nodeIpv4Denied: true,
        powershellIpv6Denied: true,
        nodeIpv6Denied: true,
        powershellDnsDenied: true,
        nodeDnsDenied: true,
        powershellLoopbackDenied: true,
        nodeLoopbackDenied: true,
        powershellSystemProxyBlocked: true,
        nodeSystemProxyBlocked: true,
      },
      childProcess: {
        powershellLaunchedNode: true,
        nodeRestrictionsMatched: true,
        gitVersion: true,
        gitInit: true,
        gitStatus: true,
      },
      termination: {
        timeoutObserved: true,
        timeoutTreeTerminated: true,
        hostCancellationObserved: true,
        hostCancellationTreeTerminated: true,
        timeoutDescendantStarted: true,
        cancellationDescendantStarted: true,
      },
      execution: { powershellPayloadStarted: true, nodePayloadStarted: true },
    },
  };
}

describe('Windows sandbox capability evidence', () => {
  it('does not verify filesystem confinement when a hard-link alias reaches an outside file', async () => {
    const report = createPassingReport();
    report.evidence.filesystem.hardLinkReadDenied = false;
    report.evidence.filesystem.hardLinkWriteDenied = false;
    report.evidence.filesystem.hardLinkTargetUnchanged = false;

    const assessed = await addSandboxAssessment(report);

    expect(assessed.capabilitySnapshot.capabilities['process-filesystem-confinement'].status).toBe('partial');
    expect(assessed.shellReadiness.ready).toBe(false);
    expect(assessed.readinessIsAuthorization).toBe(false);
  });

  it('keeps network confinement partial without a host-positive IPv6 baseline', async () => {
    const report = createPassingReport();
    report.evidence.network.hostExternalIpv6Baseline = 'NetworkUnreachable';
    report.evidence.network.powershellIpv6Denied = null;
    report.evidence.network.nodeIpv6Denied = null;

    const assessed = await addSandboxAssessment(report);

    expect(assessed.capabilitySnapshot.capabilities['process-network-confinement'].status).toBe('partial');
    expect(assessed.shellReadiness.ready).toBe(false);
  });

  it('keeps child-process containment partial when Git init or status does not work', async () => {
    const report = createPassingReport();
    report.evidence.childProcess.gitInit = false;

    const assessed = await addSandboxAssessment(report);

    expect(assessed.capabilitySnapshot.capabilities['child-process-containment'].status).toBe('partial');
    expect(assessed.shellReadiness.ready).toBe(false);
  });

  it('keeps snapshot isolation partial when the report records a hard-link escape and does not authorize shell readiness', () => {
    const report = {
      backendId: 'windows-snapshot-filesystem-poc',
      scope: { platform: 'win32', runId: 'snapshot-run', workspaceRoot: 'C:\\poc\\snapshot' },
      evidence: {
        directWorkspaceHardLink: { payloadStarted: true, outsideTargetChanged: true },
        snapshotProcess: { payloadStarted: true, payloadResult: { nodeChildExitCode: 0 } },
        git: { payloadStarted: true, payloadExitCode: 128 },
      },
    };

    const assessed = addSnapshotAssessment(report);

    expect(assessed.capabilitySnapshot.capabilities['process-filesystem-confinement'].status).toBe('partial');
    expect(assessed.capabilitySnapshot.capabilities['process-network-confinement'].status).toBe('unavailable');
    expect(assessed.capabilitySnapshot.capabilities['child-process-containment'].status).toBe('partial');
    expect(assessed.capabilitySnapshot.capabilities['process-tree-termination'].status).toBe('unavailable');
    expect(Object.values(assessed.capabilitySnapshot.capabilities).some((capability) => capability.status === 'verified')).toBe(false);
    expect(assessed.shellReadiness.ready).toBe(false);
    expect(assessed.readinessIsAuthorization).toBe(false);
  });

  it('keeps handle-anchored snapshot evidence partial and shell readiness disabled', () => {
    const assessed = addHandleSnapshotAssessment({
      backendId: 'windows-handle-snapshot-poc',
      scope: { platform: 'win32', runId: 'handle-run', workspaceRoot: 'C:\\poc\\snapshot' },
      evidence: {
        handleCopy: { promotedAtomically: true },
        sourceDirectorySwap: { copierUsedHeldDirectoryHandle: true },
        runtimeSnapshotMutation: { sandboxPayloadStarted: true },
      },
    });

    expect(assessed.capabilitySnapshot.capabilities['process-filesystem-confinement'].status).toBe('partial');
    expect(assessed.capabilitySnapshot.capabilities['process-network-confinement'].status).toBe('unavailable');
    expect(assessed.capabilitySnapshot.capabilities['child-process-containment'].status).toBe('partial');
    expect(assessed.capabilitySnapshot.capabilities['process-tree-termination'].status).toBe('unavailable');
    expect(Object.values(assessed.capabilitySnapshot.capabilities).some((capability) => capability.status === 'verified')).toBe(false);
    expect(assessed.shellReadiness.ready).toBe(false);
    expect(assessed.readinessIsAuthorization).toBe(false);
  });
});
