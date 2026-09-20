// @littlesheep/harness — stages/verify.test.ts
// Unit tests for the VERIFY stage after the forced verification model call was
// deleted: narrow structural passes, explicit `unverified` records for
// completed runs, and bounded recovery from recorded failures. No path may
// spend a model request.
import { describe, it, expect } from 'vitest';
import { createVerifyStage } from './verify.js';
import { makeCtx } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';
import type { RunContext, TaskStepFailureKind, ToolResult } from '@littlesheep/types';

const stage = createVerifyStage();

function llmProvenance(ctx: RunContext, purpose: 'execute_tool_loop' | 'execute_final_reply' = 'execute_tool_loop') {
  return {
    version: 1 as const,
    source: 'llm' as const,
    purpose,
    modelRequestId: 'model-request-1',
    modelRequestIndex: 1,
    provider: 'deepseek',
    model: 'deepseek-flash',
    generatedAt: '2026-09-12T00:00:00.000Z',
    rewriteCount: 0,
  };
}

function makeVerifyCtx(opts: {
  reply?: string;
  toolResults?: ToolResult[];
  replanAttempts?: number;
  maxReplanAttempts?: number;
} = {}) {
  const ctx = makeCtx({ inbound: textMessage('user', 'read the file and summarize') });
  ctx.reply = opts.reply ?? 'done';
  ctx.replyProvenance = llmProvenance(ctx);
  ctx.toolResults = opts.toolResults ?? [];
  ctx.plan = [{ description: 'read file' }];
  if (opts.replanAttempts !== undefined) ctx.replanAttempts = opts.replanAttempts;
  if (opts.maxReplanAttempts !== undefined) ctx.maxReplanAttempts = opts.maxReplanAttempts;
  return ctx;
}

