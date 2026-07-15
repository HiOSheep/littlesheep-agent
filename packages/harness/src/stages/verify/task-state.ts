import type {
  PartialReplanRequest,
  RunContext,
  TaskStepFailureKind,
} from '@littlesheep/types';

export function deriveReplanTargets(ctx: RunContext, requested: unknown): string[] {
  const knownIds = taskStepIds(ctx);
  const known = new Set(knownIds);
  const explicit = Array.isArray(requested)
    ? requested.filter((id): id is string => typeof id === 'string' && known.has(id))
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];

  const results = new Map((ctx.taskExecution?.steps ?? []).map((step) => [step.stepId, step]));
  const incomplete = knownIds.filter((id) => results.get(id)?.status !== 'done');
  if (incomplete.length > 0) return incomplete;
  return knownIds.length > 0 ? [knownIds[knownIds.length - 1]!] : [];
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
  ctx.partialReplanRequest = request;
  ctx.replanHistory = [
    ...(ctx.replanHistory ?? ctx.taskExecution?.replanHistory ?? []),
    { ...request, preservedStepIds },
  ];
  if (ctx.taskExecution) ctx.taskExecution.replanHistory = ctx.replanHistory;
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
