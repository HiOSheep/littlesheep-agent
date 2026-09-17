import type {
  CompactionSummary,
  MemoryContinuityAssessment,
  MemoryPrelude,
  MemoryIntentDecisionRecord,
  MemoryReuseCounts,
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

/** Run-cumulative local embedding reuse recorded by the memory stages. */
export function sumMemoryReuse(ctx: RunContext): MemoryReuseCounts | undefined {
  let reused = 0;
  let queued = 0;
  let disabled = 0;
  for (const record of ctx.memoryIntentDecisions ?? []) {
    if (!record.embeddingReuse) continue;
    reused += record.embeddingReuse.reused;
    queued += record.embeddingReuse.queued;
    disabled += record.embeddingReuse.disabled;
  }
  return reused + queued === 0 ? undefined : { reused, queued, disabled };
}
