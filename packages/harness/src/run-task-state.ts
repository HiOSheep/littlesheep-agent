import type {
  PlanStep,
  RunContext,
  TaskBook,
  TaskExecutionResult,
  WorkPolicyUpgradeRequest,
} from '@littlesheep/types';
import { assertRunContextFieldWriteAllowed, type RunContextContractStage } from '@littlesheep/types';

/** Fields whose writes must stay visible at the Runtime task-state boundary. */
export interface RunTaskStateUpdate {
  taskBook?: TaskBook;
  plan?: PlanStep[];
  taskBookRevision?: number;
  appliedTaskBookPatchIds?: string[];
  taskExecution?: TaskExecutionResult;
  workPolicyUpgradeRequest?: WorkPolicyUpgradeRequest;
}

const RUN_TASK_STATE_FIELDS = [
  'taskBook',
  'plan',
  'taskBookRevision',
  'appliedTaskBookPatchIds',
  'taskExecution',
  'workPolicyUpgradeRequest',
] as const satisfies readonly (keyof RunTaskStateUpdate)[];

/**
 * Commit one validated run task-state update. Validation happens before mutation so
 * an invalid batch cannot leave RunContext half-updated.
 */
export function writeRunTaskState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: RunTaskStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof RunTaskStateUpdate>;
  for (const field of fields) {
    if (!RUN_TASK_STATE_FIELDS.includes(field)) {
      throw new Error(`Unknown run task-state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}
