import type { RunContext, StageResult } from '@littlesheep/types';
import {
  buildAssessmentAndTaskBook,
  buildClarificationRequest,
  buildMinimalFallbackPlan,
  compactLightweightPlan,
  normalizePlan,
} from './normalization.js';
import { mergePartialTaskBook } from './replan.js';
import type { DecideStageDeps, DecodedPlan } from './contracts.js';
import type { DecideRequest } from './request.js';
import { maybeRefineMemoryForTaskBook } from '../../memory-taskbook-refinement.js';
import { renderClarificationMessage } from '../clarification-message.js';
import { reserveUserFacingReplyOnce } from '../../user-facing-reply.js';
import { writeReplanState } from '../../replan-state.js';
import { writeRuntimeState } from '../../runtime-state.js';

export async function adoptDecodedDecision(
  deps: DecideStageDeps,
  ctx: RunContext,
  request: DecideRequest,
  parsed: DecodedPlan,
  attempts: number,
): Promise<StageResult> {
  const availableToolNames = new Set(ctx.tools.map((tool) => tool.name));
  const proposalToolNames = request.proposalToolNames
    ? new Set(request.proposalToolNames)
    : undefined;
  let plan = normalizePlan(parsed.taskBook?.steps, availableToolNames, proposalToolNames);
  if (plan.length === 0) plan = normalizePlan(parsed.plan, availableToolNames, proposalToolNames);
  let usedMinimalFallback = false;
  if (plan.length === 0 && parsed.assessment?.needsClarification !== true) {
    plan = buildMinimalFallbackPlan(parsed, request.inboundText, availableToolNames);
    usedMinimalFallback = plan.length > 0;
  }
  if (plan.length === 0 && parsed.assessment?.needsClarification === true) {
    plan = [clarificationStep()];
  }
  if (plan.length === 0) return failDecision(ctx, 'decoded decision had no valid steps');

  const built = buildAssessmentAndTaskBook(parsed, plan, request.inboundText);
  let assessment = built.assessment;
  let taskBook = built.taskBook;
  if (!request.partialReplan && !assessment.needsClarification && !assessment.requiresTaskBook) {
    plan = compactLightweightPlan(plan, assessment.goal, assessment.successCriteria);
    taskBook = { ...taskBook, steps: plan };
  }

  const reusedExistingTaskBook = Boolean(request.previousTaskBook && !request.replanRequested);
  if (reusedExistingTaskBook && request.previousTaskBook) {
    assessment = request.previousTaskBook.assessment;
    taskBook = request.previousTaskBook;
    plan = request.previousTaskBook.steps;
  }
  const taskBookRevision = resolveTaskBookRevision({
    previousTaskBook: request.previousTaskBook,
    currentRevision: ctx.taskBookRevision,
    replanRequested: request.replanRequested,
  });

  if (assessment.needsClarification && !reusedExistingTaskBook) {
    ctx.needAssessment = assessment;
    writeReplanState(ctx, 'decide', { taskBook, plan, taskBookRevision });
    consumeDecisionInputs(ctx, request.deferredRuntimeEvents);
    ctx.clarificationRequest = buildClarificationRequest(
      parsed,
      assessment,
      request.inboundText,
      ctx.runId,
      new Date().toISOString(),
    );

    // DECIDE already received and validated model-authored clarification copy.
    // Publish it directly when it is complete; the separate ASK_USER model
    // call remains the compatibility path for runtime-generated fallbacks or
    // duplicate text that needs a fresh wording pass.
    if (ctx.clarificationRequest.copySource === 'model') {
      const visible = renderClarificationMessage(ctx.clarificationRequest);
      let reserved: string | undefined;
      try {
        reserved = await reserveUserFacingReplyOnce(ctx, request.callPurpose, visible);
      } catch (error) {
        return failDecision(ctx, `clarification reply reservation failed: ${(error as Error).message}`);
      }
      if (reserved) {
        ctx.clarificationRequest.prompt = reserved;
        return {
          stage: 'decide',
          next: 'finalize',
          ok: true,
          meta: {
            complexity: assessment.complexity,
            needsClarification: true,
            directClarification: true,
            missingInfo: assessment.missingInfo,
            clarificationRequestId: ctx.clarificationRequest.id,
            taskBookRevision,
            deferredRuntimeEventIds: request.deferredRuntimeEvents.map((event) => event.id),
            llmAttempts: attempts,
          },
        };
      }
    }
    return {
      stage: 'decide',
      next: 'ask_user',
      ok: true,
      meta: {
        complexity: assessment.complexity,
        needsClarification: true,
        missingInfo: assessment.missingInfo,
        clarificationRequestId: ctx.clarificationRequest.id,
        taskBookRevision,
        deferredRuntimeEventIds: request.deferredRuntimeEvents.map((event) => event.id),
        llmAttempts: attempts,
      },
    };
  }

  if (request.partialReplan && request.previousTaskBook) {
    taskBook = mergePartialTaskBook(request.previousTaskBook, taskBook, request.partialReplan, ctx);
    assessment = request.previousTaskBook.assessment;
    plan = taskBook.steps;
  }
  const memoryRefinement = await maybeRefineMemoryForTaskBook(
    ctx,
    taskBook,
    deps.memoryRefiner,
    request.partialReplan ? 'replan' : 'taskbook',
    request.partialReplan?.targetStepIds,
    deps.log,
  );
  ctx.needAssessment = assessment;
  writeReplanState(ctx, 'decide', { taskBook, plan, taskBookRevision });
  consumeDecisionInputs(ctx, request.deferredRuntimeEvents);
  ctx.onToolEvent?.({ type: 'task_book', taskBook });
  return {
    stage: 'decide',
    next: 'execute',
    ok: true,
    meta: {
      planSteps: plan.length,
      complexity: assessment.complexity,
      maxExtraScopeRatio: assessment.maxExtraScopeRatio,
      requiresTaskBook: assessment.requiresTaskBook,
      taskBookRevision,
      reusedExistingTaskBook,
      partialReplan: request.partialReplan
        ? { attempt: request.partialReplan.attempt, targetStepIds: request.partialReplan.targetStepIds }
        : undefined,
      deferredRuntimeEventIds: request.deferredRuntimeEvents.map((event) => event.id),
      memoryRefinement,
      usedMinimalFallback,
      llmAttempts: attempts,
    },
  };
}

