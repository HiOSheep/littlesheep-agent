import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  textMessage,
  type ContextSnapshot,
  type RunContext,
  type TaskStepResult,
} from '@littlesheep/types';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import { buildRunCheckpoint } from './run-checkpoint.js';

function contextWithSteps(steps: TaskStepResult[]): RunContext {
  const sessionId = asSessionId('session-checkpoint');
  const runId = 'run-checkpoint';
  return {
    runId,
    sessionId,
    inbound: textMessage('user', 'continue the task'),
    cwd: process.cwd(),
    model: 'test-model',
    tools: [],
    toolContext: { runId, sessionId, cwd: process.cwd() },
    history: [],
    produced: [],
    maxRecoveryAttempts: 3,
    startedAt: '2026-07-29T10:00:00.000Z',
    taskExecution: {
      goal: 'run bounded branches',
      complexity: 'standard',
      status: 'running',
      startedAt: '2026-07-29T10:00:00.000Z',
      steps,
    },
  };
}

function step(stepId: string, status: TaskStepResult['status']): TaskStepResult {
  return {
    stepId,
    description: stepId,
    status,
    executionMode: 'parallel',
    startedAt: '2026-07-29T10:00:00.000Z',
    toolCallIds: [],
    toolResults: [],
  };
}

describe('buildRunCheckpoint', () => {
  it('captures all bounded active parallel branches while retaining the legacy current step', () => {
    const ctx = contextWithSteps([
      step('done', 'done'),
      step('active-1', 'in_progress'),
      step('active-2', 'in_progress'),
      step('active-3', 'in_progress'),
      step('active-4', 'in_progress'),
      step('active-5', 'in_progress'),
    ]);

    const checkpoint = buildRunCheckpoint({
      ctx,
      stageResult: { stage: 'execute', next: 'exit', ok: false },
      reason: 'parallel work interrupted',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });

    expect(checkpoint.currentStepId).toBe('active-1');
    expect(checkpoint.activeStepIds).toEqual(['active-1', 'active-2', 'active-3', 'active-4']);
  });

  it('omits active branches when execution has no in-progress step', () => {
    const checkpoint = buildRunCheckpoint({
      ctx: contextWithSteps([step('done', 'done')]),
      stageResult: { stage: 'verify', next: 'exit', ok: false },
      reason: 'verification interrupted',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });

    expect(checkpoint.activeStepIds).toBeUndefined();
  });

  it('reconciles model-call observability into the durable loop budget', () => {
    const ctx = contextWithSteps([step('active', 'in_progress')]);
    ctx.modelCallCount = 3;
    ctx.maxModelCalls = 8;
    ctx.loopBudget = {
      attemptsUsed: 0,
      maxAttempts: 8,
      elapsedMs: 10,
      maxElapsedMs: 60_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    };

    const checkpoint = buildRunCheckpoint({
      ctx,
      stageResult: { stage: 'execute', next: 'exit', ok: false },
      reason: 'model call budget reconciliation',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });

    expect(checkpoint.loopBudget.attemptsUsed).toBe(3);
    expect(checkpoint.loopBudget.maxAttempts).toBe(8);
    expect(checkpoint.loopBudget.elapsedMs).toBeGreaterThanOrEqual(1_000);
  });

  it('references only the persisted tail of bounded Context snapshots', () => {
    const ctx = contextWithSteps([step('active', 'in_progress')]);
    ctx.contextSnapshots = Array.from({ length: MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN + 6 }, (_, index) => ({
      version: 1,
      id: `snapshot-${index}`,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      provider: 'test',
      model: 'model',
      createdAt: ctx.startedAt,
      budget: { status: 'unknown', reason: 'test' },
      items: [],
      totalItemCount: 0,
      itemsTruncated: false,
      compressionRecommended: false,
    } satisfies ContextSnapshot));

    const checkpoint = buildRunCheckpoint({
      ctx,
      stageResult: { stage: 'execute', next: 'exit', ok: false },
      reason: 'snapshot window',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });

    expect(checkpoint.contextSnapshotIds).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(checkpoint.contextSnapshotIds[0]).toBe('snapshot-6');
    expect(checkpoint.contextSnapshotIds.at(-1)).toBe(`snapshot-${MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN + 5}`);
  });
});
