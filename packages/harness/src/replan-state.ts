import type {
  PartialReplanRequest,
  PlanStep,
  RunContext,
  TaskBook,
  TaskExecutionResult,
  TaskReplanRecord,
} from '@littlesheep/types';
import { assertRunContextFieldWriteAllowed, type RunContextContractStage } from '@littlesheep/types';

/** Fields whose writes must stay visible at the re-plan boundary. */
export interface ReplanStateUpdate {
  taskBook?: TaskBook;
  plan?: PlanStep[];
  taskBookRevision?: number;
  appliedTaskBookPatchIds?: string[];
  taskExecution?: TaskExecutionResult;
  replanAttempts?: number;
  verifyFeedback?: string;
  partialReplanRequest?: PartialReplanRequest;
  replanHistory?: TaskReplanRecord[];
}

const REPLAN_FIELDS = [
  'taskBook',
  'plan',
  'taskBookRevision',
  'appliedTaskBookPatchIds',
  'taskExecution',
  'replanAttempts',
  'verifyFeedback',
  'partialReplanRequest',
  'replanHistory',
] as const satisfies readonly (keyof ReplanStateUpdate)[];

/**
 * Commit one validated re-plan update. Validation happens before mutation so
 * an invalid batch cannot leave RunContext half-updated.
 */
export function writeReplanState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: ReplanStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof ReplanStateUpdate>;
  for (const field of fields) {
    if (!REPLAN_FIELDS.includes(field)) {
      throw new Error(`Unknown re-plan state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Replace one bounded history projection without mutating an existing record in place. */
export function updateReplanHistory(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: (record: TaskReplanRecord) => TaskReplanRecord,
): void {
  const replanHistory = (ctx.replanHistory ?? []).map((record) => update({ ...record }));
  writeReplanState(ctx, stage, {
    replanHistory,
    ...(ctx.taskExecution && stage === 'verify' ? {
      taskExecution: { ...ctx.taskExecution, replanHistory },
    } : {}),
  });
}
