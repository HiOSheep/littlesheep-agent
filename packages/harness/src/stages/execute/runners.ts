import type { SystemPromptBundle } from '@littlesheep/prompt';
import { appendSystemPromptBundleAddons } from '../../profile-prompt.js';
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
  ctx.reply = result.content;
  applyUsage(ctx, result.usage);
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
      ctx.reply = stepResult.error;
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
      ctx.reply = stepResult.output || stepResult.error;
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
  ctx.reply = await synthesizeFinalReply(deps, ctx, taskBook, execution.steps);
  execution.summary = ctx.reply;
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
