import { describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_EVENT_VERSION,
  asSessionId,
  type RuntimeEventDecision,
  type RuntimeEventEnvelope,
  type RuntimeEventQueueLike,
  type TaskBook,
} from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import {
  consumePendingRuntimeUserMessages,
  consumeRuntimeControlEvents,
  consumeRuntimeTaskEvents,
  takeDeferredRuntimeUserMessages,
} from './runtime-control-boundary.js';

function event(sequence: number, type: RuntimeEventEnvelope['type'], payload: Record<string, unknown> = {}): RuntimeEventEnvelope {
  return {
    version: RUNTIME_EVENT_VERSION,
    id: `event-${sequence}`,
    runId: 'run-control',
    sessionId: asSessionId('test-session'),
    sequence,
    type,
    source: 'app',
    status: 'queued',
    receivedAt: '2026-07-18T10:00:00.000Z',
    payload,
  };
}

function queue(events: RuntimeEventEnvelope[], settleError?: Error) {
  const settleDecisionBatch = vi.fn((_token: string, decisions: readonly RuntimeEventDecision[]) => {
    if (settleError) throw settleError;
    return events.map((item) => ({
      ...item,
      status: decisions.find((decision) => decision.eventId === item.id)?.status ?? item.status,
    }));
  });
  const releaseDecisionBatch = vi.fn(() => true);
  const openDecisionBatchForTypes = vi.fn((types: readonly RuntimeEventEnvelope['type'][]) => {
    const selected = events.filter((item) => types.includes(item.type));
    return selected.length > 0
      ? { token: 'batch-1', openedAt: '2026-07-18T10:00:00.000Z', cursor: 0, events: selected }
      : undefined;
  });
  return {
    port: {
      openDecisionBatchForTypes,
      settleDecisionBatch,
      releaseDecisionBatch,
    } as unknown as RuntimeEventQueueLike,
    openDecisionBatchForTypes,
    settleDecisionBatch,
    releaseDecisionBatch,
  };
}

