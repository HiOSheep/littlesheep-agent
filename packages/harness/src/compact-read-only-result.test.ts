import { describe, expect, it } from 'vitest';
import type { RunContext, TaskBook, TaskStepResult, ToolInvocationRecord } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import { isCompactReadOnlyResult } from './compact-read-only-result.js';

const CALL_ID = 'call-glob-1';

describe('isCompactReadOnlyResult', () => {
  it('accepts only a fully correlated builtin read-only result', () => {
    expect(isCompactReadOnlyResult(makeEligibleContext())).toBe(true);
  });

  it.each([
    ['a mismatched invocation call id', (ctx: RunContext) => { ctx.toolInvocations![0]!.callId = 'other-call'; }],
    ['a mismatched step result call id', (ctx: RunContext) => { ctx.taskExecution!.steps[0]!.toolResults[0]!.callId = 'other-call'; }],
    ['a sanitized tool result', (ctx: RunContext) => { ctx.taskExecution!.steps[0]!.toolResults[0]!.sanitized = true; }],
    ['a sanitized invocation record', (ctx: RunContext) => { ctx.toolInvocations![0]!.outputSanitized = true; }],
    ['an approval-bearing invocation', (ctx: RunContext) => {
      ctx.toolInvocations![0]!.approval = { required: true, decision: 'approved' };
    }],
  ])('rejects %s', (_label, mutate) => {
    const ctx = makeEligibleContext();
    mutate(ctx);
    expect(isCompactReadOnlyResult(ctx)).toBe(false);
  });
});

function makeEligibleContext(): RunContext {
  const taskBook = makeTaskBook();
  const result = makeStepResult();
  const ctx = makeCtx({
    taskBook,
    toolSources: { glob: 'builtin' },
    classification: {
      activity: 'execute',
      type: 'problem',
      confidence: 0.99,
      source: 'rules',
      reason: 'explicit tool instruction',
    },
  });
  ctx.taskExecution = {
    goal: taskBook.goal,
    complexity: taskBook.complexity,
    status: 'done',
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    steps: [result],
  };
  ctx.toolInvocations = [makeInvocation(ctx)];
  ctx.sideEffects = [];
  return ctx;
}

function makeTaskBook(): TaskBook {
  return {
    assessment: {
      userNeed: 'list top-level entries',
      complexity: 'trivial',
      goal: 'list top-level entries',
      successCriteria: ['return the entries'],
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    goal: 'list top-level entries',
    complexity: 'trivial',
    successCriteria: ['return the entries'],
    steps: [{
      id: 'step-1',
      description: 'list top-level entries',
      tools: ['glob'],
      toolProposal: { name: 'glob', input: { pattern: '*', path: '.' } },
      execution: { mode: 'serial', sideEffect: 'read' },
    }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
  };
}

function makeStepResult(): TaskStepResult {
  return {
    stepId: 'step-1',
    description: 'list top-level entries',
    status: 'done',
    startedAt: '2026-08-03T18:00:00.000Z',
    endedAt: '2026-08-03T18:00:00.100Z',
    output: 'alpha.txt',
    toolCallIds: [CALL_ID],
    toolResults: [{ callId: CALL_ID, ok: true, output: 'alpha.txt' }],
  };
}

function makeInvocation(ctx: RunContext): ToolInvocationRecord {
  return {
    version: 1,
    id: 'invocation-1',
    callId: CALL_ID,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    stepId: 'step-1',
    toolName: 'glob',
    toolSource: 'builtin',
    status: 'succeeded',
    proposedAt: '2026-08-03T18:00:00.000Z',
    resolvedAt: '2026-08-03T18:00:00.100Z',
    approval: { required: false, decision: 'not_required' },
    evidenceIds: [],
  };
}
