import type {
  RunContext,
  RuntimeCapabilityProbe,
  RuntimeCapabilitySnapshot,
  RuntimePermissionEvent,
} from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

export interface CapabilityStateUpdate {
  capabilitySnapshot?: RuntimeCapabilitySnapshot;
  capabilityProbe?: RuntimeCapabilityProbe;
  capabilityPermissionEvent?: RuntimePermissionEvent;
}

const CAPABILITY_FIELDS = [
  'capabilitySnapshot',
  'capabilityProbe',
  'capabilityPermissionEvent',
] as const satisfies readonly (keyof CapabilityStateUpdate)[];

/** Commit Runtime-owned capability facts without allowing model stages to mutate them. */
export function writeCapabilityState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: CapabilityStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof CapabilityStateUpdate>;
  for (const field of fields) {
    if (!CAPABILITY_FIELDS.includes(field)) throw new Error(`Unknown capability state field '${String(field)}'.`);
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}
