// TaskBook orchestration with dependency-aware, resource-safe bounded waves.

import type { SystemPromptBundle } from '@littlesheep/prompt';
import type {
  RunContext,
  StageResult,
  TaskBook,
  TaskExecutionResult,
  TaskStepResult,
  ToolResult,
} from '@littlesheep/types';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import { consumeRuntimeControlEvents } from '../../runtime-control-boundary.js';
import { updateReplanHistory, writeReplanState } from '../../replan-state.js';
import { clearReplyState } from '../../reply-state.js';
import { recordFailure, clearFailure } from '../../failure-state.js';
import { replaceToolResults } from '../../execution-evidence-state.js';
import { reserveUserFacingReplyOnce } from '../../user-facing-reply.js';
import { orderedStepResults } from './failure-policy.js';
import { synthesizeFinalReply } from './final-reply.js';
import { applyUsage } from './tool-loop.js';
import {
  buildTaskStepGraph,
  DEFAULT_MAX_PARALLEL_TASK_STEPS,
  nextTaskStepWave,
  type ScheduledTaskStep,
} from './task-step-scheduler.js';
import {
  executeScheduledTaskStep,
  type TaskStepRunOutcome,
} from './task-step-runner.js';

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
    (previousExecution?.steps ?? []).map((step) => [step.stepId, cloneStepResult(step)]),
  );
  const execution: TaskExecutionResult = {
    goal: taskBook.goal,
    complexity: taskBook.complexity,
    status: 'running',
    startedAt: previousExecution?.startedAt ?? startedAt,
    steps: orderedStepResults(taskBook, resultsById),
    replanHistory: ctx.replanHistory ?? previousExecution?.replanHistory,
  };
  writeReplanState(ctx, 'execute', { taskExecution: execution });
  taskBook.stageResults = execution.steps;

  const graph = buildTaskStepGraph(taskBook, ctx.tools, ctx.toolContext);
  if (!graph.ok) return structuralFailure(ctx, taskBook, execution, graph.error);

  const allToolResults: ToolResult[] = (previousExecution?.steps ?? [])
    .filter((step) => step.status === 'done' && !resumeTargets.has(step.stepId))
    .flatMap((step) => step.toolResults);
  if (resumeRequest) {
    const record = [...(ctx.replanHistory ?? [])]
      .reverse()
      .find((item) => item.attempt === resumeRequest.attempt && item.requestedAt === resumeRequest.requestedAt);
    if (record) {
      updateReplanHistory(ctx, 'execute', (item) => item.attempt === resumeRequest.attempt
        && item.requestedAt === resumeRequest.requestedAt
        ? { ...item, resumedAt: startedAt }
        : item);
      execution.replanHistory = ctx.replanHistory;
    }
  }
  writeReplanState(ctx, 'execute', { partialReplanRequest: undefined });

  const syncExecutionSteps = () => {
    execution.steps = orderedStepResults(taskBook, resultsById);
    taskBook.stageResults = execution.steps;
  };
  const completedIds = new Set<string>();
  const pendingIds = new Set<string>();
  for (const scheduled of graph.steps) {
    const previousResult = previousById.get(scheduled.id);
    if (previousResult?.status === 'done' && !resumeTargets.has(scheduled.id)) {
      scheduled.step.status = 'done';
      completedIds.add(scheduled.id);
      ctx.onToolEvent?.({
        type: 'step_skipped',
        stepId: scheduled.id,
        title: scheduled.step.title,
        description: scheduled.step.description,
        status: 'done',
        summary: 'Preserved from a previous execution attempt.',
      });
    } else {
      pendingIds.add(scheduled.id);
    }
  }
  syncExecutionSteps();

  while (pendingIds.size > 0) {
    if (ctx.signal?.aborted) return structuralFailure(ctx, taskBook, execution, 'TaskBook execution aborted.');
    const wave = nextTaskStepWave(
      graph.steps,
      pendingIds,
      completedIds,
      Math.min(DEFAULT_MAX_PARALLEL_TASK_STEPS, deps.config.tools.maxParallel),
    );
    if (wave.length === 0) {
      return structuralFailure(ctx, taskBook, execution, 'TaskBook dependency graph made no progress.');
    }
    const settled = await Promise.allSettled(wave.map((scheduled) => executeScheduledTaskStep({
      deps,
      ctx,
      baseSystemPrompt,
      taskBook,
      scheduled,
      previousResult: previousById.get(scheduled.id),
      visiblePriorResults: visiblePriorResults(scheduled, graph.steps, resultsById),
      sanitizeOpts,
      registerStepResult: (result) => resultsById.set(scheduled.id, result),
      syncExecutionSteps,
    })));
    const outcomes = settled.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : rejectedStepOutcome(wave[index]!, resultsById, result.reason, ctx));
    mergeWave(ctx, outcomes, allToolResults);
    for (const outcome of outcomes) {
      pendingIds.delete(outcome.scheduled.id);
      if (outcome.result.status === 'done') completedIds.add(outcome.scheduled.id);
    }
    syncExecutionSteps();

    const failure = outcomes.find((outcome) => outcome.route !== 'continue');
    if (failure) return finishWaveFailure(ctx, taskBook, execution, allToolResults, outcomes, failure);

    if (pendingIds.size === 0) {
      execution.status = 'done';
      execution.endedAt = new Date().toISOString();
      syncExecutionSteps();
    }
    const runtimeControl = consumeRuntimeControlEvents(ctx);
    if (runtimeControl.shouldStop) {
      return finishRuntimeControlBoundary(ctx, taskBook, execution, allToolResults, runtimeControl);
    }
  }

  if (execution.status !== 'done') {
    execution.status = 'done';
    execution.endedAt = new Date().toISOString();
    syncExecutionSteps();
  }
  replaceToolResults(ctx, 'execute', allToolResults);
  try {
    await resolveCompletedTaskReply(deps, ctx, taskBook, execution.steps);
    execution.summary = ctx.reply;
  } catch (error) {
    clearReplyState(ctx, 'execute');
    execution.status = 'failed';
    execution.endedAt = new Date().toISOString();
    syncExecutionSteps();
    const message = `user-facing final reply generation failed: ${(error as Error).message}`;
    recordFailure(ctx, 'execute', 'execute', message);
    return {
      stage: 'execute',
      next: 'recover',
      ok: false,
      error: message,
      meta: { taskStatus: execution.status, taskSteps: execution.steps.length, toolCalls: allToolResults.length },
    };
  }
  clearFailure(ctx, 'execute');
  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: { taskStatus: execution.status, taskSteps: execution.steps.length, toolCalls: allToolResults.length },
  };
}

