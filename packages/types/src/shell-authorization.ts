/** Display-only projection. No identifier in this object is an execution capability. */
export interface ShellExecutionDescription {
  version: 1;
  invocationId: string;
  digest: string;
  action: 'exec';
  command: string;
  shell: { path: string; args: readonly string[]; identity: string };
  cwd: { path: string; identity: string };
  workspace: { id: string; path: string; identity: string };
  sessionId: string;
  runId: string;
  permission: string;
  environment: string;
  timeoutMs: number;
  source: 'agent';
  user: string;
}

export interface ShellApprovalBatch {
  version: 1;
  batchId: string;
  scope: 'once' | 'batch';
  expiresAt: number;
  commands: readonly ShellExecutionDescription[];
}
