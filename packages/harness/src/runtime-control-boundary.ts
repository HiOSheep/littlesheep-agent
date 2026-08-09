// Deterministic runtime event consumption at Harness stage boundaries.
// Control events and task-changing events use separate batches so a pause can
// stop the run without accidentally consuming a user update.

import {
  RUNTIME_CONTROL_VERSION,
  type RunContext,
  type RuntimeControlState,
  type RuntimeEventDecision,
  type RuntimeEventEnvelope,
  type RuntimeEventType,
} from '@littlesheep/types';
import { applyTaskBookPatch } from './taskbook-patch.js';
import { writeReplanState } from './replan-state.js';
import { writeRuntimeState } from './runtime-state.js';

export const RUNTIME_CONTROL_EVENT_TYPES = [
  'pause_requested',
  'resume_requested',
  'interrupt_requested',
] as const satisfies readonly RuntimeEventType[];

const MAX_CONTROL_EVENT_IDS = 32;
const MAX_DEFERRED_RUNTIME_EVENTS = 32;
const MAX_DEFERRED_RUNTIME_EVENT_IDS = 128;

export const RUNTIME_TASK_EVENT_TYPES = [
  'user_message',
  'setting_changed',
  'workspace_file_saved',
] as const satisfies readonly RuntimeEventType[];

export interface RuntimeControlBoundaryResult {
  state: RuntimeControlState;
  shouldStop: boolean;
  settledEventIds: string[];
  error?: string;
}

export interface RuntimeTaskBoundaryResult {
  taskBookChanged: boolean;
  shouldReplan: boolean;
  settledEventIds: string[];
  deferredEventIds: string[];
  appliedPatchIds: string[];
  error?: string;
}

export function consumeRuntimeControlEvents(ctx: RunContext): RuntimeControlBoundaryResult {
  const queue = ctx.runtimeEventQueue;
  const initialState = ctx.runtimeControl?.state ?? 'running';
  if (!queue) return result(initialState);

  let batch: ReturnType<typeof queue.openDecisionBatchForTypes>;
  try {
    batch = queue.openDecisionBatchForTypes(RUNTIME_CONTROL_EVENT_TYPES);
  } catch (error) {
    return result(initialState, [], `runtime event boundary open failed: ${(error as Error).message}`);
  }
  if (!batch) return result(initialState);

  let state = initialState;
  let lastApplied: RuntimeEventEnvelope | undefined;
  const appliedIds: string[] = [];
  const decisions: RuntimeEventDecision[] = batch.events.map((event) => {
    const decision = decideControlEvent(state, event);
    state = decision.nextState;
    if (decision.status === 'applied') {
      lastApplied = event;
      appliedIds.push(event.id);
    }
    return {
      eventId: event.id,
      status: decision.status,
      reason: decision.reason,
    };
  });

  try {
    queue.settleDecisionBatch(batch.token, decisions);
  } catch (error) {
    try {
      queue.releaseDecisionBatch(batch.token);
    } catch {
      // Preserve the original settlement failure; the queue lease is bounded.
    }
    return result(initialState, [], `runtime event boundary settle failed: ${(error as Error).message}`);
  }

  if (lastApplied) {
    const eventIds = [
      ...(ctx.runtimeControl?.eventIds ?? []),
      ...appliedIds,
    ].slice(-MAX_CONTROL_EVENT_IDS);
    writeRuntimeState(ctx, 'runtime-boundary', {
      runtimeControl: {
        version: RUNTIME_CONTROL_VERSION,
        state,
        changedAt: runtimeNow(ctx).toISOString(),
        reason: eventReason(lastApplied) ?? lastApplied.type,
        eventIds,
      },
    });
  }

  return result(state, batch.events.map((event) => event.id));
}

/**
 * Consume task-changing events only at a stage boundary. Patch application is
 * staged against a cloned TaskBook and committed only after queue settlement,
 * so a failed queue transaction cannot leave the context half-mutated.
 */
