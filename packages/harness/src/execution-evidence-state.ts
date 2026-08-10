import type {
  RunContext,
  SideEffectCheckpoint,
  ToolInvocationRecord,
  ToolResult,
} from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** Top-level execution evidence retained on RunContext. */
export interface ExecutionEvidenceStateUpdate {
  toolResults?: RunContext['toolResults'];
  toolInvocations?: RunContext['toolInvocations'];
  toolInvocationsTruncated?: boolean;
  sideEffects?: RunContext['sideEffects'];
}

const EXECUTION_EVIDENCE_FIELDS = [
  'toolResults',
  'toolInvocations',
  'toolInvocationsTruncated',
  'sideEffects',
] as const satisfies readonly (keyof ExecutionEvidenceStateUpdate)[];

/** Validate a complete execution-evidence batch before changing RunContext. */
export function writeExecutionEvidenceState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: ExecutionEvidenceStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof ExecutionEvidenceStateUpdate>;
  for (const field of fields) {
    if (!EXECUTION_EVIDENCE_FIELDS.includes(field)) {
      throw new Error(`Unknown execution evidence field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Replace the EXECUTE result projection without retaining a mutable caller array. */
export function replaceToolResults(
  ctx: RunContext,
  stage: Extract<RunContextContractStage, 'execute'>,
  results: readonly ToolResult[],
): void {
  writeExecutionEvidenceState(ctx, stage, { toolResults: [...results] });
}

/** Upsert one authoritative invocation record and preserve the truncation latch. */
export function upsertToolInvocationEvidence(
  ctx: RunContext,
  stage: Extract<RunContextContractStage, 'execute'>,
  record: ToolInvocationRecord,
  state: { retained: boolean; truncated: boolean },
): void {
  const update: ExecutionEvidenceStateUpdate = {};
  if (state.truncated && ctx.toolInvocationsTruncated !== true) {
    update.toolInvocationsTruncated = true;
  }
  if (state.retained) {
    const records = [...(ctx.toolInvocations ?? [])];
    const index = records.findIndex((candidate) => candidate.id === record.id);
    const retained = structuredClone(record);
    if (index >= 0) records[index] = retained;
    else records.push(retained);
    update.toolInvocations = records;
  }
  if (Object.keys(update).length > 0) writeExecutionEvidenceState(ctx, stage, update);
}

/** Replace the bounded side-effect ledger with detached checkpoint records. */
export function replaceSideEffectEvidence(
  ctx: RunContext,
  stage: Extract<RunContextContractStage, 'runner-init' | 'execute' | 'runner-restore'>,
  sideEffects: readonly SideEffectCheckpoint[],
): void {
  writeExecutionEvidenceState(ctx, stage, {
    sideEffects: sideEffects.map((effect) => ({
      ...effect,
      ...(effect.resourceKeys ? { resourceKeys: [...effect.resourceKeys] } : {}),
    })),
  });
}
