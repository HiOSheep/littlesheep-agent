// @littlesheep/harness — stages/recover.test.ts
// RECOVER is Runtime-owned: no model request is spent, retries are bounded, hard
// stops are explicit, and anything undecidable is handed to ASK_USER.
import { describe, it, expect } from 'vitest';
import { createRecoverStage } from './recover.js';
import { makeCtx } from '../tests/helpers.js';
import { textMessage, type RunContext, type TaskStepFailureKind } from '@littlesheep/types';

const stage = createRecoverStage();

function withFailedStep(ctx: RunContext, failureKind: TaskStepFailureKind): RunContext {
  ctx.taskBook = {
    assessment: {
      userNeed: 'do the work',
      complexity: 'standard',
      goal: 'do the work',
      successCriteria: ['work is done'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'do the work',
    complexity: 'standard',
    successCriteria: ['work is done'],
    steps: [{ id: 'step-1', description: 'do the work' }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
  };
  ctx.taskExecution = {
    goal: 'do the work',
    complexity: 'standard',
    status: 'failed',
    startedAt: '2026-09-20T00:00:00.000Z',
    steps: [{
      stepId: 'step-1',
      description: 'do the work',
      status: 'failed',
      failureKind,
      attempt: 1,
      toolCallIds: [],
      toolResults: [],
    }],
  };
  return ctx;
}

describe('recoverStage', () => {
  it('retries the failed stage without a model request', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'execute', message: 'tool failed' },
      inbound: textMessage('user', 'go'),
    });
    withFailedStep(ctx, 'tool_error');

    const res = await stage(ctx);

    expect(res).toMatchObject({
      next: 'execute',
      ok: true,
      meta: { deterministicRetry: true, reasonCode: 'retryable_tool_error' },
    });
    expect(ctx.recoveryAttempts).toBe(1);
    expect(ctx.modelRequests ?? []).toHaveLength(0);
    expect(ctx.clarificationRequest).toBeUndefined();
  });

  it.each([
    // A legacy checkpoint can name the retired DECIDE stage as the failure; the
    // retry lands in the main loop instead of an unregistered stage.
    ['decide', 'execute'],
    ['execute', 'execute'],
    ['verify', 'verify'],
    ['reply', 'reply'],
    ['plan', 'execute'],
  ] as const)('retries the stage that failed (%s → %s)', async (failedStage, expected) => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: failedStage, message: 'failed' },
      inbound: textMessage('user', 'go'),
    });

    const res = await stage(ctx);

    expect(res.next).toBe(expected);
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('retries the failing stage once after a structured decode failure', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'decide', message: 'failed to decode decision after 2 attempt(s)' },
      inbound: textMessage('user', '请只回复 OK'),
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({
      next: 'execute',
      ok: true,
      meta: { deterministicRetry: true, reasonCode: 'structured_decode_retry' },
    });
    expect(ctx.reply).toBeUndefined();
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('escalates a recorded permission denial to ASK_USER with runtime facts', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'execute', message: 'permission denied for write' },
      inbound: textMessage('user', '写入文件'),
    });
    withFailedStep(ctx, 'permission_denied');

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'ask_user', ok: true, meta: { action: 'escalate', reasonCode: 'permission_denied' } });
    expect(ctx.clarificationRequest).toMatchObject({
      kind: 'recovery_decision',
      sourceStage: 'recover',
      copySource: 'runtime_fallback',
    });
    expect(ctx.clarificationRequest?.questions[0]?.options).toHaveLength(3);
    expect(ctx.reply).toBeUndefined();
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('stops the run with an explicit Runtime status when a side effect is unsettled', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'verify', message: 'the effect outcome is unknown' },
      inbound: textMessage('user', 'run the mutating probe'),
    });
    ctx.sideEffects = [{
      idempotencyKey: 'unknown-effect',
      toolName: 'mutate_probe',
      status: 'unknown',
      callId: 'call-1',
    }];

    const res = await stage(ctx);

    expect(res).toMatchObject({
      next: 'exit',
      ok: false,
      meta: { action: 'abort', reasonCode: 'unsettled_side_effect' },
    });
    expect(res.error).toContain('side effect was not settled');
    expect(ctx.lastError).toMatchObject({ stage: 'recover' });
    // Nothing user-visible is fabricated and no model request is spent.
    expect(ctx.reply).toBeUndefined();
    expect(ctx.replyProvenance).toBeUndefined();
    expect(ctx.finalReplySettlement).toBeUndefined();
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('stops the run when the recorded failure is an abort', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'execute', message: 'run aborted by the user' },
      inbound: textMessage('user', 'go'),
    });
    withFailedStep(ctx, 'aborted');

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'exit', ok: false, meta: { action: 'abort', reasonCode: 'run_aborted' } });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('escalates when the recovery budget is exhausted', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 2,
      maxRecoveryAttempts: 2,
      lastError: { stage: 'execute', message: 'still failing' },
      inbound: textMessage('user', 'go'),
    });

    const res = await stage(ctx);

    expect(res).toMatchObject({
      next: 'ask_user',
      ok: true,
      meta: { forcedEscalate: true, reasonCode: 'recovery_budget_exhausted' },
    });
    expect(ctx.clarificationRequest?.copySource).toBe('runtime_fallback');
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('honors one bound user retry after the checkpoint exhausted autonomous recovery', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 5,
      maxRecoveryAttempts: 2,
      lastError: { stage: 'execute', message: 'blocked document step' },
      inbound: textMessage('user', 'retry'),
    });
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.conversationContinuation = {
      version: 1,
      resolution: 'bound',
      disposition: 'retry',
      resumeStage: 'recover',
    } as RunContext['conversationContinuation'];

    const first = await stage(ctx);
    const second = await stage(ctx);

    expect(first).toMatchObject({ next: 'execute', ok: true, meta: { deterministicContinuationRetry: true } });
    // The bound retry is consumed exactly once; the next call falls back to the
    // exhausted budget path.
    expect(second).toMatchObject({ next: 'ask_user', ok: true, meta: { forcedEscalate: true } });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('escalates a spent run budget on the first detection instead of retrying execute', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      lastError: { stage: 'execute', message: 'tool loop exceeded the persisted 20-iteration run budget' },
      inbound: textMessage('user', '做一个小游戏吧'),
    });

    const res = await stage(ctx);

    // Retrying cannot change a ceiling recorded on the run: the retried stage
    // re-enters it already exhausted. Measured on a real acceptance run, the
    // retry cost four execute rounds before the same escalation.
    expect(res).toMatchObject({
      next: 'ask_user',
      ok: true,
      meta: { action: 'escalate', reasonCode: 'execution_budget_exhausted' },
    });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
    const reason = ctx.clarificationRequest?.blockingReason ?? '';
    expect(reason).toContain('恢复预算耗尽');
    expect(reason).toContain('预算已经用尽');
  });

  it('still retries a transient provider failure that only reads like a model error', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      lastError: { stage: 'execute', message: 'llm call failed: 502 bad gateway' },
      inbound: textMessage('user', 'go'),
    });

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'execute', ok: true, meta: { deterministicRetry: true } });
  });

  it('increments recoveryAttempts on every call', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });

    await stage(ctx);
    await stage(ctx);

    expect(ctx.recoveryAttempts).toBe(2);
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });
});

