import { describe, expect, it } from 'vitest';
import type { ContextSnapshot, ModelRequestSnapshot, RunContext } from '@littlesheep/types';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import {
  appendModelObservations,
  incrementModelCallCount,
  updateContextSnapshot,
  writeModelObservabilityState,
} from './model-observability-state.js';

function makeContext(): RunContext {
  return {
    runId: 'run-model-observability',
    sessionId: 'session-model-observability' as RunContext['sessionId'],
    inbound: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: '2026-08-10T00:00:00.000Z' },
    cwd: 'C:\\workspace',
    model: 'test-model',
    tools: [],
    toolContext: { sessionId: 'session-model-observability' as RunContext['sessionId'], runId: 'run-model-observability', cwd: 'C:\\workspace' },
    history: [],
    produced: [],
    maxRecoveryAttempts: 2,
    startedAt: '2026-08-10T00:00:00.000Z',
  };
}

function request(index: number): ModelRequestSnapshot {
  return {
    version: 1,
    id: `request-${index}`,
    runId: 'run-model-observability',
    sessionId: 'session-model-observability' as RunContext['sessionId'],
    requestIndex: index,
    stage: 'execute',
    purpose: 'execute_tool_loop',
    provider: 'test',
    model: 'test-model',
    messages: [],
    totalMessageCount: 0,
    totalToolCount: 0,
    stream: false,
    payloadHash: 'hash',
  } as ModelRequestSnapshot;
}

function snapshot(index: number): ContextSnapshot {
  return {
    version: 1,
    id: `snapshot-${index}`,
    runId: 'run-model-observability',
    sessionId: 'session-model-observability' as RunContext['sessionId'],
    stage: 'execute',
    requestIndex: index,
    provider: 'test',
    model: 'test-model',
    budget: { status: 'unknown' },
    items: [],
  } as ContextSnapshot;
}

describe('model observability state boundary', () => {
  it('rejects a forbidden budget update before mutation', () => {
    const ctx = makeContext();
    expect(() => writeModelObservabilityState(ctx, 'finalize', { modelCallCount: 2 })).toThrow(/cannot be written during 'finalize'/);
    expect(ctx.modelCallCount).toBeUndefined();
  });

  it('increments the counter and keeps observations bounded', () => {
    const ctx = makeContext();
    incrementModelCallCount(ctx, 'execute');
    appendModelObservations(ctx, 'execute', request(1), snapshot(1), 2);
    appendModelObservations(ctx, 'execute', request(2), snapshot(2), 2);
    appendModelObservations(ctx, 'execute', request(3), snapshot(3), 2);

    expect(ctx.modelCallCount).toBe(1);
    expect(ctx.modelRequests?.map((item) => item.requestIndex)).toEqual([2, 3]);
    expect(ctx.contextSnapshots?.map((item) => item.requestIndex)).toEqual([2, 3]);
  });

  it('replaces one context snapshot immutably', () => {
    const ctx = makeContext();
    appendModelObservations(ctx, 'execute', request(1), snapshot(1), 4);
    const before = ctx.contextSnapshots;
    updateContextSnapshot(ctx, 'execute', 'snapshot-1', (current) => ({ ...current, itemsTruncated: true }));

    expect(ctx.contextSnapshots).not.toBe(before);
    expect(ctx.contextSnapshots?.[0]?.itemsTruncated).toBe(true);
  });

  it('never lets a caller expand the shared observation window', () => {
    const ctx = makeContext();
    for (let index = 1; index <= MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN + 4; index += 1) {
      appendModelObservations(ctx, 'execute', request(index), snapshot(index), Number.MAX_SAFE_INTEGER);
    }

    expect(ctx.modelRequests).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(ctx.contextSnapshots).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(ctx.modelRequests?.[0]?.requestIndex).toBe(5);
    expect(ctx.contextSnapshots?.[0]?.requestIndex).toBe(5);
  });
});
