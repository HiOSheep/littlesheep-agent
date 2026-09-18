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

  it('lets explicit runtime control outrank an unpublished clarification state', () => {
    const waiting = contextWithSteps([step('done', 'done')]);
    waiting.clarificationRequest = {
      id: 'pending-clarification',
      kind: 'recovery_decision',
      sourceStage: 'verify',
      createdAt: '2026-07-29T10:00:00.000Z',
      originalRequest: 'continue the task',
      blockingReason: 'verification needs a decision',
      questions: [{
        id: 'decision',
        field: 'recoveryDecision',
        prompt: 'How should verification continue?',
        required: true,
      }],
    };

    const ordinary = buildRunCheckpoint({
      ctx: waiting,
      stageResult: { stage: 'finalize', next: 'exit', ok: true },
      reason: 'waiting for a bound answer',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });
    // A clarification is answered by a normal reply now, so it no longer parks
    // the run: only an explicit pause or an interruption does.
    expect(ordinary.status).toBe('recoverable');

    waiting.runtimeControl = {
      version: 1,
      state: 'paused',
      changedAt: '2026-07-29T10:00:01.000Z',
      reason: 'user requested pause',
      eventIds: ['pause-event'],
    };
    const paused = buildRunCheckpoint({
      ctx: waiting,
      stageResult: { stage: 'ask_user', next: 'exit', ok: false },
      reason: 'paused before clarification publication',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });
    expect(paused.status).toBe('paused');

    waiting.runtimeControl = {
      version: 1,
      state: 'interrupted',
      changedAt: '2026-07-29T10:00:01.000Z',
      reason: 'user requested interrupt',
      eventIds: ['interrupt-event'],
    };
    const interrupted = buildRunCheckpoint({
      ctx: waiting,
      stageResult: { stage: 'ask_user', next: 'exit', ok: false },
      reason: 'interrupted before clarification publication',
      interrupted: true,
      now: new Date('2026-07-29T10:00:01.000Z'),
    });
    expect(interrupted.status).toBe('recoverable');
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

  it('keeps source line comments with restorable attachment references', () => {
    const ctx = contextWithSteps([step('active', 'in_progress')]);
    ctx.attachments = [{
      id: 'attachment-source',
      path: 'D:/work/src/app.ts',
      name: 'app.ts',
      kind: 'file',
      cacheId: 'cache-source',
      contentHash: 'a'.repeat(64),
      contextPath: 'src/app.ts',
      lineComments: [{ startLine: 42, endLine: 45, text: 'Keep this range atomic.' }],
    }];

    const checkpoint = buildRunCheckpoint({
      ctx,
      stageResult: { stage: 'execute', next: 'exit', ok: false },
      reason: 'attachment continuation',
      now: new Date('2026-07-29T10:00:01.000Z'),
    });

    expect(checkpoint.resumeState?.attachments?.[0]?.lineComments).toEqual([
      { startLine: 42, endLine: 45, text: 'Keep this range atomic.' },
    ]);
    expect(checkpoint.resumeState?.attachments?.[0]?.contextPath).toBe('src/app.ts');
  });

  it('whitelists Web evidence before checkpoint persistence', () => {
    const ctx = contextWithSteps([step('active', 'in_progress')]);
    ctx.webEvidence = {
      version: 1,
      generatedAt: '2026-08-29T00:00:00.000Z',
      completeness: 'complete',
      citationIds: ['web-run-1-source'],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: false,
      truncated: false,
      blocked: false,
      stale: false,
      query: 'CHECKPOINT_PRIVATE_QUERY',
      documents: [{ content: 'CHECKPOINT_WEB_BODY' }],
    } as never;

    const checkpoint = buildRunCheckpoint({
      ctx,
      stageResult: { stage: 'execute', next: 'exit', ok: false },
      reason: 'web evidence checkpoint',
      now: new Date('2026-08-29T00:00:01.000Z'),
    });

    const durable = JSON.stringify(checkpoint);
    expect(durable).not.toContain('CHECKPOINT_PRIVATE_QUERY');
    expect(durable).not.toContain('CHECKPOINT_WEB_BODY');
    expect(checkpoint.webEvidence?.citationIds).toEqual(['web-run-1-source']);
  });
});
