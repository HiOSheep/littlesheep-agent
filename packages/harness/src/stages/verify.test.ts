// @littlesheep/harness — stages/verify.test.ts
// Unit tests for the VERIFY stage: verdict routing, bounded replan,
// optimistic degradation, and feedback propagation.

import { describe, it, expect } from 'vitest';
import { createVerifyStage } from './verify.js';
import {
  createMockLlm,
  textResponse,
  makeCtx,
} from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';
import type { RunContext, TaskStepFailureKind, ToolResult } from '@littlesheep/types';

const deps = { model: 'test' } as const;

function makeVerifyCtx(opts: {
  reply?: string;
  toolResults?: ToolResult[];
  replanAttempts?: number;
  maxReplanAttempts?: number;
} = {}) {
  const ctx = makeCtx({ inbound: textMessage('user', 'read the file and summarize') });
  ctx.reply = opts.reply ?? 'done';
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
  it('pass → evolve', async () => {
    const llm = createMockLlm(textResponse('{"verdict":"pass","reason":"goal achieved"}'));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('evolve');
    expect(res.ok).toBe(true);
    expect(res.meta?.verdict).toBe('pass');
    expect(ctx.modelRequests?.map((request) => request.stage)).toEqual(['verify']);
  });

  it('uses a structural fast path for one successful simple read-only step', async () => {
    const llm = createMockLlm(textResponse('{"verdict":"fail","reason":"should not run"}'));
    const stage = createVerifyStage({ ...deps, llm });
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

    expect(result).toMatchObject({ next: 'evolve', ok: true, meta: { runtimeFastPath: true } });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('uses a structural fast path for an exact write then read verification', async () => {
    const marker = 'proof-7319';
    const llm = createMockLlm(textResponse('{"verdict":"fail","reason":"should not run"}'));
    const stage = createVerifyStage({ ...deps, llm });
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
      next: 'evolve',
      ok: true,
      meta: { runtimeFastPath: true, writeReadFastPath: true },
    });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('accepts only active adopted atoms as explicit verification usage evidence', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      verdict: 'pass',
      reason: 'goal achieved with memory evidence',
      usedMemoryAtomIds: ['atom-used', 'atom-excluded', 'atom-inactive', 'atom-used'],
    })));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();
    const envelope = {
      atomRevision: 1,
      branch: 'project',
      scope: 'project',
      tier: 2,
      disclosureLevel: 'D2' as const,
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'project', topics: ['test'] },
      assertedBy: { kind: 'tool', id: 'test' },
      sourceRefs: [],
      evidenceRefs: ['verify:test'],
      confidence: 1,
      importance: 1,
      taskRelevance: 1,
      updatedAt: '2026-07-16T06:00:00.000Z',
      retrievalPath: 'hierarchy' as const,
      matchReason: 'test match',
      conflict: false,
      expired: false,
      truncated: false,
    };
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-16T06:00:00.000Z',
      references: [
        knownStateReference('atom-used', 'adopted', envelope),
        knownStateReference('atom-excluded', 'excluded', envelope),
        knownStateReference('atom-inactive', 'adopted', envelope),
      ],
    };
    ctx.memoryContextWorkingSet = {
      revision: 1,
      activeAtomIds: ['atom-used', 'atom-excluded'],
      releasedAtomIds: ['atom-inactive'],
      activeCallByAtom: { 'atom-used': 'initial', 'atom-excluded': 'initial' },
      callAtomIds: { initial: ['atom-used', 'atom-excluded'] },
      updatedAt: '2026-07-16T06:00:00.000Z',
    };

    await stage(ctx);

    expect(ctx.verificationHistory?.at(-1)?.usedMemoryAtomIds).toEqual(['atom-used']);
  });

  it('includes the active behavior profile in the verification system prompt', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      systemPrompts.push(String(request.messages[0]?.content ?? ''));
      return textResponse('{"verdict":"pass","reason":"goal achieved"}');
    });
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();
    ctx.profilePromptAddon = 'PROFILE_SENTINEL_VERIFY';
    ctx.bootstrap = { 'SOUL.md': 'SOUL_SENTINEL_VERIFY_VOICE' };

    await stage(ctx);

    expect(systemPrompts[0]).toContain('PROFILE_SENTINEL_VERIFY');
    expect(systemPrompts[0]).toContain('SOUL_SENTINEL_VERIFY_VOICE');
  });

  it('verifies against taskBook success criteria when present', async () => {
    const userPrompts: string[] = [];
    const llm = createMockLlm((req) => {
      userPrompts.push(String(req.messages[1]?.content ?? ''));
      return textResponse('{"verdict":"pass","reason":"criteria satisfied"}');
    });
    const stage = createVerifyStage({ ...deps, llm });
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

    expect(res.next).toBe('evolve');
    expect(userPrompts[0]).toContain('Task book');
    expect(userPrompts[0]).toContain('Goal: find core gaps');
    expect(userPrompts[0]).toContain('gaps are named');
    expect(userPrompts[0]).toContain('state machine inspected');
    expect(userPrompts[0]).toContain('Step execution results');
    expect(userPrompts[0]).toContain('Status: done');
  });

  it('needs_replan → decide, increments replanAttempts, sets verifyFeedback', async () => {
    const llm = createMockLlm(
      textResponse('{"verdict":"needs_replan","reason":"incomplete","feedback":"try a different file path"}'),
    );
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx({ replanAttempts: 0 });

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(res.ok).toBe(true);
    expect(res.meta?.verdict).toBe('needs_replan');
    expect(ctx.replanAttempts).toBe(1);
    expect(ctx.verifyFeedback).toBe('try a different file path');
  });

  it('creates a step-scoped partial replan and preserves completed evidence', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      verdict: 'needs_replan',
      reason: 'summary is incomplete',
      feedback: 'rewrite the summary using the file evidence',
      failedStepIds: ['step-2'],
    })));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx({ replanAttempts: 0 });
    installTaskExecution(ctx, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'verification_gap' },
    ]);

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(ctx.partialReplanRequest).toMatchObject({
      attempt: 1,
      targetStepIds: ['step-2'],
      reason: 'summary is incomplete',
    });
    expect(ctx.replanHistory?.[0]?.preservedStepIds).toEqual(['step-1']);
    expect(ctx.taskExecution?.replanHistory).toEqual(ctx.replanHistory);
  });

  it('converts a recoverable not-found failure into partial re-planning', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      verdict: 'fail',
      reason: 'the selected path does not exist',
      feedback: 'locate the correct path',
      failedStepIds: ['step-2'],
    })));
    const stage = createVerifyStage({ ...deps, llm });
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

  it('fail → recover, sets lastError', async () => {
    const llm = createMockLlm(
      textResponse('{"verdict":"fail","reason":"tool returned error"}'),
    );
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx({
      toolResults: [{ callId: 'c1', ok: false, error: 'file not found' }],
    });

    const res = await stage(ctx);

    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(res.meta?.verdict).toBe('fail');
    expect(ctx.lastError?.stage).toBe('verify');
    expect(ctx.lastError?.message).toContain('tool returned error');
  });

  it('replanAttempts exhausted → asks the user instead of claiming success', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      verdict: 'needs_replan',
      reason: 'still incomplete',
      failedStepIds: ['step-2'],
    })));
    const stage = createVerifyStage({ ...deps, llm });
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
    expect(llm.chat).toHaveBeenCalled();
  });

  it('LLM transport error → optimistic degrade to pass', async () => {
    const llm = createMockLlm(textResponse(''));
    llm.chat.mockRejectedValueOnce(new Error('network down'));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('evolve');
    expect(res.ok).toBe(true);
    expect(res.meta?.degradedPass).toBe(true);
    expect(res.meta?.transportError).toBe('network down');
  });

  it('LLM transport error with known failed steps → partial replan, not pass', async () => {
    const llm = createMockLlm(textResponse(''));
    llm.chat.mockRejectedValueOnce(new Error('network down'));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();
    installTaskExecution(ctx, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'not_found' },
    ]);

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(res.meta?.degradedReplan).toBe(true);
    expect(ctx.partialReplanRequest?.targetStepIds).toEqual(['step-2', 'step-3']);
  });

  it('JSON parse failure → optimistic degrade to pass', async () => {
    const llm = createMockLlm(textResponse('this is not json at all'));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('evolve');
    expect(res.ok).toBe(true);
    expect(res.meta?.degradedPass).toBe(true);
  });

  it('invalid verdict value → optimistic degrade to pass', async () => {
    const llm = createMockLlm(textResponse('{"verdict":"maybe","reason":"unsure"}'));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('evolve');
    expect(res.ok).toBe(true);
    expect(res.meta?.degradedPass).toBe(true);
  });

  it('overrides an impossible pass when step evidence is incomplete', async () => {
    const llm = createMockLlm(textResponse('{"verdict":"pass","reason":"looks fine"}'));
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();
    installTaskExecution(ctx, [
      { id: 'step-1', status: 'done' },
      { id: 'step-2', status: 'failed', failureKind: 'verification_gap' },
    ]);

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(res.meta?.structuralOverride).toBe(true);
    expect(ctx.partialReplanRequest?.targetStepIds).toEqual(['step-2', 'step-3']);
  });

  it('needs_replan without feedback → falls back to reason as feedback', async () => {
    const llm = createMockLlm(
      textResponse('{"verdict":"needs_replan","reason":"output was empty"}'),
    );
    const stage = createVerifyStage({ ...deps, llm });
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('decide');
    expect(ctx.verifyFeedback).toBe('output was empty');
  });
});

function knownStateReference(
  atomId: string,
  decision: 'adopted' | 'excluded',
  envelope: Omit<NonNullable<RunContext['memoryKnownState']>['references'][number]['envelope'], 'atomId'>,
) {
  return {
    atomId,
    atomRevision: 1,
    sourceRefs: [],
    evidenceRefs: ['verify:test'],
    decision,
    reason: 'test reference',
    envelope: { ...envelope, atomId },
    stages: ['expand'],
    firstSeenAt: '2026-07-16T06:00:00.000Z',
    updatedAt: '2026-07-16T06:00:00.000Z',
    reactivatedCount: 0,
  };
}