function clarificationStep() {
  return {
    id: 'clarify',
    title: 'Clarify missing information',
    description: 'Ask the user for the missing information before executing.',
    acceptanceCriteria: ['The user supplies the blocking information.'],
    status: 'pending' as const,
  };
}

function failDecision(ctx: RunContext, message: string): StageResult {
  ctx.lastError = { stage: 'decide', message };
  return { stage: 'decide', next: 'recover', ok: false, error: message };
}

function resolveTaskBookRevision(options: {
  previousTaskBook?: RunContext['taskBook'];
  currentRevision?: number;
  replanRequested: boolean;
}): number {
  const current = Number.isSafeInteger(options.currentRevision) && (options.currentRevision ?? 0) > 0
    ? options.currentRevision!
    : options.previousTaskBook
      ? 1
      : 0;
  if (!options.previousTaskBook) return 1;
  if (!options.replanRequested) return Math.max(1, current);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, current) + 1);
}

function consumeDecisionInputs(
  ctx: RunContext,
  events: RunContext['deferredRuntimeEvents'],
): void {
  const update: {
    deferredRuntimeEvents: [];
    deferredRuntimeEventIds?: string[];
  } = { deferredRuntimeEvents: [] };
  if (events && events.length > 0) {
    const ids = [
      ...(ctx.deferredRuntimeEventIds ?? []),
      ...events.map((event) => event.id),
    ];
    update.deferredRuntimeEventIds = [...new Set(ids)].slice(-128);
  }
  // Payloads are no longer needed in the active prompt after adoption.
  writeRuntimeState(ctx, 'decide', update);
  writeReplanState(ctx, 'decide', { verifyFeedback: undefined });
}
