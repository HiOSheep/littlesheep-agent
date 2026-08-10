import type {
  ContextSnapshot,
  ModelRequestSnapshot,
  RunContext,
  StageName,
} from '@littlesheep/types';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** Top-level model-call budget and bounded request observations. */
export interface ModelObservabilityStateUpdate {
  modelCallCount?: number;
  modelRequests?: RunContext['modelRequests'];
  contextSnapshots?: RunContext['contextSnapshots'];
}

const MODEL_OBSERVABILITY_FIELDS = [
  'modelCallCount',
  'modelRequests',
  'contextSnapshots',
] as const satisfies readonly (keyof ModelObservabilityStateUpdate)[];

/** Validate model-observability fields before committing a shared-state batch. */
export function writeModelObservabilityState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: ModelObservabilityStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof ModelObservabilityStateUpdate>;
  for (const field of fields) {
    if (!MODEL_OBSERVABILITY_FIELDS.includes(field)) {
      throw new Error(`Unknown model observability field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Increment the bounded provider-call counter at the stage making the request. */
export function incrementModelCallCount(
  ctx: RunContext,
  stage: Exclude<RunContextContractStage, 'runtime-boundary' | 'post-run'>,
): number {
  const count = (ctx.modelCallCount ?? 0) + 1;
  writeModelObservabilityState(ctx, stage, { modelCallCount: count });
  return count;
}

/** Initialize or append bounded request/context observations as one batch. */
export function appendModelObservations(
  ctx: RunContext,
  stage: Extract<RunContextContractStage, StageName | 'runner-init'>,
  request: ModelRequestSnapshot,
  snapshot: ContextSnapshot,
  maxSnapshots: number,
): void {
  const boundedLimit = normalizeObservationLimit(maxSnapshots);
  const modelRequests = boundedAppend(ctx.modelRequests ?? [], request, boundedLimit);
  const contextSnapshots = boundedAppend(ctx.contextSnapshots ?? [], snapshot, boundedLimit);
  writeModelObservabilityState(ctx, stage, { modelRequests, contextSnapshots });
}

/** Replace one immutable Context snapshot after attaching provider usage. */
export function updateContextSnapshot(
  ctx: RunContext,
  stage: StageName,
  snapshotId: string,
  update: (snapshot: ContextSnapshot) => ContextSnapshot,
): void {
  const snapshots = ctx.contextSnapshots ?? [];
  const index = snapshots.findIndex((snapshot) => snapshot.id === snapshotId);
  if (index < 0) return;
  const next = [...snapshots];
  next[index] = update(snapshots[index]!);
  writeModelObservabilityState(ctx, stage, { contextSnapshots: next });
}

function boundedAppend<T>(values: readonly T[], value: T, max: number): T[] {
  const next = [...values];
  if (next.length >= max) next.splice(0, next.length - max + 1);
  next.push(value);
  return next;
}

function normalizeObservationLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN;
  return Math.min(
    MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
    Math.max(1, Math.floor(value)),
  );
}
