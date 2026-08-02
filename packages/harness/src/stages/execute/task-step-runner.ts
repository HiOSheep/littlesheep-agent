// Executes one already-scheduled TaskBook branch with an isolated message sink.

import type { SystemPromptBundle } from '@littlesheep/prompt';
import { appendSystemPromptBundleAddons } from '../../profile-prompt.js';
import type {
  RunContext,
  TaskBook,
  TaskStepResult,
  ToolResult,
} from '@littlesheep/types';
import { attachmentContextMessages } from '../_shared.js';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import {
  blockingToolFailureReason,
  classifyStepFailure,
  hasBlockingToolFailure,
  pickStepTools,
} from './failure-policy.js';
import { buildBaseMessages, renderStepGuidance } from './guidance.js';
import { runDirectToolProposal, runToolLoop } from './tool-loop.js';
import type { ScheduledTaskStep } from './task-step-scheduler.js';
import {
  directToolEvidenceText,
  resolveDirectToolProposal,
} from './direct-tool-proposal.js';

export interface TaskStepRunOutcome {
  scheduled: ScheduledTaskStep;
  result: TaskStepResult;
  toolResults: ToolResult[];
  produced: RunContext['produced'];
  usage?: import('@littlesheep/llm').ChatResponse['usage'];
  route: 'continue' | 'verify' | 'recover';
}

export interface TaskStepRunOptions {
  deps: ExecuteStageDeps;
  ctx: RunContext;
  baseSystemPrompt: SystemPromptBundle;
  taskBook: TaskBook;
  scheduled: ScheduledTaskStep;
  previousResult?: TaskStepResult;
  visiblePriorResults: TaskStepResult[];
  sanitizeOpts: ExecuteSanitizeOptions;
  registerStepResult: (result: TaskStepResult) => void;
  syncExecutionSteps: () => void;
}

export async function executeScheduledTaskStep(options: TaskStepRunOptions): Promise<TaskStepRunOutcome> {
  const {
    deps,
    ctx,
    baseSystemPrompt,
    taskBook,
    scheduled,
    previousResult,
    visiblePriorResults,
    sanitizeOpts,
    registerStepResult,
    syncExecutionSteps,
  } = options;
  const { step, id: stepId, index } = scheduled;
  step.status = 'in_progress';
  const stepResult: TaskStepResult = {
    stepId,
    title: step.title,
    description: step.description,
    status: 'in_progress',
    executionMode: scheduled.mode,
    ...(scheduled.dependsOn.length > 0 ? { dependsOn: [...scheduled.dependsOn] } : {}),
    startedAt: new Date().toISOString(),
    acceptanceCriteria: step.acceptanceCriteria,
    expectedOutput: step.expectedOutput,
    attempt: (previousResult?.attempt ?? (previousResult ? 1 : 0)) + 1,
    toolCallIds: [],
    toolResults: [],
  };
  registerStepResult(stepResult);
  syncExecutionSteps();
  ctx.onToolEvent?.({
    type: 'step_start',
    stepId,
    title: step.title,
    description: step.description,
    status: 'in_progress',
    summary: scheduled.mode === 'parallel' ? 'Running as a bounded parallel TaskBook branch.' : undefined,
  });

  const stepSystemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [{
    id: `step-contract:${stepId}`,
    text: renderStepGuidance(
      taskBook,
      step,
      stepId,
      index,
      taskBook.steps.length,
      visiblePriorResults,
    ),
    kind: 'workflow_state',
    source: { kind: 'workflow', id: `step-contract:${stepId}`, runId: ctx.runId },
  }]);
  const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
  const branch = branchAbortController(ctx.signal);
  const produced: RunContext['produced'] = [];
  try {
    const directProposal = resolveDirectToolProposal(ctx, taskBook, step, previousResult, {
      stepId,
      resources: scheduled.resources,
      sideEffect: scheduled.sideEffect,
    });
    const loopResult = directProposal
      ? await runDirectToolProposal(deps, {
          ctx,
          tool: directProposal.tool,
          input: directProposal.input,
          sanitizeOpts,
          stepId,
          signal: branch.controller.signal,
          produced,
        })
      : await runToolLoop(deps, {
          ctx,
          messages: buildBaseMessages(ctx, stepSystemPrompt.text, attachmentMessages),
          tools: pickStepTools(step, ctx.tools),
          sanitizeOpts,
          stepId,
          signal: branch.controller.signal,
          produced,
          ...(scheduled.mode === 'parallel' && scheduled.sideEffect
            ? {
                parallelStep: { sideEffect: scheduled.sideEffect, resources: scheduled.resources },
                maxParallelTools: 1,
              }
            : {}),
          systemSegments: stepSystemPrompt.segments,
          insertedBeforePrimary: attachmentMessages.map((item) => item.context),
        });
    stepResult.toolResults = loopResult.toolResults;
    stepResult.toolCallIds = loopResult.toolResults.map((result) => result.callId);
    stepResult.endedAt = new Date().toISOString();
    if (!loopResult.ok) {
      failStep(stepResult, loopResult.error ?? 'step failed', loopResult.toolResults);
      step.status = 'failed';
      syncExecutionSteps();
      emitFailure(ctx, stepResult);
      return { scheduled, result: stepResult, toolResults: loopResult.toolResults, produced, usage: loopResult.usage, route: 'recover' };
    }

    stepResult.output = directProposal
      ? directToolEvidenceText(loopResult.toolResults[0]!)
      : loopResult.content.trim();
    if (hasBlockingToolFailure(loopResult.toolResults)) {
      failStep(stepResult, blockingToolFailureReason(loopResult.toolResults), loopResult.toolResults);
      const blocked = stepResult.failureKind === 'permission_denied';
      step.status = blocked ? 'blocked' : 'failed';
      stepResult.status = step.status;
      syncExecutionSteps();
      emitFailure(ctx, stepResult);
      return { scheduled, result: stepResult, toolResults: loopResult.toolResults, produced, usage: loopResult.usage, route: 'verify' };
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
    return { scheduled, result: stepResult, toolResults: loopResult.toolResults, produced, usage: loopResult.usage, route: 'continue' };
  } finally {
    branch.dispose();
  }
}

function failStep(step: TaskStepResult, error: string, results: ToolResult[]): void {
  step.status = 'failed';
  step.error = error;
  step.failureKind = classifyStepFailure(error, results);
}

function emitFailure(ctx: RunContext, step: TaskStepResult): void {
  ctx.onToolEvent?.({
    type: 'step_failed',
    stepId: step.stepId,
    title: step.title,
    description: step.description,
    status: 'failed',
    output: step.output,
    error: step.error,
  });
}

function branchAbortController(parent: AbortSignal | undefined): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    dispose: () => parent?.removeEventListener('abort', abort),
  };
}
