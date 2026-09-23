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
import { classifyStepFailure } from '../execute/failure-policy.js';

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
  // A spent budget is the one failure retrying cannot change: the ceiling is
  // recorded on the run, so the retried stage re-enters it already exhausted and
  // fails again. Measured on a real acceptance run, that produced four whole
  // execute rounds — each with its own model calls — that could not have
  // succeeded, and only then the same escalation. Escalate on the first
  // detection instead, and let the escalation name the budget.
  if (isExhaustedBudgetFailure(lastError)) {
    return { action: 'escalate', next: 'ask_user', reasonCode: 'execution_budget_exhausted' };
  }
  return {
    action: 'retry',
    next: retryStageFor(lastError?.stage),
    reasonCode: kinds.length > 0 ? `retryable_${kinds[0]!}` : 'retryable_failure',
  };
}

/**
 * Failures that a bounded retry cannot fix because the run's own budget is gone.
 *
 * Only the wording the Runtime itself writes for a ceiling counts here: a
 * transient provider error carries different text and still deserves its retry.
 */
export function isExhaustedBudgetFailure(error: RunContext['lastError']): boolean {
  const message = error?.message;
  if (!message) return false;
  return /(tool loop exceeded|model call budget exhausted|tool loop iteration budget|run budget)/iu.test(message);
}

/** True when a recorded effect may still have taken place without a settlement. */
export function hasUnsettledSideEffect(ctx: RunContext): boolean {
  return (ctx.sideEffects ?? []).some((effect) => (
    effect.status === 'unknown' || effect.status === 'in_progress' || effect.status === 'planned'
  ));
}

/**
 * The failure kinds a run actually recorded.
 *
 * TaskBook step results were the only source until the step executor was
 * deleted. Nothing writes `taskExecution` in the single main loop any more, so
 * this returned an empty list for every ordinary run — which silently disabled
 * the permission and cancellation branches below and made every failure retry
 * until the budget ran out. The fallback reads the evidence the loop does record:
 * the invocation statuses the tool boundary published and the latest failure text.
 */
export function recordedFailureKinds(ctx: RunContext): TaskStepFailureKind[] {
  const kinds: TaskStepFailureKind[] = [];
  for (const step of ctx.taskExecution?.steps ?? []) {
    if (step.failureKind) kinds.push(step.failureKind);
  }
  if (kinds.length > 0) return kinds;
  return recordedFailureKindsFromEvidence(ctx);
}

function recordedFailureKindsFromEvidence(ctx: RunContext): TaskStepFailureKind[] {
  const kinds: TaskStepFailureKind[] = [];
  const invocations = ctx.toolInvocations ?? [];
  if (invocations.some((invocation) => (
    invocation.status === 'approval_denied'
    || invocation.status === 'hard_denied'
    || invocation.status === 'approval_unavailable'
    || invocation.errorKind === 'core_source_read_only'
  ))) {
    kinds.push('permission_denied');
  }
  if (invocations.some((invocation) => invocation.status === 'aborted')) kinds.push('aborted');
  // Only the latest failure text is classified. Scanning every recorded failure
  // would let a fixed problem from earlier in the run decide how the *current*
  // one is handled.
  const message = ctx.lastError?.message;
  if (message) kinds.push(classifyStepFailure(message, []));
  return [...new Set(kinds)];
}

export function isStructuredDecodeFailure(error: RunContext['lastError']): boolean {
  if (!error) return false;
  return /(?:decode|invalid json|valid json|structured output|parse)/i.test(error.message);
}

export function retryStageFor(stage: StageName | undefined): StageName {
  switch (stage) {
    case 'classify':
    case 'execute':
    case 'verify':
    case 'reply':
      return stage;
    // A legacy checkpoint can still name DECIDE (or any other retired stage) as
    // the failing stage. That stage no longer exists, and dispatching to it would
    // exit with "no stage registered"; retrying means re-entering the main loop.
    default:
      return 'execute';
  }
}
