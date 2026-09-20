import { describe, expect, it } from 'vitest';
import type { RunContext } from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import { makeCtx } from '../../tests/helpers.js';
import { verifyDeterministicWriteReadExecution } from './routing.js';

const MARKER = 'proof-7319';

describe('deterministic write-read verification', () => {
  it('keeps the exact builtin write-read proof as the narrow structural positive path', async () => {
    const result = await verifyDeterministicWriteReadExecution(writeReadContext());
    expect(result).toMatchObject({
      next: 'finalize',
      ok: true,
      meta: { runtimeFastPath: true, writeReadFastPath: true },
    });
  });

  it.each([
    ['wrong read path', (ctx: RunContext) => {
      ctx.taskBook!.steps[1]!.toolProposal!.input = { file_path: 'other.txt' };
    }],
    ['wrong read content', (ctx: RunContext) => {
      ctx.taskExecution!.steps[1]!.toolResults[0]!.output = 'different';
    }],
    ['plugin tool impersonating builtin read', (ctx: RunContext) => {
      ctx.toolInvocations![1]!.toolSource = 'plugin';
    }],
    ['unrelated effect call id', (ctx: RunContext) => {
      ctx.sideEffects![0]!.callId = 'unrelated-call';
    }],
  ] as const)('HA-02-02 rejects %s', async (_label, mutate) => {
    const ctx = writeReadContext();
    mutate(ctx);
    await expect(verifyDeterministicWriteReadExecution(ctx)).resolves.toBeUndefined();
    expect(ctx.verificationHistory).toBeUndefined();
  });

  it.each([
    ['a second unverified file', (ctx: RunContext) => {
      ctx.taskBook!.steps.push({
        id: 'write-extra',
        description: 'write extra.txt',
        tools: ['write'],
        toolProposal: { name: 'write', input: { file_path: 'extra.txt', content: 'extra' } },
      });
    }],
    ['read before write', (ctx: RunContext) => {
      ctx.taskBook!.steps.reverse();
      ctx.taskExecution!.steps.reverse();
    }],
    ['truncated invocation evidence', (ctx: RunContext) => {
      ctx.toolInvocations![1]!.outputTruncated = true;
    }],
    ['sanitized read output', (ctx: RunContext) => {
      ctx.taskExecution!.steps[1]!.toolResults[0]!.sanitized = true;
    }],
  ] as const)('HA-02-03 rejects %s', async (_label, mutate) => {
    const ctx = writeReadContext();
    mutate(ctx);
    await expect(verifyDeterministicWriteReadExecution(ctx)).resolves.toBeUndefined();
    expect(ctx.verificationHistory).toBeUndefined();
  });
});

function writeReadContext(): RunContext {
  const ctx = makeCtx({
    inbound: textMessage('user', `Write proof.txt with ${MARKER}, then read it back and report both values.`),
  });
  ctx.reply = `proof.txt was verified as ${MARKER}.`;
  ctx.replyProvenance = {
    version: 1,
    source: 'llm',
    purpose: 'execute_final_reply',
    modelRequestId: 'model-request-final',
    modelRequestIndex: 1,
    provider: 'deepseek',
    model: 'deepseek-flash',
    generatedAt: '2026-09-12T00:00:03.000Z',
    rewriteCount: 0,
  };
  ctx.taskBook = {
    assessment: {
      userNeed: 'write and verify proof.txt',
      complexity: 'standard',
      goal: 'write then read proof.txt',
      successCriteria: [`proof.txt contains ${MARKER}`],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1,
    },
    goal: 'write then read proof.txt',
    complexity: 'standard',
    successCriteria: [`proof.txt contains ${MARKER}`],
    steps: [{
      id: 'write-proof',
      description: 'write proof.txt',
      tools: ['write'],
      toolProposal: { name: 'write', input: { file_path: 'proof.txt', content: MARKER } },
    }, {
      id: 'read-proof',
      description: 'read proof.txt',
      tools: ['read'],
      toolProposal: { name: 'read', input: { file_path: 'proof.txt' } },
    }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
  };
  const writeToolResult = { callId: 'write-call', ok: true as const, output: 'Wrote proof.txt' };
  const readToolResult = { callId: 'read-call', ok: true as const, output: MARKER };
  ctx.taskExecution = {
    goal: ctx.taskBook.goal,
    complexity: 'standard',
    status: 'done',
    startedAt: '2026-09-12T00:00:00.000Z',
    endedAt: '2026-09-12T00:00:02.000Z',
    steps: [{
      stepId: 'write-proof',
      description: 'write proof.txt',
      status: 'done',
      startedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      output: 'Wrote proof.txt',
      toolCallIds: ['write-call'],
      toolResults: [writeToolResult],
    }, {
      stepId: 'read-proof',
      description: 'read proof.txt',
      status: 'done',
      startedAt: '2026-09-12T00:00:01.000Z',
      endedAt: '2026-09-12T00:00:02.000Z',
      output: MARKER,
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
    proposedAt: '2026-09-12T00:00:00.000Z',
    endedAt: '2026-09-12T00:00:01.000Z',
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
    proposedAt: '2026-09-12T00:00:01.000Z',
    endedAt: '2026-09-12T00:00:02.000Z',
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
  return ctx;
}
