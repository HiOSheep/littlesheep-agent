// Owns legacy and TaskBook execution orchestration; delegates tool loops, failure policy, and final reply synthesis.
import type { SystemPromptBundle } from '@littlesheep/prompt';
import { appendSystemPromptBundleAddons, buildUserFacingVoiceAddon } from '../../profile-prompt.js';
import type {
  RunContext,
  StageResult,
  TaskBook,
  TaskExecutionResult,
  TaskStepResult,
  ToolResult,
} from '@littlesheep/types';
import { attachmentContextMessages } from '../_shared.js';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import {
  blockingToolFailureReason,
  classifyStepFailure,
  hasBlockingToolFailure,
  orderedStepResults,
  pickStepTools,
  resolveStepId,
} from './failure-policy.js';
import { synthesizeFinalReply } from './final-reply.js';
import { buildBaseMessages, renderStepGuidance } from './guidance.js';
import { applyUsage, runToolLoop } from './tool-loop.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../../user-facing-reply.js';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../../model-observability.js';

export async function executeLegacyLoop(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  sanitizeOpts: ExecuteSanitizeOptions,
): Promise<StageResult> {
  const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
  const result = await runToolLoop(deps, {
    ctx,
    messages: buildBaseMessages(ctx, systemPrompt.text, attachmentMessages),
    tools: ctx.tools,
    sanitizeOpts,
    systemSegments: systemPrompt.segments,
    insertedBeforePrimary: attachmentMessages.map((item) => item.context),
  });
  ctx.toolResults = result.toolResults;
  if (!result.ok) {
    ctx.lastError = { stage: 'execute', message: result.error ?? 'execute failed' };
    return { stage: 'execute', next: 'recover', ok: false, error: ctx.lastError.message };
  }
  applyUsage(ctx, result.usage);
  try {
    ctx.reply = await acceptUniqueUserFacingReply(
      ctx,
      'execute_tool_loop',
      result.content,
      (input) => rewriteLegacyExecutionReply(deps, ctx, systemPrompt, input),
    );
  } catch (error) {
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;
    ctx.lastError = { stage: 'execute', message: `user-facing execution reply generation failed: ${(error as Error).message}` };
    return { stage: 'execute', next: 'recover', ok: false, error: ctx.lastError.message };
  }
  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: { iterations: result.iterations, toolCalls: result.toolResults.length },
  };
}

