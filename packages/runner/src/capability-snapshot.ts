import { createHash } from 'node:crypto';
import type {
  AgentTool,
  PermissionPolicyId,
  RuntimeCapabilitySnapshot,
  RuntimeCapabilityTool,
  RuntimeCapabilityWorkspaceStatus,
  RuntimePermissionEvent,
  WebProviderRuntimeSnapshot,
} from '@littlesheep/types';
import { randomUUID } from 'node:crypto';

export interface BuildCapabilitySnapshotOptions {
  tools: readonly AgentTool[];
  toolSources?: Readonly<Record<string, string>>;
  approvalRequiredToolNames?: readonly string[];
  permissionPolicyId: PermissionPolicyId;
  workspaceAccess: RuntimeCapabilityWorkspaceStatus;
  networkEnabled: boolean;
  webProvider?: WebProviderRuntimeSnapshot;
  now?: Date;
}

export interface BuildRunnerCapabilityStateOptions {
  tools: readonly AgentTool[];
  toolSources?: Readonly<Record<string, string>>;
  approvalRequiredToolNames?: readonly string[];
  permissionPolicyId: PermissionPolicyId;
  workspaceAccess: RuntimeCapabilityWorkspaceStatus;
  networkEnabled: boolean;
  webProvider?: WebProviderRuntimeSnapshot;
  now?: Date;
  permissionEventId: string;
}

/** Assemble the snapshot and its paired workspace permission fact atomically. */
export function buildRunnerCapabilityState(options: BuildRunnerCapabilityStateOptions): {
  snapshot: RuntimeCapabilitySnapshot;
  permissionEvent: RuntimePermissionEvent;
} {
  const snapshot = buildCapabilitySnapshot(options);
  return {
    snapshot,
    permissionEvent: workspacePermissionEvent(snapshot, options.permissionEventId),
  };
}

/** Build the authoritative, path-free capability snapshot for one run. */
export function buildCapabilitySnapshot(options: BuildCapabilitySnapshotOptions): RuntimeCapabilitySnapshot {
  const approval = new Set(options.approvalRequiredToolNames ?? []);
  const tools: RuntimeCapabilityTool[] = [...new Map(
    options.tools.map((tool) => [tool.name, {
      name: tool.name,
      status: approval.has(tool.name) ? 'approval_required' as const : 'available' as const,
      source: options.toolSources?.[tool.name] === 'builtin' ? 'builtin' as const : 'external' as const,
    }]),
  ).values()].sort((left, right) => compareCodePoints(left.name, right.name));
  const network = {
    enabled: options.networkEnabled,
    status: options.webProvider?.status ?? (options.networkEnabled ? 'unavailable' : 'disabled'),
    ...(options.webProvider?.id ? { providerId: options.webProvider.id } : {}),
  } as RuntimeCapabilitySnapshot['network'];
  const shape = JSON.stringify({
    version: 1,
    permissionPolicyId: options.permissionPolicyId,
    workspace: options.workspaceAccess,
    tools,
    network,
  });
  const epoch = createHash('sha256').update(shape).digest('hex');
  return Object.freeze({
    version: 1,
    epoch,
    generatedAt: (options.now ?? new Date()).toISOString(),
    permissionPolicyId: options.permissionPolicyId,
    workspace: options.workspaceAccess,
    tools: Object.freeze(tools),
    network: Object.freeze(network),
  });
}

export function workspacePermissionEvent(
  snapshot: RuntimeCapabilitySnapshot,
  eventId: string = randomUUID(),
): RuntimePermissionEvent {
  return Object.freeze({
    version: 1 as const,
    eventId,
    action: 'workspace_scan' as const,
    decision: permissionDecisionForWorkspace(snapshot.workspace),
    permissionPolicyId: snapshot.permissionPolicyId,
    capabilityEpoch: snapshot.epoch,
    source: 'runtime' as const,
  });
}

function permissionDecisionForWorkspace(
  status: RuntimeCapabilityWorkspaceStatus,
): RuntimePermissionEvent['decision'] {
  if (status === 'available') return 'allow';
  if (status === 'approval_required') return 'approval_required';
  if (status === 'denied') return 'deny';
  return 'unavailable';
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
