import { describe, expect, it } from 'vitest';
import type { RunContext } from '@littlesheep/types';
import { updateClarificationRequest, writeDecisionState } from './decision-state.js';

function makeContext(): RunContext {
  return {
    runId: 'run-decision-state',
    sessionId: 'session-decision-state' as RunContext['sessionId'],
    inbound: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: '2026-08-10T00:00:00.000Z' },
    cwd: 'C:\\workspace',
    model: 'test-model',
    tools: [],
    toolContext: { sessionId: 'session-decision-state' as RunContext['sessionId'], runId: 'run-decision-state', cwd: 'C:\\workspace' },
    history: [],
    produced: [],
    maxRecoveryAttempts: 2,
    startedAt: '2026-08-10T00:00:00.000Z',
  };
}

const request = {
  id: 'request-1',
  kind: 'ambiguous_request' as const,
  sourceStage: 'classify' as const,
  createdAt: '2026-08-10T00:00:00.000Z',
  originalRequest: 'task',
  blockingReason: 'missing intent',
  questions: [{ id: 'question-1', field: 'intent', prompt: 'What should I do?', required: true }],
};

describe('decision state boundary', () => {
  it('commits routing, demand and clarification fields as one batch', () => {
    const ctx = makeContext();
    writeDecisionState(ctx, 'decide', {
      needAssessment: {
        userNeed: 'task', complexity: 'simple', goal: 'task', successCriteria: ['done'],
        requiresTaskBook: false, maxExtraScopeRatio: 1,
      },
      clarificationRequest: request,
    });
    expect(ctx.needAssessment?.goal).toBe('task');
    expect(ctx.clarificationRequest).toEqual(request);
  });

  it('rejects a forbidden batch before mutating any field', () => {
    const ctx = makeContext();
    ctx.needAssessment = {
      userNeed: 'old', complexity: 'simple', goal: 'old', successCriteria: ['old'],
      requiresTaskBook: false, maxExtraScopeRatio: 1,
    };
    expect(() => writeDecisionState(ctx, 'classify', {
      classification: { activity: 'execute', confidence: 1, source: 'rules' },
      needAssessment: undefined,
    })).toThrow(/cannot be written during 'classify'/);
    expect(ctx.needAssessment?.goal).toBe('old');
    expect(ctx.classification).toBeUndefined();
  });

  it('updates clarification text through a copied request', () => {
    const ctx = makeContext();
    writeDecisionState(ctx, 'classify', { clarificationRequest: request });
    const original = ctx.clarificationRequest;
    const next = updateClarificationRequest(ctx, 'ask_user', (value) => ({ ...value, prompt: 'Please specify the goal.' }));
    expect(original?.prompt).toBeUndefined();
    expect(next.prompt).toBe('Please specify the goal.');
    expect(ctx.clarificationRequest).toEqual(next);
  });
});
