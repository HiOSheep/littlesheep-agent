import type {
  CompactionSummary,
  MemoryContinuityAssessment,
  MemoryPrelude,
  MemoryIntentDecisionRecord,
  RunContext,
  RuntimeMemoryContextWorkingSet,
  RuntimeMemoryKnownState,
} from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** RunContext fields owned by the top-level Memory state boundary. */
export interface MemoryStateUpdate {
  prelude?: MemoryPrelude;
  sessionSummary?: CompactionSummary;
  memoryRootIndex?: string;
  initialMemoryContext?: string;
  memoryKnownState?: RuntimeMemoryKnownState;
  memoryContinuityAssessment?: MemoryContinuityAssessment;
  memoryContextWorkingSet?: RuntimeMemoryContextWorkingSet;
  evolutionNotes?: string[];
  insights?: string[];
  memoryIntentDecisions?: MemoryIntentDecisionRecord[];
}

const MEMORY_FIELDS = [
  'prelude',
  'sessionSummary',
  'memoryRootIndex',
  'initialMemoryContext',
  'memoryKnownState',
  'memoryContinuityAssessment',
  'memoryContextWorkingSet',
  'evolutionNotes',
  'insights',
  'memoryIntentDecisions',
] as const satisfies readonly (keyof MemoryStateUpdate)[];

/**
 * Validate a complete Memory update before mutating RunContext. This keeps
 * bootstrap, evidence, working-set and stage output writes auditable while
 * leaving persistent Memory Repository transactions in their own domain.
 */
export function writeMemoryState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: MemoryStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof MemoryStateUpdate>;
  for (const field of fields) {
    if (!MEMORY_FIELDS.includes(field)) {
      throw new Error(`Unknown memory state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}