function taskBook(): TaskBook {
  return {
    assessment: {
      userNeed: 'complete a task',
      complexity: 'standard',
      goal: 'complete a task',
      successCriteria: ['the task is complete'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'complete a task',
    complexity: 'standard',
    successCriteria: ['the task is complete'],
    steps: [
      { id: 'done', description: 'preserve completed work', status: 'done' },
      { id: 'pending', description: 'pending work', status: 'pending' },
    ],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
  };
}

function patchFor(
  runId: string,
  eventId: string,
  id: string,
  baseRevision: number,
  description: string,
) {
  return {
    version: 1,
    id,
    runId,
    baseRevision,
    nextRevision: baseRevision + 1,
    eventIds: [eventId],
    reason: `update ${id}`,
    operations: [{
      type: 'update_pending_step' as const,
      stepId: 'pending',
      patch: { description },
    }],
    createdAt: '2026-07-18T10:00:00.000Z',
  };
}

describe('runtime control boundary', () => {
  it('applies pause and resume in sequence while leaving task-changing events untouched', () => {
    const mock = queue([
      event(1, 'user_message', { text: 'do not consume yet' }),
      event(2, 'pause_requested', { reason: 'hold' }),
      event(3, 'resume_requested'),
    ]);
    const ctx = makeCtx();
    ctx.runtimeNow = () => new Date('2026-07-18T10:00:01.000Z');
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeControlEvents(ctx);

    expect(result).toMatchObject({ state: 'running', shouldStop: false, settledEventIds: ['event-2', 'event-3'] });
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining({ eventId: 'event-2', status: 'applied' }),
      expect.objectContaining({ eventId: 'event-3', status: 'applied' }),
    ]);
    expect(ctx.runtimeControl).toMatchObject({
      state: 'running',
      changedAt: '2026-07-18T10:00:01.000Z',
      eventIds: ['event-2', 'event-3'],
    });
  });

  it('stops at the boundary after an interrupt', () => {
    const mock = queue([event(1, 'interrupt_requested', { reason: 'user stop' })]);
    const ctx = makeCtx();
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeControlEvents(ctx);

    expect(result).toMatchObject({ state: 'interrupted', shouldStop: true });
    expect(ctx.runtimeControl).toMatchObject({ state: 'interrupted', reason: 'user stop' });
  });

  it('releases a failed settlement and fails closed', () => {
    const mock = queue([event(1, 'pause_requested')], new Error('settle failed'));
    const ctx = makeCtx();
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeControlEvents(ctx);

    expect(result.shouldStop).toBe(true);
    expect(result.error).toContain('settle failed');
    expect(mock.releaseDecisionBatch).toHaveBeenCalledWith('batch-1');
    expect(ctx.runtimeControl).toBeUndefined();
  });

  it('routes active user messages into EXECUTE and defers other task changes', () => {
    const ctx = makeCtx();
    const events = [
      { ...event(1, 'user_message', { text: 'add a validation step' }), runId: ctx.runId },
      { ...event(2, 'setting_changed', { key: 'reasoning', value: 'high' }), runId: ctx.runId },
      { ...event(3, 'workspace_file_saved', { path: 'result.md' }), runId: ctx.runId },
    ];
    const mock = queue(events);
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeTaskEvents(ctx);

    expect(result).toMatchObject({
      shouldReplan: true,
      taskBookChanged: false,
      deferredEventIds: ['event-1', 'event-2', 'event-3'],
    });
    expect(ctx.deferredRuntimeEvents?.map((item) => item.id)).toEqual([
      'event-1', 'event-2', 'event-3',
    ]);
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining({ eventId: 'event-1', status: 'applied', reason: 'user-message-preserved-for-execute' }),
      expect.objectContaining({ eventId: 'event-2', status: 'ignored', reason: 'deferred-awaiting-replan' }),
      expect.objectContaining({ eventId: 'event-3', status: 'ignored', reason: 'deferred-awaiting-replan' }),
    ]);
  });

  it('captures mid-loop user messages at a safe request boundary and releases them once', () => {
    const ctx = makeCtx();
    const update = { ...event(1, 'user_message', { text: 'add a validation step' }), runId: ctx.runId };
    const mock = queue([update]);
    ctx.runtimeEventQueue = mock.port;

    const result = consumePendingRuntimeUserMessages(ctx);

    expect(result.events).toEqual([update]);
    expect(ctx.deferredRuntimeEvents).toEqual([update]);
    expect(ctx.deferredRuntimeEventIds).toEqual([update.id]);
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining({ eventId: update.id, status: 'applied', reason: 'user-message-preserved-for-execute' }),
    ]);
    expect(takeDeferredRuntimeUserMessages(ctx)).toEqual([update]);
    expect(ctx.deferredRuntimeEvents).toEqual([]);
    expect(takeDeferredRuntimeUserMessages(ctx)).toEqual([]);
  });

  it('releases a failed mid-loop message settlement without losing the event', () => {
    const ctx = makeCtx();
    const update = { ...event(1, 'user_message', { text: 'keep this update' }), runId: ctx.runId };
    const mock = queue([update], new Error('settle failed'));
    ctx.runtimeEventQueue = mock.port;

    const result = consumePendingRuntimeUserMessages(ctx);

    expect(result.events).toEqual([]);
    expect(result.error).toContain('settle failed');
    expect(ctx.deferredRuntimeEvents ?? []).toEqual([]);
    expect(mock.releaseDecisionBatch).toHaveBeenCalledWith('batch-1');
  });

  it('does not discard an older deferred event when the mid-loop buffer is full', () => {
    const ctx = makeCtx();
    const older = Array.from({ length: 32 }, (_, index) => event(index + 1, 'setting_changed'));
    ctx.deferredRuntimeEvents = older;
    ctx.deferredRuntimeEventIds = older.map((item) => item.id);
    const update = { ...event(33, 'user_message', { text: 'keep this update' }), runId: ctx.runId };
    const mock = queue([update]);
    ctx.runtimeEventQueue = mock.port;

    const result = consumePendingRuntimeUserMessages(ctx);

    expect(result.events).toEqual([]);
    expect(ctx.deferredRuntimeEvents).toEqual(older);
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining({ eventId: update.id, status: 'conflict', reason: 'deferred-runtime-event-capacity' }),
    ]);
  });

  it('applies a valid patch only to pending work and commits the revision atomically', () => {
    const ctx = makeCtx();
    ctx.taskBook = taskBook();
    ctx.taskBookRevision = 1;
    const update = { ...event(1, 'user_message', {}), runId: ctx.runId };
    update.payload.taskBookPatch = patchFor(ctx.runId, update.id, 'patch-1', 1, 'updated pending work');
    const mock = queue([update]);
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeTaskEvents(ctx);

    expect(result).toMatchObject({ taskBookChanged: true, shouldReplan: false, appliedPatchIds: ['patch-1'] });
    expect(ctx.taskBookRevision).toBe(2);
    expect(ctx.taskBook?.steps).toEqual([
      { id: 'done', description: 'preserve completed work', status: 'done' },
      { id: 'pending', description: 'updated pending work', status: 'pending' },
    ]);
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining({ eventId: update.id, status: 'applied' }),
    ]);
  });

  it('rejects revision, event, and protected-step patch violations without mutation', () => {
    const ctx = makeCtx();
    ctx.taskBook = taskBook();
    ctx.taskBookRevision = 2;
    const revision = { ...event(1, 'user_message', {}), runId: ctx.runId };
    revision.payload.patch = patchFor(ctx.runId, revision.id, 'bad-revision', 1, 'must not apply');
    const eventMismatch = { ...event(2, 'user_message', {}), runId: ctx.runId };
    eventMismatch.payload.patch = patchFor(ctx.runId, 'other-event', 'bad-event', 2, 'must not apply');
    const protectedStep = { ...event(3, 'user_message', {}), runId: ctx.runId };
    protectedStep.payload.patch = {
      ...patchFor(ctx.runId, protectedStep.id, 'bad-protected', 2, 'must not apply'),
      operations: [{
        type: 'update_pending_step' as const,
        stepId: 'done',
        patch: { description: 'must remain authoritative' },
      }],
    };
    const mock = queue([revision, eventMismatch, protectedStep]);
    ctx.runtimeEventQueue = mock.port;
    const before = structuredClone(ctx.taskBook);

    const result = consumeRuntimeTaskEvents(ctx);

    expect(result.taskBookChanged).toBe(false);
    expect(result.shouldReplan).toBe(false);
    expect(ctx.taskBook).toEqual(before);
    expect(ctx.taskBookRevision).toBe(2);
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining({ status: 'conflict', reason: 'taskbook-patch-revision-conflict' }),
      expect.objectContaining({ status: 'conflict', reason: 'taskbook-patch-event-mismatch' }),
      expect.objectContaining({ status: 'conflict', reason: 'taskbook-patch-protected-step' }),
    ]);
  });

  it('does not half-commit a patch when queue settlement fails', () => {
    const ctx = makeCtx();
    ctx.taskBook = taskBook();
    ctx.taskBookRevision = 1;
    const update = { ...event(1, 'user_message', {}), runId: ctx.runId };
    update.payload.taskBookPatch = patchFor(ctx.runId, update.id, 'patch-1', 1, 'must not commit');
    const mock = queue([update], new Error('settle failed'));
    ctx.runtimeEventQueue = mock.port;
    const before = structuredClone(ctx.taskBook);

    const result = consumeRuntimeTaskEvents(ctx);

    expect(result.error).toContain('settle failed');
    expect(ctx.taskBook).toEqual(before);
    expect(ctx.taskBookRevision).toBe(1);
    expect(ctx.appliedTaskBookPatchIds).toBeUndefined();
    expect(mock.releaseDecisionBatch).toHaveBeenCalledWith('batch-1');
  });

  it('serializes multiple patches in one batch against the staged revision', () => {
    const ctx = makeCtx();
    ctx.taskBook = taskBook();
    ctx.taskBookRevision = 1;
    const first = { ...event(1, 'user_message', {}), runId: ctx.runId };
    first.payload.patch = patchFor(ctx.runId, first.id, 'patch-1', 1, 'first update');
    const second = { ...event(2, 'user_message', {}), runId: ctx.runId };
    second.payload.patch = patchFor(ctx.runId, second.id, 'patch-2', 2, 'second update');
    const mock = queue([first, second]);
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeTaskEvents(ctx);

    expect(result.appliedPatchIds).toEqual(['patch-1', 'patch-2']);
    expect(ctx.taskBookRevision).toBe(3);
    expect(ctx.taskBook?.steps[1]?.description).toBe('second update');
  });

  it('bounds deferred runtime event payload retention', () => {
    const ctx = makeCtx();
    const events = Array.from({ length: 40 }, (_, index) => ({
      ...event(index + 1, 'user_message', { text: `event-${index + 1}` }),
      id: `event-${index + 1}`,
      runId: ctx.runId,
    }));
    const mock = queue(events);
    ctx.runtimeEventQueue = mock.port;

    const result = consumeRuntimeTaskEvents(ctx);

    expect(result.shouldReplan).toBe(true);
    expect(ctx.deferredRuntimeEvents).toHaveLength(32);
    expect(ctx.deferredRuntimeEvents?.[0]?.id).toBe('event-1');
    expect(result.deferredEventIds).toHaveLength(32);
    expect(mock.settleDecisionBatch).toHaveBeenCalledWith('batch-1', [
      ...Array.from({ length: 32 }, (_, index) => expect.objectContaining({
        eventId: `event-${index + 1}`,
        status: 'applied',
      })),
      ...Array.from({ length: 8 }, (_, index) => expect.objectContaining({
        eventId: `event-${index + 33}`,
        status: 'conflict',
      })),
    ]);
  });
});
