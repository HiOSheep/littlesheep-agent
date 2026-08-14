import type {
  LoopBudgetSnapshot,
  RunContext,
  RuntimeControlSnapshot,
  RuntimeEventEnvelope,
  RuntimeEventQueueLike,
  ConversationContinuationEvidence,
} from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** Runtime-owned fields that cross safe boundaries or checkpoint restore. */
export interface RuntimeStateUpdate {
  runtimeControl?: RuntimeControlSnapshot;
  runtimeEventQueue?: RuntimeEventQueueLike;
  deferredRuntimeEvents?: RuntimeEventEnvelope[];
  deferredRuntimeEventIds?: string[];
  loopBudget?: LoopBudgetSnapshot;
  conversationContinuation?: ConversationContinuationEvidence;
}

const RUNTIME_FIELDS = [
  'runtimeControl',
  'runtimeEventQueue',
  'deferredRuntimeEvents',
  'deferredRuntimeEventIds',
  'loopBudget',
  'conversationContinuation',
] as const satisfies readonly (keyof RuntimeStateUpdate)[];

/**
 * Commit a validated runtime-state update as one batch. This keeps control
 * snapshots, deferred event projections and loop budgets from being updated
 * through unrelated direct assignments.
 */
export function writeRuntimeState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: RuntimeStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof RuntimeStateUpdate>;
  for (const field of fields) {
    if (!RUNTIME_FIELDS.includes(field)) {
      throw new Error(`Unknown runtime state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}
