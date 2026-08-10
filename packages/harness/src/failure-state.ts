import type { RunContext, StageName } from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** RunContext fields owned by failure detection and recovery control. */
export interface FailureStateUpdate {
  lastError?: RunContext['lastError'];
  recoveryAttempts?: number;
}

const FAILURE_FIELDS = ['lastError', 'recoveryAttempts'] as const satisfies readonly (keyof FailureStateUpdate)[];

/** Commit a validated failure-state batch before mutating RunContext. */
export function writeFailureState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: FailureStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof FailureStateUpdate>;
  for (const field of fields) {
    if (!FAILURE_FIELDS.includes(field)) {
      throw new Error(`Unknown failure state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Record one bounded stage failure for RECOVER and final status assembly. */
export function recordFailure(
  ctx: RunContext,
  stage: RunContextContractStage,
  errorStage: StageName,
  message: string,
  cause?: unknown,
): void {
  writeFailureState(ctx, stage, {
    lastError: { stage: errorStage, message, ...(cause === undefined ? {} : { cause }) },
  });
}

/** Clear a stale failure after a successful recovery or execution pass. */
export function clearFailure(ctx: RunContext, stage: RunContextContractStage): void {
  writeFailureState(ctx, stage, { lastError: undefined });
}

/** Increment and commit the bounded recovery attempt counter. */
export function incrementRecoveryAttempts(
  ctx: RunContext,
  stage: Extract<RunContextContractStage, 'runner-init' | 'recover' | 'runner-restore'>,
): number {
  const attempts = (ctx.recoveryAttempts ?? 0) + 1;
  writeFailureState(ctx, stage, { recoveryAttempts: attempts });
  return attempts;
}
