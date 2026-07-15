import type {
  PartialReplanRequest,
  PlanStep,
  RunContext,
  TaskBook,
} from '@littlesheep/types';

export function renderReplanFeedback(ctx: RunContext, request: PartialReplanRequest): string {
  return `\n\n---\nPartial re-plan request (attempt ${request.attempt}):
Reason: ${request.reason}
Feedback: ${request.feedback}
Only these step ids may be revised: ${request.targetStepIds.join(', ')}
Previous task book: ${JSON.stringify(ctx.taskBook)}
Execution evidence: ${compactReplanEvidence(ctx, request)}

Return a complete taskBook using the SAME ids for existing steps.
- Preserve the original goal, success criteria, complexity, and scope limit.
- Do not modify completed steps or add unrelated scope.
- Revise only the listed failed/incomplete steps.
- Keep completed-step evidence as authoritative.`;
}

export function mergePartialTaskBook(
  previous: TaskBook,
  generated: TaskBook,
  request: PartialReplanRequest,
  ctx: RunContext,
): TaskBook {
  const targets = new Set(request.targetStepIds);
  const previousIds = previous.steps.map(resolveStepId);
  const nonTargetIds = new Set(previousIds.filter((id) => !targets.has(id)));
  const generatedById = new Map<string, PlanStep>();
  const replacementPool: PlanStep[] = [];

  generated.steps.forEach((step, index) => {
    const id = resolveStepId(step, index);
    if (targets.has(id)) generatedById.set(id, step);
    else if (!nonTargetIds.has(id)) replacementPool.push(step);
  });

  const completed = new Map((ctx.taskExecution?.steps ?? []).map((step) => [step.stepId, step]));
  const revisedStepIds: string[] = [];
  const steps = previous.steps.map((step, index): PlanStep => {
    const id = previousIds[index]!;
    if (!targets.has(id)) {
      return { ...step, id, status: completed.get(id)?.status === 'done' ? 'done' : step.status };
    }
    const replacement = generatedById.get(id) ?? replacementPool.shift();
    revisedStepIds.push(id);
    return { ...step, ...(replacement ?? {}), id, status: 'pending' };
  });

  const record = [...(ctx.replanHistory ?? [])]
    .reverse()
    .find((item) => item.attempt === request.attempt && item.requestedAt === request.requestedAt);
  if (record) {
    record.revisedStepIds = revisedStepIds;
    record.decidedAt = new Date().toISOString();
  }
  return {
    ...previous,
    steps,
    stageResults: previous.stageResults ?? ctx.taskExecution?.steps,
  };
}

function compactReplanEvidence(ctx: RunContext, request: PartialReplanRequest): string {
  const targets = new Set(request.targetStepIds);
  return JSON.stringify((ctx.taskExecution?.steps ?? []).map((step) => ({
    stepId: step.stepId,
    status: step.status,
    preserved: step.status === 'done' && !targets.has(step.stepId),
    output: step.output?.slice(0, 600),
    error: step.error,
    failureKind: step.failureKind,
  })));
}

function resolveStepId(step: PlanStep, index: number): string {
  return step.id ?? `step-${index + 1}`;
}
