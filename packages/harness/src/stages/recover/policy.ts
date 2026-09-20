// Runtime-owned recovery policy. RECOVER no longer asks a model what to do when
// a stage fails: the decision follows from recorded Runtime facts, so the
// failure path costs no model request and cannot be talked out of a hard stop.
//
// - A structured-output decode failure is an internal formatting failure: retry
//   the stage that produced it once.
// - An unresolved or in-progress side effect ends the run with an explicit
//   Runtime status; the operation must never be executed again automatically.
// - A recorded permission denial stops and asks the user.
// - Everything else is retried at the failed stage under the recovery cap; when
//   the cap is exhausted the caller escalates to the user.
import type { RunContext, StageName, TaskStepFailureKind } from '@littlesheep/types';

export type RecoveryAction = 'retry' | 'escalate' | 'abort';

export interface RecoveryPlan {
  action: RecoveryAction;
  /** Target stage for `retry`; `exit` for `abort`; `ask_user` for `escalate`. */
  next: StageName | 'exit';
  reasonCode: string;
}

export function decideRecovery(ctx: RunContext, recoveryAttempts: number): RecoveryPlan {
  const lastError = ctx.lastError;
  // A cancelled run is never retried: the caller asked to stop, and re-issuing
  // the request would both ignore that and hang on an already-aborted signal.
  if (ctx.signal?.aborted) {
    return { action: 'abort', next: 'exit', reasonCode: 'run_aborted' };
  }
  if (isStructuredDecodeFailure(lastError) && recoveryAttempts === 1) {
    return {
      action: 'retry',
      next: retryStageFor(lastError?.stage),
      reasonCode: 'structured_decode_retry',
    };
  }

  if (hasUnsettledSideEffect(ctx)) {
    return { action: 'abort', next: 'exit', reasonCode: 'unsettled_side_effect' };
  }

  const kinds = recordedFailureKinds(ctx);
  if (kinds.includes('aborted')) {
    return { action: 'abort', next: 'exit', reasonCode: 'run_aborted' };
  }
  if (kinds.includes('permission_denied')) {
    return { action: 'escalate', next: 'ask_user', reasonCode: 'permission_denied' };
  }
  return {
    action: 'retry',
    next: retryStageFor(lastError?.stage),
    reasonCode: kinds.length > 0 ? `retryable_${kinds[0]!}` : 'retryable_failure',
  };
}

/** True when a recorded effect may still have taken place without a settlement. */
export function hasUnsettledSideEffect(ctx: RunContext): boolean {
  return (ctx.sideEffects ?? []).some((effect) => (
    effect.status === 'unknown' || effect.status === 'in_progress' || effect.status === 'planned'
  ));
}

export function recordedFailureKinds(ctx: RunContext): TaskStepFailureKind[] {
  const kinds: TaskStepFailureKind[] = [];
  for (const step of ctx.taskExecution?.steps ?? []) {
    if (step.failureKind) kinds.push(step.failureKind);
  }
  return kinds;
}

export function isStructuredDecodeFailure(error: RunContext['lastError']): boolean {
  if (!error) return false;
  return /(?:decode|invalid json|valid json|structured output|parse)/i.test(error.message);
}

export function retryStageFor(stage: StageName | undefined): StageName {
  switch (stage) {
    case 'classify':
    case 'decide':
    case 'execute':
    case 'verify':
    case 'reply':
      return stage;
    default:
      return 'execute';
  }
}