export function consumeRuntimeTaskEvents(ctx: RunContext): RuntimeTaskBoundaryResult {
  const queue = ctx.runtimeEventQueue;
  if (!queue) return taskResult();

  let batch: ReturnType<typeof queue.openDecisionBatchForTypes>;
  try {
    batch = queue.openDecisionBatchForTypes(RUNTIME_TASK_EVENT_TYPES);
  } catch (error) {
    return taskResult([], [], [], `runtime task event boundary open failed: ${(error as Error).message}`);
  }
  if (!batch) return taskResult();

  const claimedEventIds = batch.events.map((event) => event.id);
  let stagedTaskBook = ctx.taskBook;
  let stagedRevision = ctx.taskBookRevision ?? (ctx.taskBook ? 1 : 0);
  let stagedPatchIds = [...(ctx.appliedTaskBookPatchIds ?? [])];
  let stagedDeferredEvents = [...(ctx.deferredRuntimeEvents ?? [])];
  let stagedDeferredIds = [...(ctx.deferredRuntimeEventIds ?? [])];
  let taskBookChanged = false;
  let shouldReplan = false;
  const deferredEventIds: string[] = [];
  const appliedPatchIds: string[] = [];

  const decisions: RuntimeEventDecision[] = batch.events.map((event) => {
    const patch = extractPatch(event);
    if (patch.present) {
      if (!stagedTaskBook) {
        return decision(event, 'conflict', 'taskbook-patch-without-taskbook');
      }
      const patchResult = applyTaskBookPatch(stagedTaskBook, patch.value, {
        runId: ctx.runId,
        currentRevision: stagedRevision,
        claimedEventIds,
        appliedPatchIds: stagedPatchIds,
      });
      if (patchResult.kind === 'applied' || patchResult.kind === 'duplicate') {
        stagedTaskBook = patchResult.taskBook;
        stagedRevision = patchResult.revision;
        if (patchResult.kind === 'applied') {
          stagedPatchIds = [...stagedPatchIds, patchResult.patchId].slice(-64);
          appliedPatchIds.push(patchResult.patchId);
          taskBookChanged = true;
        }
        return decision(
          event,
          'applied',
          patchResult.kind === 'duplicate' ? 'taskbook-patch-already-applied' : 'taskbook-patch-applied',
        );
      }
      return decision(event, 'conflict', `taskbook-patch-${patchResult.reason}`);
    }

    if (!rememberDeferredEvent(event, stagedDeferredEvents, stagedDeferredIds)) {
      return decision(event, 'conflict', 'deferred-runtime-event-capacity');
    }
    shouldReplan = true;
    deferredEventIds.push(event.id);
    return decision(event, 'ignored', 'deferred-awaiting-replan');
  });

  try {
    queue.settleDecisionBatch(batch.token, decisions);
  } catch (error) {
    try {
      queue.releaseDecisionBatch(batch.token);
    } catch {
      // Preserve the settlement failure; the queue lease remains bounded.
    }
    return taskResult([], [], [], `runtime task event boundary settle failed: ${(error as Error).message}`);
  }

  if (taskBookChanged && stagedTaskBook) {
    writeReplanState(ctx, 'runtime-boundary', {
      taskBook: stagedTaskBook,
      plan: stagedTaskBook.steps,
      taskBookRevision: stagedRevision,
      appliedTaskBookPatchIds: stagedPatchIds,
    });
  }
  if (shouldReplan) {
    writeRuntimeState(ctx, 'runtime-boundary', {
      deferredRuntimeEvents: stagedDeferredEvents.slice(-MAX_DEFERRED_RUNTIME_EVENTS),
      deferredRuntimeEventIds: stagedDeferredIds.slice(-MAX_DEFERRED_RUNTIME_EVENT_IDS),
    });
  }
  return taskResult(
    batch.events.map((event) => event.id),
    deferredEventIds,
    appliedPatchIds,
    undefined,
    taskBookChanged,
    shouldReplan,
  );
}

function decideControlEvent(
  state: RuntimeControlState,
  event: RuntimeEventEnvelope,
): { nextState: RuntimeControlState; status: RuntimeEventDecision['status']; reason: string } {
  if (event.type === 'pause_requested') {
    if (state === 'running') return { nextState: 'paused', status: 'applied', reason: 'run-paused-at-safe-boundary' };
    if (state === 'paused') return { nextState: state, status: 'ignored', reason: 'run-already-paused' };
    return { nextState: state, status: 'conflict', reason: 'interrupted-run-cannot-be-paused' };
  }
  if (event.type === 'resume_requested') {
    if (state === 'paused') return { nextState: 'running', status: 'applied', reason: 'run-resumed-at-safe-boundary' };
    if (state === 'running') return { nextState: state, status: 'ignored', reason: 'run-already-running' };
    return { nextState: state, status: 'conflict', reason: 'interrupted-run-cannot-resume-in-place' };
  }
  if (state === 'interrupted') return { nextState: state, status: 'ignored', reason: 'run-already-interrupted' };
  return { nextState: 'interrupted', status: 'applied', reason: 'run-interrupted-at-safe-boundary' };
}

function eventReason(event: RuntimeEventEnvelope): string | undefined {
  const value = event.payload.reason;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1_024) : undefined;
}

function extractPatch(event: RuntimeEventEnvelope): { present: boolean; value: unknown } {
  for (const key of ['taskBookPatch', 'patch'] as const) {
    if (Object.prototype.hasOwnProperty.call(event.payload, key)) {
      return { present: true, value: event.payload[key] };
    }
  }
  return { present: false, value: undefined };
}

function rememberDeferredEvent(
  event: RuntimeEventEnvelope,
  events: RuntimeEventEnvelope[],
  ids: string[],
): boolean {
  if (ids.includes(event.id)) return true;
  if (events.length >= MAX_DEFERRED_RUNTIME_EVENTS) return false;
  events.push(structuredClone(event));
  ids.push(event.id);
  return true;
}

function decision(
  event: RuntimeEventEnvelope,
  status: RuntimeEventDecision['status'],
  reason: string,
): RuntimeEventDecision {
  return { eventId: event.id, status, reason };
}

function runtimeNow(ctx: RunContext): Date {
  return ctx.runtimeNow?.() ?? new Date();
}

function result(
  state: RuntimeControlState,
  settledEventIds: string[] = [],
  error?: string,
): RuntimeControlBoundaryResult {
  return {
    state,
    shouldStop: state === 'paused' || state === 'interrupted' || Boolean(error),
    settledEventIds,
    ...(error ? { error } : {}),
  };
}

function taskResult(
  settledEventIds: string[] = [],
  deferredEventIds: string[] = [],
  appliedPatchIds: string[] = [],
  error?: string,
  taskBookChanged = false,
  shouldReplan = false,
): RuntimeTaskBoundaryResult {
  return {
    taskBookChanged,
    shouldReplan,
    settledEventIds,
    deferredEventIds,
    appliedPatchIds,
    ...(error ? { error } : {}),
  };
}
