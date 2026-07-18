// Build a bounded, truthful snapshot of an interrupted or waiting run.
// This is runtime continuity evidence, not a shadow Git rollback manifest.

import { randomUUID } from 'node:crypto';
import type {
  RunCheckpoint,
  RunContext,
  RuntimeEventQueueSnapshot,
  StageResult,
} from '@littlesheep/types';

const MAX_CHECKPOINT_IDS = 128;
const MAX_SIDE_EFFECTS = 256;
const MAX_DEFERRED_EVENTS = 128;
const MAX_RESUME_EVENTS = 32;
const MAX_VERIFICATION_RECORDS = 32;

export interface BuildRunCheckpointOptions {
  ctx: RunContext;
  stageResult: StageResult;
  reason: string;
  interrupted?: boolean;
  id?: string;
  now?: Date;
}

export function shouldPersistRunCheckpoint(
  ctx: RunContext,
  stageResult: StageResult,
  interrupted: boolean,
): boolean {
  return interrupted
    || ctx.runtimeControl?.state === 'paused'
    || Boolean(ctx.clarificationRequest)
    || (!stageResult.ok && stageResult.stage !== 'finalize');
}

export function buildRunCheckpoint(options: BuildRunCheckpointOptions): RunCheckpoint {
  const { ctx, stageResult } = options;
  const now = options.now ?? (ctx.runtimeNow?.() ?? new Date());
  const queue = snapshotQueue(ctx);
  const status: RunCheckpoint['status'] = ctx.clarificationRequest
    ? 'waiting_user'
    : ctx.runtimeControl?.state === 'paused'
      ? 'paused'
      : 'recoverable';
  const currentStepId = ctx.taskExecution?.steps.find((step) => step.status === 'in_progress')?.stepId
    ?? ctx.taskBook?.steps.find((step) => (step.status ?? 'pending') === 'pending')?.id;
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(ctx.startedAt));
  const loopBudget = ctx.loopBudget ?? {
    attemptsUsed: ctx.modelCallCount ?? 0,
    maxAttempts: ctx.maxModelCalls ?? 0,
    elapsedMs,
    maxElapsedMs: 0,
    noProgressRounds: 0,
    maxNoProgressRounds: 2,
  };
  const pendingEventIds = queue?.events
    .filter((event) => event.status === 'queued')
    .map((event) => event.id)
    .slice(0, MAX_DEFERRED_EVENTS)
    ?? [...(ctx.deferredRuntimeEventIds ?? [])].slice(-MAX_DEFERRED_EVENTS);

  return {
    version: 1,
    id: options.id ?? `run-checkpoint-${randomUUID()}`,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    status,
    currentStage: stageResult.stage,
    ...(currentStepId ? { currentStepId } : {}),
    ...(ctx.taskBook ? { taskBook: clone(ctx.taskBook) } : {}),
    taskBookRevision: ctx.taskBookRevision ?? (ctx.taskBook ? 1 : 0),
    ...(ctx.taskExecution ? { taskExecution: clone(ctx.taskExecution) } : {}),
    eventCursor: queue?.cursor ?? 0,
    pendingEventIds,
    ...(queue ? { runtimeEventQueue: queue } : {}),
    ...(ctx.runtimeControl ? { runtimeControl: clone(ctx.runtimeControl) } : {}),
    contextSnapshotIds: (ctx.contextSnapshots ?? []).map((snapshot) => snapshot.id).slice(-MAX_CHECKPOINT_IDS),
    sideEffects: clone((ctx.sideEffects ?? []).slice(-MAX_SIDE_EFFECTS)),
    loopBudget: clone({
      ...loopBudget,
      elapsedMs: Math.max(loopBudget.elapsedMs, elapsedMs),
    }),
    resumeState: {
      version: 1,
      inboundMessageId: ctx.inbound.id,
      cwd: ctx.cwd,
      ...(ctx.workspaceContext ? { workspaceContext: clone(ctx.workspaceContext) } : {}),
      model: ctx.model,
      origin: ctx.resolvedRunConfig?.origin ?? 'cli',
      permissionPolicyId: ctx.resolvedRunConfig?.permissionPolicyId ?? 'restricted',
      reasoning: ctx.resolvedRunConfig?.reasoning ?? 'auto',
      behaviorModeId: ctx.resolvedRunConfig?.behaviorModeId ?? 'general',
      availableToolNames: [...new Set(ctx.tools.map((tool) => tool.name))].slice(0, 256),
      attachmentCount: Math.min(256, ctx.attachments?.length ?? 0),
      ...(ctx.classification ? { classification: clone(ctx.classification) } : {}),
      ...(ctx.needAssessment ? { needAssessment: clone(ctx.needAssessment) } : {}),
      ...(ctx.plan ? { plan: clone(ctx.plan).slice(0, 64) } : {}),
      appliedTaskBookPatchIds: [...(ctx.appliedTaskBookPatchIds ?? [])].slice(-128),
      deferredRuntimeEvents: clone((ctx.deferredRuntimeEvents ?? []).slice(-MAX_RESUME_EVENTS)),
      recoveryAttempts: ctx.recoveryAttempts ?? 0,
      replanAttempts: ctx.replanAttempts ?? 0,
      maxReplanAttempts: ctx.maxReplanAttempts ?? 2,
      verificationHistory: clone((ctx.verificationHistory ?? []).slice(-MAX_VERIFICATION_RECORDS)),
    },
    createdAt: now.toISOString(),
    reason: options.reason.trim().slice(0, 4_096) || (options.interrupted ? 'run interrupted' : 'run requires recovery'),
  };
}

function snapshotQueue(ctx: RunContext): RuntimeEventQueueSnapshot | undefined {
  try {
    return ctx.runtimeEventQueue?.snapshot();
  } catch {
    return undefined;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
