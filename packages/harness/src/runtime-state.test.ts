import { describe, expect, it } from 'vitest';
import type {
  LoopBudgetSnapshot,
  RuntimeControlSnapshot,
  RuntimeEventEnvelope,
} from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import { writeRuntimeState } from './runtime-state.js';

const control: RuntimeControlSnapshot = {
  version: 1,
  state: 'paused',
  changedAt: '2026-08-10T03:30:00.000Z',
  reason: 'user requested pause',
  eventIds: ['event-1'],
};

const budget: LoopBudgetSnapshot = {
  attemptsUsed: 2,
  maxAttempts: 8,
  elapsedMs: 120,
  maxElapsedMs: 5_000,
  noProgressRounds: 0,
  maxNoProgressRounds: 2,
};

const event: RuntimeEventEnvelope = {
  version: 1,
  id: 'event-1',
  runId: 'run-runtime-state',
  sessionId: asSessionId('session-runtime-state'),
  sequence: 1,
  type: 'user_message',
  source: 'app',
  status: 'queued',
  receivedAt: '2026-08-10T03:30:00.000Z',
  payload: { text: 'continue' },
};

describe('runtime state boundary', () => {
  it('commits the runtime fields as one validated batch', () => {
    const ctx = makeCtx();
    const queue = { snapshot: () => undefined } as never;

    writeRuntimeState(ctx, 'runner-init', {
      runtimeEventQueue: queue,
      deferredRuntimeEvents: [event],
      deferredRuntimeEventIds: ['event-1'],
      loopBudget: budget,
    });
    writeRuntimeState(ctx, 'runtime-boundary', { runtimeControl: control });

    expect(ctx.runtimeControl).toEqual(control);
    expect(ctx.runtimeEventQueue).toBe(queue);
    expect(ctx.deferredRuntimeEvents).toEqual([event]);
    expect(ctx.deferredRuntimeEventIds).toEqual(['event-1']);
    expect(ctx.loopBudget).toEqual(budget);
  });

  it('rejects the whole batch before mutating context', () => {
    const ctx = makeCtx({
      deferredRuntimeEvents: [event],
      deferredRuntimeEventIds: ['event-1'],
    });
    const before = structuredClone({
      deferredRuntimeEvents: ctx.deferredRuntimeEvents,
      deferredRuntimeEventIds: ctx.deferredRuntimeEventIds,
    });

    expect(() => writeRuntimeState(ctx, 'decide', {
      deferredRuntimeEvents: [],
      deferredRuntimeEventIds: [],
      runtimeControl: control,
    })).toThrow(/cannot be written during 'decide'/);

    expect({
      deferredRuntimeEvents: ctx.deferredRuntimeEvents,
      deferredRuntimeEventIds: ctx.deferredRuntimeEventIds,
      runtimeControl: ctx.runtimeControl,
    }).toEqual({ ...before, runtimeControl: undefined });
  });

  it('supports checkpoint restore and clearing a stale control snapshot', () => {
    const ctx = makeCtx({ runtimeControl: control });

    writeRuntimeState(ctx, 'runner-restore', {
      runtimeControl: undefined,
      deferredRuntimeEvents: [event],
      deferredRuntimeEventIds: ['event-1'],
      loopBudget: budget,
    });

    expect(ctx.runtimeControl).toBeUndefined();
    expect(ctx.deferredRuntimeEvents).toEqual([event]);
    expect(ctx.deferredRuntimeEventIds).toEqual(['event-1']);
    expect(ctx.loopBudget).toEqual(budget);
  });

  it('rejects unknown runtime fields without mutation', () => {
    const ctx = makeCtx();
    ctx.loopBudget = budget;

    expect(() => writeRuntimeState(ctx, 'runner-init', {
      loopBudget: budget,
      // @ts-expect-error regression coverage for runtime callers
      unexpected: true,
    })).toThrow(/Unknown runtime state field/);

    expect(ctx.loopBudget).toEqual(budget);
  });
});
