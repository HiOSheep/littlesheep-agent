import { describe, expect, it } from 'vitest';
import type { RunContext } from '@littlesheep/types';
import { writeRunTaskState } from './run-task-state.js';

function makeContext(): RunContext {
  return {
    runId: 'run-task-state',
    sessionId: 'session-task-state' as RunContext['sessionId'],
    inbound: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: '2026-08-10T00:00:00.000Z' },
    cwd: 'C:\\workspace',
    model: 'test-model',
    tools: [],
    toolContext: { sessionId: 'session-task-state' as RunContext['sessionId'], runId: 'run-task-state', cwd: 'C:\\workspace' },
    history: [],
    produced: [],
    maxRecoveryAttempts: 2,
    startedAt: '2026-08-10T00:00:00.000Z',
    taskBookRevision: 1,
  };
}

describe('run task-state boundary', () => {
  it('commits a validated task-state batch and keeps the fields explicit', () => {
    const ctx = makeContext();
    const taskBook = {
      goal: 'read one file',
      complexity: 'simple' as const,
      steps: [{ id: 'step-1', title: 'Read', description: 'Read', status: 'pending' as const }],
      successCriteria: ['content is returned'],
      assessment: { goal: 'read one file', complexity: 'simple' as const, requiresTaskBook: true, needsClarification: false, maxExtraScopeRatio: 0 },
    };

    writeRunTaskState(ctx, 'decide', {
      taskBook,
      plan: taskBook.steps,
      taskBookRevision: 2,
    });

    expect(ctx.taskBook).toEqual(taskBook);
    expect(ctx.plan).toEqual(taskBook.steps);
    expect(ctx.taskBookRevision).toBe(2);
  });

  it('rejects an invalid batch before mutating any field', () => {
    const ctx = makeContext();
    const previousPlan = [{ description: 'original', id: 'step-1', status: 'pending' as const }];
    ctx.plan = previousPlan;

    expect(() => writeRunTaskState(ctx, 'verify', {
      plan: [{ description: 'should not commit', id: 'step-1', status: 'pending' as const }],
      taskBook: undefined,
    })).toThrow(/cannot be written/);
    expect(ctx.plan).toBe(previousPlan);
  });
});
