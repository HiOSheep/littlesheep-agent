import { randomUUID } from 'node:crypto';
import type {
  RuntimeCapabilityProbe,
  RuntimeCapabilitySnapshot,
  RuntimePermissionEvent,
} from '@littlesheep/types';

/** Build a redacted probe result from the Runtime-owned snapshot. */
export function capabilityProbeEvent(
  snapshot: RuntimeCapabilitySnapshot | undefined,
  probeId: string = randomUUID(),
): { probe: RuntimeCapabilityProbe; permission: RuntimePermissionEvent } {
  const epoch = snapshot?.epoch ?? 'unavailable';
  const permissionPolicyId = snapshot?.permissionPolicyId ?? 'research';
  return {
    probe: Object.freeze({
      version: 1 as const,
      probeId,
      kind: 'capability_snapshot' as const,
      status: snapshot ? 'observed' as const : 'unavailable' as const,
      capabilityEpoch: epoch,
      evidence: 'runtime_snapshot' as const,
    }),
    permission: Object.freeze({
      version: 1 as const,
      eventId: `${probeId}:permission`,
      action: 'capability_probe' as const,
      decision: snapshot ? 'allow' as const : 'unavailable' as const,
      permissionPolicyId,
      capabilityEpoch: epoch,
      source: 'runtime' as const,
    }),
  };
}

/**
 * Convert the Runtime snapshot into the bounded, path-free payload used by the
 * durable event log. Generated timestamps are intentionally omitted because
 * the capability epoch is the stable identity of the snapshot.
 */
export function capabilitySnapshotDurablePayload(
  snapshot: RuntimeCapabilitySnapshot | undefined,
): Record<string, unknown> {
  if (!snapshot) {
    return {
      snapshot: {
        capabilityEpoch: 'unavailable',
        permissionPolicyId: 'research',
        workspace: 'unavailable',
        tools: [],
        network: { enabled: false, status: 'unavailable' },
      },
    };
  }
  return {
    snapshot: {
      capabilityEpoch: snapshot.epoch,
      permissionPolicyId: snapshot.permissionPolicyId,
      workspace: snapshot.workspace,
      tools: snapshot.tools.map((tool) => ({
        name: tool.name,
        status: tool.status,
        source: tool.source,
      })),
      network: {
        enabled: snapshot.network.enabled,
        status: snapshot.network.status,
        ...(snapshot.network.providerId ? { providerId: snapshot.network.providerId } : {}),
      },
    },
  };
}

/** Build the durable payload for the result of a Runtime capability probe. */
export function capabilityProbeDurablePayload(
  probe: RuntimeCapabilityProbe,
  permission: RuntimePermissionEvent,
): Record<string, unknown> {
  return {
    probeId: probe.probeId,
    status: probe.status,
    capabilityEpoch: probe.capabilityEpoch,
    evidence: probe.evidence,
    permissionDecision: permission.decision,
  };
}
