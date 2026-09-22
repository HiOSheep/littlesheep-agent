import type {
  PartialReplanRequest,
  RunContext,
  TaskStepFailureKind,
  ToolInvocationStatus,
} from '@littlesheep/types';
import { writeReplanState } from '../../replan-state.js';

/**
 * Invocation statuses that make the recorded evidence unusable rather than
 * merely negative: a refused, invalid or unresolvable call leaves the runtime
 * unable to say what happened, so it still needs bounded recovery. A call that
 * ran and came back `failed`, `timed_out` or `aborted` is a recorded outcome
 * instead — see {@link recordedToolFailures}.
 */
const EVIDENCE_BLOCKING_INVOCATION_STATUSES = new Set<ToolInvocationStatus>([
  'approval_denied',
  'approval_unavailable',
  'hard_denied',
  'validation_failed',
  'unknown_tool',
  'repeated_call_blocked',
]);

/** Side-effect statuses that are still unresolved rather than settled. */
const UNSETTLED_EFFECT_STATUSES = new Set(['planned', 'in_progress', 'unknown']);

/**
 * Step-scoped replan targets derived only from recorded Runtime state: the steps
 * that actually failed or were blocked. Steps that never ran stay with the
 * normal plan instead of being rewritten, and completed steps are never rerun.
 *
 * Only steps this run recorded can be replanned. A plan restored from a
 * checkpoint that this run never executed is read-only history: with the second
 * executor deleted there is nothing to replan there, and treating it as an
 * incomplete plan would send the run back into the loop until recovery gave up.
 */
export function deriveReplanTargets(ctx: RunContext): string[] {
  const recorded = ctx.taskExecution?.steps ?? [];
  if (recorded.length === 0) return [];
  const knownIds = new Set(taskStepIds(ctx));
  const results = new Map(recorded.map((step) => [step.stepId, step]));
  const ordered = recorded.map((step) => step.stepId).filter((id) => knownIds.has(id));
  const failed = ordered.filter((id) => {
    const status = results.get(id)?.status;
    return status === 'failed' || status === 'blocked';
  });
  if (failed.length > 0) return failed;

  const incomplete = ordered.filter((id) => results.get(id)?.status !== 'done');
  if (incomplete.length > 0) return incomplete;
  return ordered.length > 0 ? [ordered[ordered.length - 1]!] : [];
}

export function canRecoverWithPartialReplan(ctx: RunContext, targetIds: string[]): boolean {
  if (!ctx.taskBook || targetIds.length === 0) return false;
  const kinds = failedKinds(ctx, targetIds);
  if (kinds.some((kind) => kind === 'permission_denied' || kind === 'model_error' || kind === 'aborted')) {
    return false;
  }
  return kinds.length === 0
    || kinds.some((kind) => kind === 'tool_error'
      || kind === 'not_found'
      || kind === 'verification_gap'
      || kind === 'unknown');
}

export function hasIncompleteTaskExecution(ctx: RunContext): boolean {
  if (!ctx.taskBook || !ctx.taskExecution) return false;
  const results = new Map(ctx.taskExecution.steps.map((step) => [step.stepId, step.status]));
  return taskStepIds(ctx).some((id) => results.get(id) !== 'done');
}