export async function executeTaskBook(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  baseSystemPrompt: SystemPromptBundle,
  taskBook: TaskBook,
  sanitizeOpts: ExecuteSanitizeOptions,
): Promise<StageResult> {
  const startedAt = new Date().toISOString();
  const previousExecution = ctx.taskExecution?.goal === taskBook.goal ? ctx.taskExecution : undefined;
  const resumeRequest = ctx.partialReplanRequest;
  const resumeTargets = new Set(resumeRequest?.targetStepIds ?? []);
  const previousById = new Map((previousExecution?.steps ?? []).map((step) => [step.stepId, step]));
  const resultsById = new Map<string, TaskStepResult>(
    (previousExecution?.steps ?? []).map((step) => [step.stepId, { ...step, toolResults: [...step.toolResults] }]),
  );
  const execution: TaskExecutionResult = {
    goal: taskBook.goal,
    complexity: taskBook.complexity,
    status: 'running',
    startedAt: previousExecution?.startedAt ?? startedAt,
    steps: orderedStepResults(taskBook, resultsById),
    replanHistory: ctx.replanHistory ?? previousExecution?.replanHistory,
  };
  ctx.taskExecution = execution;
  taskBook.stageResults = execution.steps;

  const allToolResults: ToolResult[] = (previousExecution?.steps ?? [])
    .filter((step) => step.status === 'done' && !resumeTargets.has(step.stepId))
    .flatMap((step) => step.toolResults);
  if (resumeRequest) {
    const record = [...(ctx.replanHistory ?? [])]
      .reverse()
      .find((item) => item.attempt === resumeRequest.attempt && item.requestedAt === resumeRequest.requestedAt);
    if (record) record.resumedAt = startedAt;
  }
  ctx.partialReplanRequest = undefined;

  const syncExecutionSteps = () => {
    execution.steps = orderedStepResults(taskBook, resultsById);
    taskBook.stageResults = execution.steps;
  };

  for (let index = 0; index < taskBook.steps.length; index++) {
    const step = taskBook.steps[index]!;
    const stepId = resolveStepId(step, index);
    const previousResult = previousById.get(stepId);
    if (previousResult?.status === 'done' && !resumeTargets.has(stepId)) {
      step.status = 'done';
      ctx.onToolEvent?.({
        type: 'step_skipped',
        stepId,
        title: step.title,
        description: step.description,
        status: 'done',
        summary: 'Preserved from a previous execution attempt.',
      });
      continue;
    }

    step.status = 'in_progress';
    const stepResult: TaskStepResult = {
      stepId,
      title: step.title,
      description: step.description,
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      acceptanceCriteria: step.acceptanceCriteria,
      expectedOutput: step.expectedOutput,
      attempt: (previousResult?.attempt ?? (previousResult ? 1 : 0)) + 1,
      toolCallIds: [],
      toolResults: [],
    };
    resultsById.set(stepId, stepResult);
    syncExecutionSteps();
    ctx.onToolEvent?.({
      type: 'step_start',
      stepId,
      title: step.title,
      description: step.description,
      status: 'in_progress',
    });

    const stepSystemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [{
      id: `step-contract:${stepId}`,
      text: renderStepGuidance(
        taskBook,
        step,
        stepId,
        index,
        taskBook.steps.length,
        taskBook.steps
          .slice(0, index)
          .map((priorStep, priorIndex) => resultsById.get(resolveStepId(priorStep, priorIndex)))
          .filter((result): result is TaskStepResult => !!result),
      ),
      kind: 'workflow_state',
      source: { kind: 'workflow', id: `step-contract:${stepId}`, runId: ctx.runId },
    }]);
    const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
    const loopResult = await runToolLoop(deps, {
      ctx,
      messages: buildBaseMessages(ctx, stepSystemPrompt.text, attachmentMessages),
      tools: pickStepTools(step, ctx.tools),
      sanitizeOpts,
      stepId,
      systemSegments: stepSystemPrompt.segments,
      insertedBeforePrimary: attachmentMessages.map((item) => item.context),
    });

    allToolResults.push(...loopResult.toolResults);
    stepResult.toolResults = loopResult.toolResults;
    stepResult.toolCallIds = loopResult.toolResults.map((result) => result.callId);
    stepResult.endedAt = new Date().toISOString();
    if (!loopResult.ok) {
      step.status = 'failed';
      stepResult.status = 'failed';
      stepResult.error = loopResult.error ?? 'step failed';
      stepResult.failureKind = classifyStepFailure(stepResult.error, loopResult.toolResults);
      execution.status = 'failed';
      execution.endedAt = new Date().toISOString();
      syncExecutionSteps();
      ctx.toolResults = allToolResults;
      ctx.reply = undefined;
      ctx.replyProvenance = undefined;
      ctx.lastError = { stage: 'execute', message: stepResult.error };
      ctx.onToolEvent?.({
        type: 'step_failed',
        stepId,
        title: step.title,
        description: step.description,
        status: 'failed',
        error: stepResult.error,
      });
      return {
        stage: 'execute',
        next: 'recover',
        ok: false,
        error: stepResult.error,
        meta: { taskStatus: execution.status, failedStepId: stepId },
      };
    }

    stepResult.output = loopResult.content.trim();
    applyUsage(ctx, loopResult.usage);
    if (hasBlockingToolFailure(loopResult.toolResults)) {
      stepResult.error = blockingToolFailureReason(loopResult.toolResults);
      stepResult.failureKind = classifyStepFailure(stepResult.error, loopResult.toolResults);
      const blocked = stepResult.failureKind === 'permission_denied';
      step.status = blocked ? 'blocked' : 'failed';
      stepResult.status = blocked ? 'blocked' : 'failed';
      execution.status = blocked ? 'blocked' : 'failed';
      execution.endedAt = new Date().toISOString();
      syncExecutionSteps();
      ctx.toolResults = allToolResults;
      ctx.reply = undefined;
      ctx.replyProvenance = undefined;
      ctx.onToolEvent?.({
        type: 'step_failed',
        stepId,
        title: step.title,
        description: step.description,
        status: 'failed',
        output: stepResult.output,
        error: stepResult.error,
      });
      return {
        stage: 'execute',
        next: 'verify',
        ok: true,
        meta: { taskStatus: execution.status, failedStepId: stepId, toolCalls: allToolResults.length },
      };
    }

    step.status = 'done';
    stepResult.status = 'done';
    syncExecutionSteps();
    ctx.onToolEvent?.({
      type: 'step_done',
      stepId,
      title: step.title,
      description: step.description,
      status: 'done',
      output: stepResult.output,
    });
  }

  execution.status = 'done';
  execution.endedAt = new Date().toISOString();
  syncExecutionSteps();
  ctx.toolResults = allToolResults;
  try {
    ctx.reply = await synthesizeFinalReply(deps, ctx, taskBook, execution.steps);
    execution.summary = ctx.reply;
  } catch (error) {
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;
    execution.status = 'failed';
    execution.endedAt = new Date().toISOString();
    syncExecutionSteps();
    ctx.lastError = { stage: 'execute', message: `user-facing final reply generation failed: ${(error as Error).message}` };
    return {
      stage: 'execute',
      next: 'recover',
      ok: false,
      error: ctx.lastError.message,
      meta: { taskStatus: execution.status, taskSteps: execution.steps.length, toolCalls: allToolResults.length },
    };
  }
  ctx.lastError = undefined;
  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: {
      taskStatus: execution.status,
      taskSteps: execution.steps.length,
      toolCalls: allToolResults.length,
    },
  };
}

async function rewriteLegacyExecutionReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  input: ReplyRewriteInput,
): Promise<string> {
  const rewrittenSystem = appendSystemPromptBundleAddons(systemPrompt, [{
    id: 'user-facing-rewrite',
    text: `${buildUserFacingVoiceAddon(ctx)}\n\nThe prior API-generated response exactly repeats a previously published LS reply. Generate the answer again with a genuinely different opening and sentence structure. Preserve runtime facts, execution status, evidence and uncertainty. Do not mention the regeneration. Return only the user-facing reply.`,
  }]);
  const attachments = attachmentContextMessages(ctx.runId, ctx.attachments);
  const rawRequest = {
    model: deps.model,
    messages: [
      ...buildBaseMessages(ctx, rewrittenSystem.text, attachments),
      {
        role: 'user' as const,
        content: `Prior API-generated response:\n${input.generatedReply}\n\nRecent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
      },
    ],
    temperature: 0.75,
    max_tokens: 4_096,
    signal: ctx.signal,
  } satisfies import('@littlesheep/llm').ChatRequest;
  const request = prepareModelRequest(
    ctx,
    'execute_tool_loop',
    rawRequest,
    buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
      systemSegments: rewrittenSystem.segments,
      insertedBeforePrimary: attachments.map((item) => item.context),
    }),
  );
  const response = await deps.llm.chat(request);
  recordProviderUsage(ctx, request, response.usage);
  applyUsage(ctx, response.usage);
  return response.content;
}
