// Versioned, Runtime-owned capability facts. These records are safe to expose
// to adapters and UI because they contain names/statuses only, never prompts,
// paths, credentials, or provider payloads.

import type { PermissionPolicyId } from './runtime-contracts.js';
import type { WebProviderRuntimeStatus } from './web-retrieval.js';

export const RUNTIME_CAPABILITY_SNAPSHOT_VERSION = 1 as const;

export type RuntimeCapabilityToolStatus = 'available' | 'approval_required';
export type RuntimeCapabilityWorkspaceStatus = 'available' | 'approval_required' | 'denied' | 'unavailable';

export interface RuntimeCapabilityTool {
  readonly name: string;
  readonly status: RuntimeCapabilityToolStatus;
  /** Registry source is reduced to a non-sensitive category by Runner. */
  readonly source: 'builtin' | 'external';
}

export interface RuntimeCapabilitySnapshot {
  readonly version: typeof RUNTIME_CAPABILITY_SNAPSHOT_VERSION;
  /** Stable digest of the capability/policy shape; generatedAt is excluded. */
  readonly epoch: string;
  readonly generatedAt: string;
  readonly permissionPolicyId: PermissionPolicyId;
  readonly workspace: RuntimeCapabilityWorkspaceStatus;
  readonly tools: readonly RuntimeCapabilityTool[];
  readonly network: {
    readonly enabled: boolean;
    readonly status: WebProviderRuntimeStatus;
    readonly providerId?: string;
  };
}

export interface RuntimePermissionEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly action: 'workspace_scan' | 'capability_probe';
  readonly decision: 'allow' | 'approval_required' | 'deny' | 'unavailable';
  readonly permissionPolicyId: PermissionPolicyId;
  readonly capabilityEpoch: string;
  readonly source: 'runtime';
}

export interface RuntimeCapabilityProbe {
  readonly version: 1;
  readonly probeId: string;
  readonly kind: 'capability_snapshot';
  readonly status: 'observed' | 'unavailable';
  readonly capabilityEpoch: string;
  readonly evidence: 'runtime_snapshot';
}