// CE-08: the single loop writes no TaskBook steps, so the classification that
// decided retry-versus-escalate had nothing to read and every failure was
// retried until the budget ran out. These use only the evidence an ordinary run
// records: invocation statuses and the latest failure text.
describe('recoverStage classification without TaskBook steps', () => {
  function withInvocations(ctx: RunContext, statuses: NonNullable<RunContext['toolInvocations']>[number]['status'][]): RunContext {
    ctx.toolInvocations = statuses.map((status, index) => ({
      version: 1 as const,
      id: `record-${index}`,
      callId: `call-${index}`,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'write',
      toolSource: 'builtin',
      status,
      proposedAt: '2026-09-23T00:00:00.000Z',
      approval: { required: true as const, decision: 'denied' as const },
      evidenceIds: [],
    }));
    return ctx;
  }

  it('escalates a permission denial immediately instead of spending the retry budget', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      lastError: { stage: 'execute', message: 'tool invocation call-0 is approval_denied' },
      inbound: textMessage('user', '把生成的文件写进核心源码目录'),
    });
    withInvocations(ctx, ['approval_denied']);

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'ask_user', ok: true, meta: { reasonCode: 'permission_denied' } });
    // One attempt consumed, not the whole budget.
    expect(ctx.recoveryAttempts).toBe(1);
    const reason = ctx.clarificationRequest?.blockingReason ?? '';
    expect(reason).toContain('权限不足');
    expect(reason).toContain('授予缺失的权限');
    expect(reason).toContain('已完成');
  });

  it('stops instead of retrying when the run recorded a cancellation', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      lastError: { stage: 'execute', message: 'run aborted by the user' },
      inbound: textMessage('user', 'go'),
    });
    withInvocations(ctx, ['aborted']);

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'exit', ok: false, meta: { action: 'abort', reasonCode: 'run_aborted' } });
  });

  it('escalates a poisoned core-source write as a permission cause, not a budget one', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      lastError: { stage: 'execute', message: 'LittleSheep core source is read-only in this version: D:\\core\\game.html' },
      inbound: textMessage('user', '把游戏写进核心源码目录'),
    });
    ctx.toolInvocations = [{
      version: 1,
      id: 'record-0',
      callId: 'call-0',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'write',
      toolSource: 'builtin',
      status: 'failed',
      errorKind: 'core_source_read_only',
      proposedAt: '2026-09-23T00:00:00.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'ask_user', meta: { reasonCode: 'permission_denied' } });
    expect(ctx.clarificationRequest?.blockingReason ?? '').toContain('权限不足');
  });

  it('names an unrecoverable evidence gap as its own cause', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 3,
      maxRecoveryAttempts: 2,
      lastError: { stage: 'verify', message: 'tool result call-1 is missing' },
      inbound: textMessage('user', '继续做完'),
    });

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'ask_user', meta: { forcedEscalate: true } });
    const request = ctx.clarificationRequest!;
    expect(request.blockingReason).toContain('证据不可恢复');
    expect(request.blockingReason).toContain('无法自动修复');
    // The facts the user needs, not only the option list.
    expect(request.blockingReason).toContain('本次运行没有记录到工具调用');
    expect(request.questions[0]?.prompt).toContain('证据不可恢复');
  });

  it('reports what the run already finished in the escalation facts', async () => {
    const ctx = makeCtx({
      recoveryAttempts: 3,
      maxRecoveryAttempts: 2,
      lastError: { stage: 'execute', message: 'still failing' },
      inbound: textMessage('user', '继续做完'),
    });
    ctx.sideEffects = [
      { idempotencyKey: 'tool:write:a', status: 'succeeded' },
      { idempotencyKey: 'tool:exec:b', status: 'failed' },
    ] as RunContext['sideEffects'];
    ctx.reply = 'draft that was never published';

    await stage(ctx);

    const reason = ctx.clarificationRequest?.blockingReason ?? '';
    expect(reason).toContain('副作用：1 次已成功、1 次已失败、0 次未结算');
    expect(reason).toContain('已有一份未发布的回答草稿');
    // Redacted by construction: identifiers and counts only.
    expect(reason).not.toContain('tool:write:a');
  });
});