/** Runtime facts that a model verdict is not allowed to repair or hide. */
export function runtimeExecutionEvidenceGap(ctx: RunContext): string | undefined {
  // Step evidence is only owed for a plan this run actually executed. A plan
  // restored from a checkpoint is read-only history, so its untouched steps are
  // not an execution gap.
  if (ctx.taskBook && ctx.taskExecution && hasIncompleteTaskExecution(ctx)) {
    return 'failed or missing task step evidence';
  }
  if (ctx.taskExecution && ctx.taskExecution.status !== 'done') {
    return `task execution status is ${ctx.taskExecution.status}`;
  }
  if (ctx.toolInvocationsTruncated) return 'tool invocation evidence is truncated';

  const invocations = ctx.toolInvocations ?? [];
  const callIds = new Set<string>();
  const activeInvocations = invocations.filter((invocation, index) => !(
    invocation.status !== 'succeeded'
    && invocation.stepId
    && invocations.slice(index + 1).some((candidate) => (
      candidate.stepId === invocation.stepId && candidate.status === 'succeeded'
    ))
  ));
  for (const invocation of invocations) {
    if (callIds.has(invocation.callId)) return `duplicate tool invocation ${invocation.callId}`;
    callIds.add(invocation.callId);
  }
  for (const invocation of activeInvocations) {
    if (EVIDENCE_BLOCKING_INVOCATION_STATUSES.has(invocation.status)) {
      return `tool invocation ${invocation.callId} is ${invocation.status}`;
    }
    if (invocation.outputTruncated) return `tool invocation ${invocation.callId} output is truncated`;
  }

  if (activeInvocations.length > 0) {
    const results = new Map((ctx.toolResults ?? []).map((result) => [result.callId, result]));
    for (const invocation of activeInvocations) {
      // A missing result is a gap; a recorded failed result is evidence.
      if (!results.has(invocation.callId)) return `tool result ${invocation.callId} is missing`;
    }
  }

  for (const effect of ctx.sideEffects ?? []) {
    if (UNSETTLED_EFFECT_STATUSES.has(effect.status)) {
      return `side effect ${effect.idempotencyKey} is ${effect.status}`;
    }
    if (!effect.callId || !callIds.has(effect.callId)) {
      if (!hasLegacyCheckpointToolResult(ctx, effect.callId)) {
        return `side effect ${effect.idempotencyKey} has no matching tool invocation`;
      }
      continue;
    }
    const invocation = invocations.find((candidate) => candidate.callId === effect.callId);
    if (!invocation || invocation.toolName !== effect.toolName) {
      return `side effect ${effect.idempotencyKey} tool identity does not match its invocation`;
    }
  }
  return undefined;
}

/**
 * Negative outcomes the run recorded. They are not an evidence gap: the runtime
 * knows exactly what happened, so the model's answer can be published — but the
 * verdict must never become `pass`, and the failure stays in the record.
 */
export function recordedToolFailures(ctx: RunContext, limit = 5): string[] {
  const failures: string[] = [];
  for (const invocation of ctx.toolInvocations ?? []) {
    if (invocation.status === 'failed' || invocation.status === 'timed_out' || invocation.status === 'aborted') {
      failures.push(`tool invocation ${invocation.callId} is ${invocation.status}`);
    }
  }
  for (const effect of ctx.sideEffects ?? []) {
    if (effect.status === 'failed' || effect.status === 'cancelled') {
      failures.push(`side effect ${effect.idempotencyKey} is ${effect.status}`);
    }
  }
  return failures.slice(0, limit);
}

function hasLegacyCheckpointToolResult(ctx: RunContext, callId: string | undefined): boolean {
  if (!callId || !ctx.resumedFromCheckpointId || (ctx.toolInvocations?.length ?? 0) > 0) return false;
  return (ctx.taskExecution?.steps ?? []).some((step) => (
    step.toolResults.some((result) => result.callId === callId && result.ok)
    && step.toolCallIds.includes(callId)
  ));
}

export function installPartialReplan(
  ctx: RunContext,
  targetStepIds: string[],
  reason: string,
  feedback: string,
  attempt: number,
): PartialReplanRequest {
  const request: PartialReplanRequest = {
    attempt,
    requestedAt: new Date().toISOString(),
    targetStepIds,
    reason,
    feedback,
  };
  const targets = new Set(targetStepIds);
  const completed = new Set(
    (ctx.taskExecution?.steps ?? [])
      .filter((step) => step.status === 'done')
      .map((step) => step.stepId),
  );
  const preservedStepIds = taskStepIds(ctx).filter((id) => completed.has(id) && !targets.has(id));
  const replanHistory = [
    ...(ctx.replanHistory ?? ctx.taskExecution?.replanHistory ?? []),
    { ...request, preservedStepIds },
  ];
  writeReplanState(ctx, 'verify', {
    partialReplanRequest: request,
    replanHistory,
    ...(ctx.taskExecution ? { taskExecution: { ...ctx.taskExecution, replanHistory } } : {}),
  });
  return request;
}

function taskStepIds(ctx: RunContext): string[] {
  return ctx.taskBook?.steps.map((step, index) => step.id ?? `step-${index + 1}`) ?? [];
}

function failedKinds(ctx: RunContext, targetIds: string[]): TaskStepFailureKind[] {
  const targets = new Set(targetIds);
  return (ctx.taskExecution?.steps ?? [])
    .filter((step) => targets.has(step.stepId) && step.failureKind)
    .map((step) => step.failureKind!);
}
