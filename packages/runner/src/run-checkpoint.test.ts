import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  textMessage,
  type RunContext,
  type TaskStepResult,
} from '@littlesheep/types';
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
});
