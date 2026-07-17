// DECIDE orchestration facade: model call, normalization and state routing.
import type { ChatMessage } from '@littlesheep/llm';
import type { RunContext, StageResult } from '@littlesheep/types';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { appendSystemPromptBundleAddons } from '../profile-prompt.js';
import {
  attachmentContextMessages,
  callLlmForJson,
  textOf,
  toChatMessage,
  userChatMessage,
} from './_shared.js';
import {
  DECIDE_SYSTEM_PROMPT,
  type DecideStageDeps,
  type DecodedPlan,
} from './decide/contracts.js';
import {
  buildAssessmentAndTaskBook,
  buildClarificationRequest,
  compactLightweightPlan,
  normalizePlan,
} from './decide/normalization.js';
import { mergePartialTaskBook, renderReplanFeedback } from './decide/replan.js';
import { maybeRefineMemoryForTaskBook } from '../memory-taskbook-refinement.js';
export type { DecideStageDeps } from './decide/contracts.js';
export function createDecideStage(deps: DecideStageDeps) {
  return async function decideStage(ctx: RunContext): Promise<StageResult> {
    const resolved = resolvePromptConfig(deps.config, deps.branding);
    const baseSystemPrompt = await assembleSystemPromptBundle(resolved, {
      tools: ctx.tools,
      bootstrap: ctx.bootstrap ?? {},
      prelude: ctx.prelude,
      sessionSummary: ctx.sessionSummary,
      memoryRootIndex: ctx.memoryRootIndex,
      initialMemoryContext: ctx.initialMemoryContext,
    });
    const systemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [
      {
        id: 'decide-contract',
        text: DECIDE_SYSTEM_PROMPT,
        kind: 'workflow_state',
        source: { kind: 'workflow', id: 'decide-contract', runId: ctx.runId },
      },
      { id: 'profile', text: ctx.profilePromptAddon },
      { id: 'reasoning', text: ctx.reasoningPromptAddon },
    ]);
    const previousTaskBook = ctx.taskBook;
    const partialReplan = ctx.partialReplanRequest;
    const verifyFeedback = partialReplan && previousTaskBook
      ? renderReplanFeedback(ctx, partialReplan)
      : ctx.verifyFeedback
        ? `\n\n---\nPrevious plan did not achieve the goal. Verify feedback:\n${ctx.verifyFeedback}\nPlease produce a REVISED assessment and taskBook that addresses this feedback.`
        : '';
    ctx.verifyFeedback = undefined;

    const inboundText = textOf(ctx.inbound) || '(empty message)';
    const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt.text },
      ...ctx.history.map(toChatMessage),
      ...attachmentMessages.map((item) => item.message),
      userChatMessage(inboundText + verifyFeedback, ctx.attachments),
    ];
    let parsed: DecodedPlan | null;
    let attempts: number;
    try {
      ({ parsed, attempts } = await callLlmForJson<DecodedPlan>(deps.llm, deps.model, messages, {
        maxAttempts: 3,
        maxTokens: 1800,
        signal: ctx.signal,
        onRequest: (request) => prepareModelRequest(
          ctx,
          'decide',
          request,
          buildRunRequestCandidates(ctx, 'decide', request.messages, {
            systemSegments: systemPrompt.segments,
            insertedBeforePrimary: attachmentMessages.map((item) => item.context),
          }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
      }));
    } catch (error) {
      ctx.lastError = { stage: 'decide', message: `transport error: ${(error as Error).message}` };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }
    if (!parsed) {
      ctx.lastError = { stage: 'decide', message: `failed to decode decision after ${attempts} attempt(s)` };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }

    const availableToolNames = new Set(ctx.tools.map((tool) => tool.name));
    let plan = normalizePlan(parsed.taskBook?.steps, availableToolNames);
    if (plan.length === 0) plan = normalizePlan(parsed.plan, availableToolNames);
    if (plan.length === 0 && parsed.assessment?.needsClarification === true) {
      plan = [{
        id: 'clarify',
        title: 'Clarify missing information',
        description: 'Ask the user for the missing information before executing.',
        acceptanceCriteria: ['The user supplies the blocking information.'],
        status: 'pending',
      }];
    }
    if (plan.length === 0) {
      ctx.lastError = { stage: 'decide', message: 'decoded decision had no valid steps' };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }

    const built = buildAssessmentAndTaskBook(parsed, plan, inboundText);
    let assessment = built.assessment;
    let taskBook = built.taskBook;
    if (!partialReplan && !assessment.needsClarification && !assessment.requiresTaskBook) {
      plan = compactLightweightPlan(plan, assessment.goal, assessment.successCriteria);
      taskBook = { ...taskBook, steps: plan };
    }
    if (assessment.needsClarification) {
      ctx.needAssessment = assessment;
      ctx.taskBook = taskBook;
      ctx.plan = plan;
      ctx.clarificationRequest = buildClarificationRequest(
        parsed,
        assessment,
        inboundText,
        ctx.runId,
        new Date().toISOString(),
      );
      return {
        stage: 'decide',
        next: 'ask_user',
        ok: true,
        meta: {
          complexity: assessment.complexity,
          needsClarification: true,
          missingInfo: assessment.missingInfo,
          clarificationRequestId: ctx.clarificationRequest.id,
          llmAttempts: attempts,
        },
      };
    }
    if (partialReplan && previousTaskBook) {
      taskBook = mergePartialTaskBook(previousTaskBook, taskBook, partialReplan, ctx);
      assessment = previousTaskBook.assessment;
      plan = taskBook.steps;
    }

    ctx.needAssessment = assessment;
    ctx.taskBook = taskBook;
    ctx.plan = plan;
    await maybeRefineMemoryForTaskBook(ctx, taskBook, deps.memoryRefiner, partialReplan ? 'replan' : 'taskbook', partialReplan?.targetStepIds, deps.log);
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
        partialReplan: partialReplan
          ? { attempt: partialReplan.attempt, targetStepIds: partialReplan.targetStepIds }
          : undefined,
        llmAttempts: attempts,
      },
    };
  };
}