function finishRuntimeControlBoundary(
  ctx: RunContext,
  taskBook: TaskBook,
  execution: TaskExecutionResult,
  allToolResults: ToolResult[],
  runtimeControl: ReturnType<typeof consumeRuntimeControlEvents>,
): StageResult {
  taskBook.stageResults = execution.steps;
  replaceToolResults(ctx, 'execute', allToolResults);
  clearReplyState(ctx, 'execute');
  const error = runtimeControl.error
    ?? (runtimeControl.state === 'paused'
      ? 'run paused at a safe boundary'
      : 'run interrupted at a safe boundary');
  recordFailure(ctx, 'execute', 'execute', error);
  return {
    stage: 'execute',
    next: 'exit',
    ok: false,
    error,
    meta: {
      taskStatus: execution.status,
      taskSteps: execution.steps.length,
      toolCalls: allToolResults.length,
      runtimeControl: ctx.runtimeControl,
      runtimeEventIds: runtimeControl.settledEventIds,
    },
  };
}

async function resolveCompletedTaskReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  taskBook: TaskBook,
  stepResults: TaskStepResult[],
): Promise<string> {
  const stepOutput = reusableSingleStepOutput(taskBook, stepResults);
  if (stepOutput) {
    const reserved = await reserveUserFacingReplyOnce(ctx, 'execute_tool_loop', stepOutput);
    if (reserved) return reserved;
  }
  return synthesizeFinalReply(deps, ctx, taskBook, stepResults);
}

function reusableSingleStepOutput(taskBook: TaskBook, stepResults: TaskStepResult[]): string | undefined {
  if (taskBook.complexity !== 'trivial' && taskBook.complexity !== 'simple') return undefined;
  if (taskBook.steps.length !== 1 || stepResults.length !== 1) return undefined;
  // A direct proposal result is Runtime/tool evidence, not user-facing LLM copy.
  if (taskBook.steps[0]?.toolProposal) return undefined;
  const result = stepResults[0]!;
  if (result.status !== 'done' || result.error) return undefined;
  const output = result.output?.trim();
  return output || undefined;
}

