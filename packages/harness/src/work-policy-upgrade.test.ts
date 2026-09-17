import { describe, expect, it } from 'vitest';
import { textMessage } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import {
  buildWorkPolicyUpgradeRequest,
  parseWorkPolicyUpgradeProposal,
  workPolicyTransitionViolation,
} from './work-policy-upgrade.js';

function boundedCtx() {
  const ctx = makeCtx({ inbound: textMessage('user', '帮我修复这个文件') });
  ctx.classification = {
    activity: 'execute',
    type: 'problem',
    confidence: 0.8,
    source: 'rules',
    reasonCode: 'action_request',
    workPolicy: {
      version: 1,
      route: 'execute',
      sourceMessageId: String(ctx.inbound.id),
      executionMode: 'bounded_loop',
      reasonCode: 'bounded_single_goal',
    },
  };
  return ctx;
}

describe('work-policy TaskBook promotion', () => {
  it('accepts only the closed promotion proposal schema', () => {
    expect(parseWorkPolicyUpgradeProposal({
      reasonCode: 'dependency_discovered',
      reason: 'A second file owns the contract.',
      remainingGoal: 'Update and verify the second file.',
    })).toEqual({
      reasonCode: 'dependency_discovered',
      reason: 'A second file owns the contract.',
      remainingGoal: 'Update and verify the second file.',
    });
    expect(parseWorkPolicyUpgradeProposal({ reasonCode: 'other', reason: 'x' })).toBeUndefined();
    expect(parseWorkPolicyUpgradeProposal({ reasonCode: 'acceptance_gap', reason: 'x', command: 'write' })).toBeUndefined();
  });

  it('binds the request to the run, source goal, completed evidence, and spent model budget', () => {
    const ctx = boundedCtx();
    ctx.modelCallCount = 3;
    const request = buildWorkPolicyUpgradeRequest(ctx, {
      reasonCode: 'scope_expanded',
      reason: 'The implementation spans dependent files.',
      remainingGoal: 'Update the dependent file and verify both.',
    }, [
      { callId: 'read-a', ok: true, output: 'a' },
      { callId: 'read-a', ok: true, output: 'a' },
      { callId: 'read-b', ok: false, error: 'blocked' },
    ]);
    expect(request).toMatchObject({
      version: 1,
      runId: ctx.runId,
      sourceMessageId: ctx.inbound.id,
      goalVersion: 1,
      completedToolCallIds: ['read-a'],
      modelAttemptsUsed: 3,
      remainingGoal: 'Update the dependent file and verify both.',
      pendingToolCallIds: [],
      budget: {
        maxModelAttempts: 0,
        toolLoopIterationsUsed: 0,
        maxToolLoopIterations: 20,
        noProgressRounds: 0,
      },
    });
  });

  it('refuses promotion across an unknown effect', () => {
    const ctx = boundedCtx();
    ctx.sideEffects = [{ idempotencyKey: 'effect-1', toolName: 'write', status: 'unknown' }];
    expect(() => buildWorkPolicyUpgradeRequest(ctx, {
      reasonCode: 'acceptance_gap',
      reason: 'Need another check.',
      remainingGoal: 'Run the missing check.',
    }, [])).toThrow(/pending or unknown/);
  });

  it('guards execute -> decide with the exact persisted request identity', () => {
    const ctx = boundedCtx();
    const request = buildWorkPolicyUpgradeRequest(ctx, {
      reasonCode: 'long_running',
      reason: 'The remaining task requires durable steps.',
      remainingGoal: 'Complete the durable steps.',
    }, []);
    ctx.workPolicyUpgradeRequest = request;
    expect(workPolicyTransitionViolation(ctx, 'execute', {
      stage: 'execute', next: 'decide', ok: true,
      meta: { workPolicyUpgradeRequestId: request.id },
    })).toBeUndefined();
    expect(workPolicyTransitionViolation(ctx, 'execute', {
      stage: 'execute', next: 'decide', ok: true,
      meta: { workPolicyUpgradeRequestId: 'wrong' },
    })).toMatch(/does not reference/);
  });
});
