// CMv2 P1A foundation. Created by the host, never from model/tool arguments.
// Shape validation does not authenticate its caller; runtime authority requires a Host-issued handle.
export type MemoryReadMode = 'none' | 'project' | 'global' | 'manual';
export type MemoryWriteMode = 'disabled' | 'ask' | 'automatic';

export interface MemoryAccessReference {
  kind: 'atom' | 'resource';
  id: string;
}

export interface MemoryAccessPolicy {
  version: 1;
  /** Incremented by the host on settings/ownership changes. */
  revision: number;
  principalId: string;
  dataRootId: string;
  sessionId: string;
  runId: string;
  /** Verified registry ID, not a workspace path or model assertion. */
  projectId?: string;
  readMode: MemoryReadMode;
  writeMode: MemoryWriteMode;
  selected: readonly MemoryAccessReference[];
  disabled: readonly MemoryAccessReference[];
  /** A separate explicit write grant; global reads do not imply global writes. */
  globalWriteGranted: boolean;
}

/** Host-resolved ownership sidecar. Never inferred from text/path similarity. */
export interface MemoryAccessTarget extends MemoryAccessReference {
  principalId: string;
  dataRootId: string;
  binding: 'reviewed' | 'pending';
  scope: 'global' | 'project' | 'session';
  projectId?: string;
  sessionId?: string;
}

export type MemoryAccessDecision =
  | { outcome: 'allow' | 'ask'; reason: 'authorized' | 'write-confirmation' }
  | { outcome: 'deny'; reason: 'invalid-policy' | 'invalid-target' | 'ownership' | 'pending-binding'
      | 'disabled' | 'read-disabled' | 'scope' | 'not-selected' | 'write-disabled' | 'global-write-grant' };