function installTaskExecution(
  ctx: RunContext,
  steps: Array<{ id: string; status: 'done' | 'failed' | 'blocked'; failureKind?: TaskStepFailureKind }>,
): void {
  ctx.taskBook = {
    assessment: {
      userNeed: 'read and summarize',
      complexity: 'standard',
      goal: 'read and summarize the file',
      successCriteria: ['summary is accurate'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'read and summarize the file',
    complexity: 'standard',
    successCriteria: ['summary is accurate'],
    steps: [
      { id: 'step-1', description: 'read the file' },
      { id: 'step-2', description: 'summarize the file' },
      { id: 'step-3', description: 'check the summary' },
    ],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
  };
  ctx.taskExecution = {
    goal: ctx.taskBook.goal,
    complexity: 'standard',
    status: steps.some((step) => step.status !== 'done') ? 'failed' : 'done',
    startedAt: '2026-07-10T00:00:00.000Z',
    steps: steps.map((step, index) => ({
      stepId: step.id,
      description: ctx.taskBook!.steps.find((item) => item.id === step.id)?.description ?? step.id,
      status: step.status,
      startedAt: `2026-07-10T00:00:0${index}.000Z`,
      endedAt: `2026-07-10T00:00:0${index + 1}.000Z`,
      output: step.status === 'done' ? `${step.id} output` : undefined,
      error: step.status === 'done' ? undefined : `${step.id} failed`,
      failureKind: step.failureKind,
      attempt: 1,
      toolCallIds: [],
      toolResults: [],
    })),
  };
}

describe('verifyStage', () => {
  it('records an unverified verdict instead of a structural pass for a mixed write and read run', async () => {
    const ctx = makeVerifyCtx({ reply: '游戏文件已经创建并核验。' });
    ctx.streamModelTranscript = true;
    ctx.taskBook = undefined;
    ctx.replyProvenance = llmProvenance(ctx);
    ctx.toolInvocations = ['write', 'grep'].map((toolName, index) => ({
      version: 1 as const,
      id: `invocation-${index}`,
      callId: `call-${index}`,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName,
      toolSource: 'builtin' as const,
      status: 'succeeded' as const,
      proposedAt: `2026-09-12T00:00:0${index}.000Z`,
      endedAt: `2026-09-12T00:00:0${index + 1}.000Z`,
      approval: { required: false, decision: 'not_required' as const },
      evidenceIds: [],
    }));
    ctx.sideEffects = [{
      idempotencyKey: 'write-effect', toolName: 'write', status: 'succeeded', callId: 'call-0',
    }];
    ctx.toolResults = [
      { callId: 'call-0', ok: true, output: 'written' },
      { callId: 'call-1', ok: true, output: 'match' },
    ];

    const res = await stage(ctx);

    // The code can prove the calls succeeded; it cannot prove that an unrelated
    // read satisfies the user's acceptance, so the run is not called verified.
    expect(res).toMatchObject({ next: 'capture', ok: true, meta: { verdict: 'unverified' } });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(ctx.verificationHistory?.at(-1)?.reason).toContain('not verified');
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('lets unresolved Runtime effects override completion and retracts the draft', async () => {
    const ctx = makeVerifyCtx({ reply: 'The file was created successfully.' });
    const replacements: string[] = [];
    ctx.onAssistantReplace = (value) => replacements.push(value);
    ctx.toolInvocations = [{
      version: 1,
      id: 'write-invocation',
      callId: 'write-call',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'write',
      toolSource: 'builtin',
      status: 'succeeded',
      proposedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];
    ctx.toolResults = [{ callId: 'write-call', ok: true, output: 'written' }];
    ctx.sideEffects = [{
      idempotencyKey: 'write-effect',
      toolName: 'write',
      status: 'unknown',
      callId: 'write-call',
    }];

    await expect(stage(ctx)).resolves.toMatchObject({
      next: 'recover',
      ok: false,
      meta: { runtimeEvidenceGap: expect.stringContaining('side effect') },
    });
    expect(ctx.reply).toBeUndefined();
    expect(ctx.replyProvenance).toBeUndefined();
    expect(replacements.at(-1)).toBe('');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
  });

  it('completes a run with complete evidence as unverified and never calls a model', async () => {
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('capture');
    expect(res.ok).toBe(true);
    expect(res.meta?.verdict).toBe('unverified');
    expect(res.meta?.runtimeEvidenceComplete).toBe(true);
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('uses a structural fast path for one successful simple read-only step', async () => {
    const ctx = makeVerifyCtx({ reply: '共有 1 个条目：attachments/' });
    ctx.replyProvenance = {
      version: 1,
      source: 'llm',
      purpose: 'execute_tool_loop',
      modelRequestId: 'model-request-1',
      modelRequestIndex: 1,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      generatedAt: '2026-07-30T00:00:02.000Z',
      rewriteCount: 0,
    };
    ctx.taskBook = {
      assessment: {
        userNeed: '列出顶层条目',
        complexity: 'simple',
        goal: '列出顶层条目',
        successCriteria: ['返回数量和名称'],
        requiresTaskBook: false,
        maxExtraScopeRatio: 1,
      },
      goal: '列出顶层条目',
      complexity: 'simple',
      successCriteria: ['返回数量和名称'],
      steps: [{ id: 'step-1', description: '读取顶层条目', tools: ['glob'] }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: '只返回结果' },
    };
    const toolResult = { callId: 'glob-1', ok: true as const, output: 'attachments/' };
    ctx.taskExecution = {
      goal: ctx.taskBook.goal,
      complexity: 'simple',
      status: 'done',
      startedAt: '2026-07-30T00:00:00.000Z',
      endedAt: '2026-07-30T00:00:02.000Z',
      steps: [{
        stepId: 'step-1',
        description: '读取顶层条目',
        status: 'done',
        startedAt: '2026-07-30T00:00:00.000Z',
        endedAt: '2026-07-30T00:00:02.000Z',
        output: '共有 1 个条目：attachments/',
        toolCallIds: ['glob-1'],
        toolResults: [toolResult],
      }],
    };
    ctx.toolInvocations = [{
      version: 1,
      id: 'invocation-1',
      callId: 'glob-1',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      stepId: 'step-1',
      toolName: 'glob',
      toolSource: 'builtin',
      status: 'succeeded',
      proposedAt: '2026-07-30T00:00:00.000Z',
      endedAt: '2026-07-30T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'capture', ok: true, meta: { runtimeFastPath: true } });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('uses a structural fast path for an exact write then read verification', async () => {
    const marker = 'proof-7319';
    const ctx = makeVerifyCtx({ reply: `proof.txt was verified as ${marker}.` });
    ctx.inbound = textMessage('user', `Write proof.txt with ${marker}, then read it back and report both values.`);
    ctx.replyProvenance = {
      version: 1,
      source: 'llm',
      purpose: 'execute_final_reply',
      modelRequestId: 'model-request-final',
      modelRequestIndex: 1,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      generatedAt: '2026-08-03T00:00:03.000Z',
      rewriteCount: 0,
    };
    ctx.taskBook = {
      assessment: {
        userNeed: 'write and verify proof.txt',
        complexity: 'standard',
        goal: 'write then read proof.txt',
        successCriteria: [`proof.txt contains ${marker}`],
        requiresTaskBook: true,
        maxExtraScopeRatio: 1,
      },
      goal: 'write then read proof.txt',
      complexity: 'standard',
      successCriteria: [`proof.txt contains ${marker}`],
      steps: [{
        id: 'write-proof',
        description: 'write proof.txt',
        tools: ['write'],
        toolProposal: { name: 'write', input: { file_path: 'proof.txt', content: marker } },
      }, {
        id: 'read-proof',
        description: 'read proof.txt',
        tools: ['read'],
        toolProposal: { name: 'read', input: { file_path: 'proof.txt' } },
      }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
    };
    const writeToolResult = { callId: 'write-call', ok: true as const, output: 'Wrote proof.txt' };
    const readToolResult = { callId: 'read-call', ok: true as const, output: marker };
    ctx.taskExecution = {
      goal: ctx.taskBook.goal,
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-08-03T00:00:00.000Z',
      endedAt: '2026-08-03T00:00:02.000Z',
      steps: [{
        stepId: 'write-proof',
        description: 'write proof.txt',
        status: 'done',
        startedAt: '2026-08-03T00:00:00.000Z',
        endedAt: '2026-08-03T00:00:01.000Z',
        output: 'Wrote proof.txt',
        toolCallIds: ['write-call'],
        toolResults: [writeToolResult],
      }, {
        stepId: 'read-proof',
        description: 'read proof.txt',
        status: 'done',
        startedAt: '2026-08-03T00:00:01.000Z',
        endedAt: '2026-08-03T00:00:02.000Z',
        output: marker,
        toolCallIds: ['read-call'],
        toolResults: [readToolResult],
      }],
    };
    ctx.toolInvocations = [{
      version: 1,
      id: 'write-invocation',
      callId: 'write-call',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      stepId: 'write-proof',
      toolName: 'write',
      toolSource: 'builtin',
      status: 'succeeded',
      proposedAt: '2026-08-03T00:00:00.000Z',
      endedAt: '2026-08-03T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }, {
      version: 1,
      id: 'read-invocation',
      callId: 'read-call',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      stepId: 'read-proof',
      toolName: 'read',
      toolSource: 'builtin',
      status: 'succeeded',
      proposedAt: '2026-08-03T00:00:01.000Z',
      endedAt: '2026-08-03T00:00:02.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];
    ctx.sideEffects = [{
      idempotencyKey: 'write-proof-side-effect',
      toolName: 'write',
      status: 'succeeded',
      stepId: 'write-proof',
      callId: 'write-call',
    }];

    const result = await stage(ctx);

    expect(result).toMatchObject({
      next: 'capture',
      ok: true,
      meta: { runtimeFastPath: true, writeReadFastPath: true },
    });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('records a completed task book run as unverified without a model verdict', async () => {
    const ctx = makeVerifyCtx();
    ctx.taskBook = {
      assessment: {
        userNeed: 'review core',
        complexity: 'standard',
        goal: 'find core gaps',
        successCriteria: ['gaps are named'],
        requiresTaskBook: true,
        maxExtraScopeRatio: 1.5,
      },
      goal: 'find core gaps',
      complexity: 'standard',
      successCriteria: ['gaps are named'],
      steps: [{ id: 'step-1', description: 'inspect state machine', acceptanceCriteria: ['state machine inspected'] }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
    };
    ctx.taskExecution = {
      goal: 'find core gaps',
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-07-09T00:00:00.000Z',
      endedAt: '2026-07-09T00:00:01.000Z',
      summary: 'core gaps were named',
      steps: [{
        stepId: 'step-1',
        description: 'inspect state machine',
        status: 'done',
        startedAt: '2026-07-09T00:00:00.000Z',
        endedAt: '2026-07-09T00:00:01.000Z',
        acceptanceCriteria: ['state machine inspected'],
        output: 'state machine inspected',
        toolCallIds: [],
        toolResults: [],
      }],
    };

    const res = await stage(ctx);

    expect(res.next).toBe('capture');
    expect(res.meta?.verdict).toBe('unverified');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(ctx.verificationHistory?.at(-1)?.usedMemoryAtomIds).toBeUndefined();
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('creates a step-scoped partial replan from recorded failed steps', async () => {
    const ctx = makeVerifyCtx({ replanAttempts: 0 });
    installTaskExecution(ctx, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'verification_gap' },
    ]);

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(res.ok).toBe(true);
    expect(ctx.partialReplanRequest).toMatchObject({
      attempt: 1,
      targetStepIds: ['step-2'],
    });
    expect(ctx.replanHistory?.[0]?.preservedStepIds).toEqual(['step-1']);
    expect(ctx.taskExecution?.replanHistory).toEqual(ctx.replanHistory);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'needs_replan', source: 'degraded' });
  });

  it('converts a recoverable not-found failure into partial re-planning', async () => {
    const ctx = makeVerifyCtx();
    installTaskExecution(ctx, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'not_found' },
    ]);

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(res.ok).toBe(true);
    expect(ctx.partialReplanRequest?.targetStepIds).toEqual(['step-2']);
  });

  it('routes a recorded tool failure to recover and sets lastError', async () => {
    const ctx = makeVerifyCtx({
      toolResults: [{ callId: 'c1', ok: false, error: 'file not found' }],
    });
    ctx.toolInvocations = [{
      version: 1,
      id: 'invocation-c1',
      callId: 'c1',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'read',
      toolSource: 'builtin',
      status: 'failed',
      proposedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];

    const res = await stage(ctx);

    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(res.meta?.failedStepIds).toEqual([]);
    expect(ctx.lastError?.stage).toBe('verify');
    expect(ctx.lastError?.message).toContain('c1 is failed');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('replanAttempts exhausted → asks the user instead of claiming success', async () => {
    const ctx = makeVerifyCtx({ replanAttempts: 2, maxReplanAttempts: 2 });
    installTaskExecution(ctx, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'verification_gap' },
    ]);

    const res = await stage(ctx);

    expect(res.next).toBe('ask_user');
    expect(res.ok).toBe(true);
    expect(res.meta?.replanExhausted).toBe(true);
    expect(ctx.clarificationRequest?.sourceStage).toBe('verify');
    expect(ctx.clarificationRequest?.questions[0]?.options).toHaveLength(3);
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('rejects a missing Provider-authored reply as an incomplete execution', async () => {
    const ctx = makeVerifyCtx();
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;

    const res = await stage(ctx);

    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('never spends a model request on any verification path', async () => {
    const complete = makeVerifyCtx();
    await stage(complete);

    const incomplete = makeVerifyCtx();
    installTaskExecution(incomplete, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'tool_error' },
    ]);
    await stage(incomplete);

    expect(complete.modelRequests ?? []).toHaveLength(0);
    expect(incomplete.modelRequests ?? []).toHaveLength(0);
  });
});