function visiblePriorResults(
  current: ScheduledTaskStep,
  scheduled: readonly ScheduledTaskStep[],
  results: ReadonlyMap<string, TaskStepResult>,
): TaskStepResult[] {
  const visible = current.mode === 'parallel'
    ? new Set(current.dependsOn)
    : new Set(scheduled.filter((candidate) => candidate.index < current.index).map((candidate) => candidate.id));
  return scheduled
    .filter((candidate) => visible.has(candidate.id))
    .map((candidate) => results.get(candidate.id))
    .filter((result): result is TaskStepResult => result?.status === 'done');
}

function mergeWave(ctx: RunContext, outcomes: readonly TaskStepRunOutcome[], allToolResults: ToolResult[]): void {
  for (const outcome of [...outcomes].sort((left, right) => left.scheduled.index - right.scheduled.index)) {
    ctx.produced.push(...outcome.produced);
    allToolResults.push(...outcome.toolResults);
    applyUsage(ctx, outcome.usage, 'execute');
  }
}

function finishWaveFailure(
  ctx: RunContext,
  taskBook: TaskBook,
  execution: TaskExecutionResult,
  allToolResults: ToolResult[],
  outcomes: readonly TaskStepRunOutcome[],
  failure: TaskStepRunOutcome,
): StageResult {
  const blocked = outcomes.some((outcome) => outcome.result.status === 'blocked');
  execution.status = blocked ? 'blocked' : 'failed';
  execution.endedAt = new Date().toISOString();
  taskBook.stageResults = execution.steps;
  replaceToolResults(ctx, 'execute', allToolResults);
  clearReplyState(ctx, 'execute');
  const error = failure.result.error ?? 'TaskBook step failed.';
  if (failure.route === 'recover') {
    recordFailure(ctx, 'execute', 'execute', error);
    return {
      stage: 'execute', next: 'recover', ok: false, error,
      meta: { taskStatus: execution.status, failedStepId: failure.result.stepId, toolCalls: allToolResults.length },
    };
  }
  return {
    stage: 'execute', next: 'verify', ok: true,
    meta: { taskStatus: execution.status, failedStepId: failure.result.stepId, toolCalls: allToolResults.length },
  };
}

function structuralFailure(
  ctx: RunContext,
  taskBook: TaskBook,
  execution: TaskExecutionResult,
  error: string,
): StageResult {
  execution.status = 'failed';
  execution.endedAt = new Date().toISOString();
  taskBook.stageResults = execution.steps;
  clearReplyState(ctx, 'execute');
  recordFailure(ctx, 'execute', 'execute', error);
  return { stage: 'execute', next: 'recover', ok: false, error, meta: { taskStatus: execution.status } };
}

function rejectedStepOutcome(
  scheduled: ScheduledTaskStep,
  results: Map<string, TaskStepResult>,
  reason: unknown,
  ctx: RunContext,
): TaskStepRunOutcome {
  const error = `TaskBook branch failed unexpectedly: ${reason instanceof Error ? reason.message : String(reason)}`;
  const result: TaskStepResult = results.get(scheduled.id) ?? {
    stepId: scheduled.id,
    title: scheduled.step.title,
    description: scheduled.step.description,
    status: 'failed' as const,
    executionMode: scheduled.mode,
    startedAt: new Date().toISOString(),
    toolCallIds: [],
    toolResults: [],
  };
  result.status = 'failed';
  result.error = error;
  result.failureKind = 'unknown';
  result.endedAt = new Date().toISOString();
  scheduled.step.status = 'failed';
  results.set(scheduled.id, result);
  ctx.onToolEvent?.({ type: 'step_failed', stepId: scheduled.id, status: 'failed', error });
  return { scheduled, result, toolResults: result.toolResults, produced: [], route: 'recover' };
}

function cloneStepResult(step: TaskStepResult): TaskStepResult {
  return { ...step, toolResults: [...step.toolResults], toolCallIds: [...step.toolCallIds] };
}
