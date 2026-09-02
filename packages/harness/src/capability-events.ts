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
