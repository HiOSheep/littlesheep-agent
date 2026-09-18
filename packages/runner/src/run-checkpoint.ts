// Build a bounded, truthful snapshot of an interrupted or waiting run.
// This is runtime continuity evidence, not a shadow Git rollback manifest.

import { randomUUID } from 'node:crypto';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import type {
  RunCheckpoint,
  RunContext,
  RuntimeEventQueueSnapshot,
  StageResult,
} from '@littlesheep/types';
import { sanitizeWebEvidenceProjection } from '@littlesheep/types';

// Keep checkpoint references aligned with the bounded Context/model snapshots.
const MAX_CHECKPOINT_IDS = MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN;
const MAX_SIDE_EFFECTS = 256;
const MAX_ACTIVE_STEP_IDS = 4;
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
  // A clarification no longer parks a run. Asking the user is a normal published
  // reply (ASK_USER ends with FINALIZE), and whether the next message continues
  // that thread is the model's judgement at that time, handled safely by the
  // continuation path. Only an explicit runtime pause or an interruption
  // suspends a run now.
  const status: RunCheckpoint['status'] = ctx.runtimeControl?.state === 'paused'
    ? 'paused'
    : options.interrupted || ctx.runtimeControl?.state === 'interrupted'
      ? 'recoverable'
      : 'recoverable';
  const activeStepIds = (ctx.taskExecution?.steps ?? [])
    .filter((step) => step.status === 'in_progress')
    .map((step) => step.stepId)
    .slice(0, MAX_ACTIVE_STEP_IDS);
  const currentStepId = activeStepIds[0]
    ?? ctx.taskBook?.steps.find((step) => (step.status ?? 'pending') === 'pending')?.id;
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(ctx.startedAt));
  const loopBudget = reconcileLoopBudget(ctx, elapsedMs);
  const pendingEventIds = queue?.events
    .filter((event) => event.status === 'queued')
    .map((event) => event.id)
    .slice(0, MAX_DEFERRED_EVENTS)
    ?? [...(ctx.deferredRuntimeEventIds ?? [])].slice(-MAX_DEFERRED_EVENTS);
  const restorableAttachments = (ctx.attachments ?? [])
    .filter((attachment) => (
      Boolean(attachment.id)
      && Boolean(attachment.cacheId)
      && Boolean(attachment.contentHash)
    ))
    .slice(0, 256)
    .map((attachment) => ({
      version: 1 as const,
      attachmentId: attachment.id!,
      cacheId: attachment.cacheId!,
      contentHash: attachment.contentHash!,
      name: attachment.name ?? 'attachment',
      kind: attachment.kind,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      ...(attachment.contextPath ? { contextPath: attachment.contextPath } : {}),
      ...(attachment.lineComments && attachment.lineComments.length > 0
        ? { lineComments: attachment.lineComments }
        : {}),
    }));
  const toolRecipes = ctx.toolSources?.inspect_attachment === 'run-scoped'
    ? [{ version: 1 as const, factory: 'inspect_attachment' as const }]
    : [];
  const webEvidence = sanitizeWebEvidenceProjection(ctx.webEvidence);

  return {
    version: 1,
    id: options.id ?? `run-checkpoint-${randomUUID()}`,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    status,
    currentStage: stageResult.stage,
    ...(currentStepId ? { currentStepId } : {}),
    ...(activeStepIds.length > 0 ? { activeStepIds } : {}),
    ...(ctx.taskBook ? { taskBook: clone(ctx.taskBook) } : {}),
    taskBookRevision: ctx.taskBookRevision ?? (ctx.taskBook ? 1 : 0),
    ...(ctx.taskExecution ? { taskExecution: clone(ctx.taskExecution) } : {}),
    eventCursor: queue?.cursor ?? 0,
    pendingEventIds,
    ...(queue ? { runtimeEventQueue: queue } : {}),
    ...(ctx.runtimeControl ? { runtimeControl: clone(ctx.runtimeControl) } : {}),
    contextSnapshotIds: (ctx.contextSnapshots ?? []).map((snapshot) => snapshot.id).slice(-MAX_CHECKPOINT_IDS),
    ...(webEvidence ? { webEvidence } : {}),
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
      ...(restorableAttachments.length > 0 ? { attachments: restorableAttachments } : {}),
      ...(toolRecipes.length > 0 ? { toolRecipes } : {}),
      ...(ctx.clarificationRequest ? {
        continuation: {
          version: 1,
          requestId: ctx.clarificationRequest.id,
          sourceStage: ctx.clarificationRequest.sourceStage,
        },
      } : {}),
      ...(ctx.lastError ? {
        lastError: {
          stage: ctx.lastError.stage,
          message: ctx.lastError.message.slice(0, 2_048),
        },
      } : {}),
      ...(ctx.classification ? { classification: clone(ctx.classification) } : {}),
      ...(ctx.needAssessment ? { needAssessment: clone(ctx.needAssessment) } : {}),
      ...(ctx.workPolicyUpgradeRequest ? { workPolicyUpgradeRequest: clone(ctx.workPolicyUpgradeRequest) } : {}),
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

/**
 * Model observability owns the live call counter while runtime owns the
 * checkpoint budget shape. Reconcile them at the durable boundary so a stale
 * in-memory runtime snapshot cannot erase calls during continuation.
 */
function reconcileLoopBudget(ctx: RunContext, elapsedMs: number) {
  const existing = ctx.loopBudget ?? {
    attemptsUsed: 0,
    maxAttempts: 0,
    elapsedMs,
    maxElapsedMs: 0,
    noProgressRounds: 0,
    maxNoProgressRounds: 2,
  };
  return {
    ...existing,
    attemptsUsed: ctx.modelCallCount ?? existing.attemptsUsed,
    maxAttempts: ctx.maxModelCalls ?? existing.maxAttempts,
    elapsedMs: Math.max(existing.elapsedMs, elapsedMs),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
