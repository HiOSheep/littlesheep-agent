// @littlesheep/types — host-owned cross-platform sandbox capability contract.
// This module describes evidence and requirements; it does not grant permission,
// launch processes or provide an OS sandbox.

export const SANDBOX_CAPABILITY_SNAPSHOT_VERSION = 1 as const;

/** Node/Electron desktop platforms; future backends must be added explicitly. */
export type SandboxPlatform = 'win32' | 'darwin' | 'linux';

export type SandboxOperation = 'native-file-read' | 'native-file-write' | 'shell';

/** A guarantee, not the name of a specific OS API or backend. */
export type SandboxCapabilityId =
  | 'native-file-read-confinement'
  | 'native-file-write-confinement'
  | 'process-filesystem-confinement'
  | 'process-network-confinement'
  | 'child-process-containment'
  | 'process-tree-termination';

/** Partial or unknown guarantees are never sufficient for automatic execution. */
export type SandboxCapabilityStatus = 'verified' | 'partial' | 'unavailable';

export interface SandboxCapabilityEvidence {
  readonly status: SandboxCapabilityStatus;
  /** Human-readable diagnostic; not an authorization token. */
  readonly reason: string;
}

/** Bound to a single run and an already canonicalized workspace path. */
export interface SandboxExecutionScope {
  readonly platform: SandboxPlatform;
  readonly runId: string;
  readonly workspaceRoot: string;
}

/**
 * Created only by a trusted Main/host-side backend probe. Model, renderer and
 * tool inputs must never be allowed to supply or upgrade this snapshot.
 */
export interface SandboxCapabilitySnapshot {
  readonly version: typeof SANDBOX_CAPABILITY_SNAPSHOT_VERSION;
  readonly backendId: string;
  readonly scope: Readonly<SandboxExecutionScope>;
  readonly capabilities: Readonly<Record<SandboxCapabilityId, SandboxCapabilityEvidence>>;
}

/**
 * A shell requires all process guarantees, including network egress control.
 * Native file guarantees are independent: P2 file guards are not a shell sandbox.
 */
export const SANDBOX_OPERATION_REQUIREMENTS = {
  'native-file-read': ['native-file-read-confinement'],
  'native-file-write': ['native-file-write-confinement'],
  shell: [
    'process-filesystem-confinement',
    'process-network-confinement',
    'child-process-containment',
    'process-tree-termination',
  ],
} as const satisfies Readonly<Record<SandboxOperation, readonly SandboxCapabilityId[]>>;

export type SandboxReadiness =
  | { readonly ready: true; readonly operation: SandboxOperation }
  | {
      readonly ready: false;
      readonly operation: SandboxOperation;
      readonly reason: 'snapshot_missing' | 'scope_mismatch' | 'capability_unverified';
      readonly missing: readonly SandboxCapabilityId[];
    };

/**
 * Pure report evaluator, NOT an allow/deny or approval decision. Permission V2
 * and the actual tool/process boundary remain authoritative. A `ready` result
 * only has meaning when `snapshot` came from a trusted, live backend probe and
 * the execution boundary enforces the described guarantees throughout a call.
 */
export function assessSandboxReadiness(
  operation: SandboxOperation,
  scope: Readonly<SandboxExecutionScope>,
  snapshot: SandboxCapabilitySnapshot | undefined,
): SandboxReadiness {
  if (!snapshot) return { ready: false, operation, reason: 'snapshot_missing', missing: [] };
  if (
    snapshot.version !== SANDBOX_CAPABILITY_SNAPSHOT_VERSION
    || !snapshot.backendId.trim()
    || !scope.runId.trim()
    || !scope.workspaceRoot.trim()
    || snapshot.scope.platform !== scope.platform
    || snapshot.scope.runId !== scope.runId
    || snapshot.scope.workspaceRoot !== scope.workspaceRoot
  ) {
    return { ready: false, operation, reason: 'scope_mismatch', missing: [] };
  }
  const missing = SANDBOX_OPERATION_REQUIREMENTS[operation].filter(
    (capability) => snapshot.capabilities[capability]?.status !== 'verified',
  );
  return missing.length === 0
    ? { ready: true, operation }
    : { ready: false, operation, reason: 'capability_unverified', missing };
}
