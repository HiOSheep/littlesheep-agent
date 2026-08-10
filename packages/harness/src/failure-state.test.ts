import { describe, expect, it } from 'vitest';
import type { RunContext } from '@littlesheep/types';
import {
  clearFailure,
  incrementRecoveryAttempts,
  recordFailure,
  writeFailureState,
} from './failure-state.js';

function makeContext(): RunContext {
  return {
    runId: 'run-failure-state',
    sessionId: 'session-failure-state' as RunContext['sessionId'],
    inbound: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: '2026-08-10T00:00:00.000Z' },
    cwd: 'C:\\workspace',
    model: 'test-model',
    tools: [],
    toolContext: { sessionId: 'session-failure-state' as RunContext['sessionId'], runId: 'run-failure-state', cwd: 'C:\\workspace' },
    history: [],
    produced: [],
    maxRecoveryAttempts: 2,
    startedAt: '2026-08-10T00:00:00.000Z',
  };
}

describe('failure state boundary', () => {
  it('commits an error and recovery counter as one validated batch', () => {
    const ctx = makeContext();
    writeFailureState(ctx, 'recover', {
      lastError: { stage: 'execute', message: 'permission denied' },
      recoveryAttempts: 1,
    });
    expect(ctx.lastError).toEqual({ stage: 'execute', message: 'permission denied' });
    expect(ctx.recoveryAttempts).toBe(1);
  });

  it('rejects a forbidden batch before mutating either field', () => {
    const ctx = makeContext();
    ctx.lastError = { stage: 'execute', message: 'old' };
    ctx.recoveryAttempts = 2;

    expect(() => writeFailureState(ctx, 'decide', {
      lastError: { stage: 'decide', message: 'new' },
      recoveryAttempts: 3,
    })).toThrow(/cannot be written during 'decide'/);
    expect(ctx.lastError?.message).toBe('old');
    expect(ctx.recoveryAttempts).toBe(2);
  });

  it('provides explicit record, increment and clear operations', () => {
    const ctx = makeContext();
    recordFailure(ctx, 'execute', 'execute', 'tool failed');
    expect(ctx.lastError?.stage).toBe('execute');
    expect(incrementRecoveryAttempts(ctx, 'recover')).toBe(1);
    expect(incrementRecoveryAttempts(ctx, 'recover')).toBe(2);
    clearFailure(ctx, 'execute');
    expect(ctx.lastError).toBeUndefined();
  });
});
