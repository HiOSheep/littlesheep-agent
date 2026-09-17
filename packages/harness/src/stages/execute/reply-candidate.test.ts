import { describe, expect, it } from 'vitest';
import type { ModelRequestSnapshot, TaskBook, TaskStepResult } from '@littlesheep/types';
import { makeCtx } from '../../tests/helpers.js';
import { createTaskStepReplyCandidate, reusableTaskStepReplyCandidate } from './reply-candidate.js';

function taskBook(): TaskBook {
  return {
    assessment: {
      userNeed: 'read one file',
      complexity: 'simple',
      goal: 'read one file',
      successCriteria: ['report exact content'],
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    goal: 'read one file',
    complexity: 'simple',
    successCriteria: ['report exact content'],
    steps: [{ id: 'step-1', description: 'read it', acceptanceCriteria: ['report exact content'] }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay in scope' },
  };
}

function step(): TaskStepResult {
  return {
    stepId: 'step-1',
    description: 'read it',
    status: 'done',
    startedAt: '2026-09-13T00:00:00.000Z',
    endedAt: '2026-09-13T00:00:01.000Z',
    output: 'The file contains A.',
    toolCallIds: ['call-1'],
    toolResults: [{ callId: 'call-1', ok: true, output: 'A' }],
  };
}

describe('TaskBook final reply candidates', () => {
  it('binds reuse to the exact run, goal, evidence, and Provider request', () => {
    const ctx = makeCtx();
    ctx.modelRequests = [request(ctx.runId, String(ctx.sessionId), 'request-1')];
    const book = taskBook();
    const result = step();
    result.replyCandidate = createTaskStepReplyCandidate(ctx, book, result, 'request-1');

    expect(reusableTaskStepReplyCandidate(ctx, book, result)).toMatchObject({
      modelRequestId: 'request-1',
      coversGoal: true,
    });

    result.toolResults[0] = { callId: 'call-1', ok: true, output: 'B' };
    expect(reusableTaskStepReplyCandidate(ctx, book, result)).toBeUndefined();
  });

  it('does not qualify partial multi-step copy or Runtime/tool-only output', () => {
    const ctx = makeCtx();
    ctx.modelRequests = [request(ctx.runId, String(ctx.sessionId), 'request-1')];
    const book = taskBook();
    book.steps.push({ id: 'step-2', description: 'verify it' });
    const result = step();
    result.replyCandidate = createTaskStepReplyCandidate(ctx, book, result, 'request-1');
    expect(result.replyCandidate?.coversGoal).toBe(false);
    expect(reusableTaskStepReplyCandidate(ctx, book, result)).toBeUndefined();
    expect(createTaskStepReplyCandidate(ctx, book, result, undefined)).toBeUndefined();
  });
});

function request(runId: string, sessionId: string, id: string): ModelRequestSnapshot {
  return {
    version: 1,
    id,
    runId,
    sessionId: sessionId as ModelRequestSnapshot['sessionId'],
    stage: 'execute',
    requestIndex: 1,
    provider: 'test',
    model: 'test-model',
    createdAt: '2026-09-13T00:00:00.000Z',
    messages: [],
    totalMessageCount: 0,
    messagesTruncated: false,
    toolNames: [],
    totalToolCount: 0,
    toolsTruncated: false,
    stream: false,
    callContract: { purpose: 'execute_tool_loop' } as NonNullable<ModelRequestSnapshot['callContract']>,
  };
}
