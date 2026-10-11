import { describe, expect, it } from 'vitest';
import {
  assessSandboxReadiness,
  SANDBOX_CAPABILITY_SNAPSHOT_VERSION,
  type SandboxCapabilityId,
  type SandboxCapabilitySnapshot,
  type SandboxExecutionScope,
  type SandboxPlatform,
} from './sandbox-capabilities.js';

const scope: SandboxExecutionScope = {
  platform: 'win32', runId: 'run-1', workspaceRoot: 'C:\\project',
};
const capabilityIds: readonly SandboxCapabilityId[] = [
  'native-file-read-confinement',
  'native-file-write-confinement',
  'process-filesystem-confinement',
  'process-network-confinement',
  'child-process-containment',
  'process-tree-termination',
];

function snapshot(
  overrides: Partial<Record<SandboxCapabilityId, 'verified' | 'partial' | 'unavailable'>> = {},
  executionScope: SandboxExecutionScope = scope,
): SandboxCapabilitySnapshot {
  return {
    version: SANDBOX_CAPABILITY_SNAPSHOT_VERSION,
    backendId: 'fixture-only',
    scope: executionScope,
    capabilities: Object.fromEntries(capabilityIds.map((id) => [
      id, { status: overrides[id] ?? 'unavailable', reason: 'fixture' },
    ])) as unknown as SandboxCapabilitySnapshot['capabilities'],
  };
}

describe('sandbox capability contract', () => {
  it('never treats absent evidence as ready', () => {
    expect(assessSandboxReadiness('native-file-read', scope, undefined))
      .toMatchObject({ ready: false, reason: 'snapshot_missing' });
  });

  it.each(['win32', 'darwin', 'linux'] as const)(
    'uses the same capability requirements on %s', (platform: SandboxPlatform) => {
      const platformScope = { ...scope, platform };
      const evidence = snapshot({
        'native-file-read-confinement': 'verified',
        'native-file-write-confinement': 'verified',
      }, platformScope);
      expect(assessSandboxReadiness('native-file-read', platformScope, evidence).ready).toBe(true);
      expect(assessSandboxReadiness('native-file-write', platformScope, evidence).ready).toBe(true);
      expect(assessSandboxReadiness('shell', platformScope, evidence))
        .toMatchObject({ ready: false, reason: 'capability_unverified' });
    },
  );

  it('refuses a snapshot bound to a different run, workspace, or platform', () => {
    const evidence = snapshot({ 'native-file-read-confinement': 'verified' });
    for (const changed of [
      { ...scope, runId: 'run-2' },
      { ...scope, workspaceRoot: 'C:\\another-project' },
      { ...scope, platform: 'linux' as const },
    ]) {
      expect(assessSandboxReadiness('native-file-read', changed, evidence))
        .toMatchObject({ ready: false, reason: 'scope_mismatch' });
    }
  });

  it('refuses partial guarantees even when every other shell capability is verified', () => {
    const statuses = Object.fromEntries(capabilityIds.map((key) => [key, 'verified'])) as Record<SandboxCapabilityId, 'verified'>;
    const evidence = snapshot({ ...statuses, 'process-network-confinement': 'partial' });
    expect(assessSandboxReadiness('shell', scope, evidence)).toEqual({
      ready: false,
      operation: 'shell',
      reason: 'capability_unverified',
      missing: ['process-network-confinement'],
    });
  });

  it('requires filesystem, network, children, and termination for shell readiness', () => {
    const statuses = Object.fromEntries(capabilityIds.map((key) => [key, 'verified'])) as Record<SandboxCapabilityId, 'verified'>;
    expect(assessSandboxReadiness('shell', scope, snapshot(statuses)))
      .toEqual({ ready: true, operation: 'shell' });
  });
});
