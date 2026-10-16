import { describe, expect, it } from 'vitest';
import { textMessage, type RunContext, type ToolInvocationRecord, type ToolResult } from '@littlesheep/types';
import { makeCtx } from '../../tests/helpers.js';
import {
  assessRuntimeEvidence,
  recordRuntimeEvidenceSettlement,
} from './evidence-settlement.js';

const FIXED_TIME = '2026-10-16T00:00:00.000Z';

function context(): RunContext {
  const replyProvenance = {
    version: 1 as const,
    source: 'llm' as const,
    purpose: 'execute_tool_loop' as const,
    modelRequestId: 'request-1',
    modelRequestIndex: 1,
    provider: 'test-provider',
    model: 'test-model',
    generatedAt: FIXED_TIME,
    rewriteCount: 0,
  };
  return makeCtx({
    inbound: textMessage('user', 'Complete the requested task.'),
    reply: 'The available evidence is summarized.',
    replyProvenance,
  });
}

function invocation(
  ctx: RunContext,
  callId: string,
  toolName = 'read',
  status: ToolInvocationRecord['status'] = 'succeeded',
  extra: Partial<ToolInvocationRecord> = {},
): ToolInvocationRecord {
  return {
    version: 1,
    id: `invocation-${callId}`,
    callId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    toolName,
    toolSource: 'builtin',
    status,
    proposedAt: FIXED_TIME,
    ...(status === 'running' ? {} : { endedAt: FIXED_TIME }),
    approval: { required: false, decision: 'not_required' },
    evidenceIds: [],
    ...extra,
  };
}

function addCall(ctx: RunContext, callId: string, toolName = 'read'): void {
  ctx.produced.push({
    id: `message-${callId}`,
    role: 'assistant',
    content: [{ type: 'tool_calls', calls: [{ id: callId, name: toolName, input: { path: 'proof.txt' } }] }],
    timestamp: FIXED_TIME,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

function addResult(ctx: RunContext, result: ToolResult): void {
  ctx.toolResults = [...(ctx.toolResults ?? []), result];
  ctx.produced.push({
    id: `result-${result.callId}`,
    role: 'tool',
    content: [{ type: 'tool_result', result }],
    timestamp: FIXED_TIME,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

function completeCall(
  ctx: RunContext,
  callId = 'call-1',
  options: {
    toolName?: string;
    status?: ToolInvocationRecord['status'];
    resultOk?: boolean;
    invocation?: Partial<ToolInvocationRecord>;
  } = {},
): void {
  const toolName = options.toolName ?? 'read';
  const status = options.status ?? (options.resultOk === false ? 'failed' : 'succeeded');
  addCall(ctx, callId, toolName);
  ctx.toolInvocations = [
    ...(ctx.toolInvocations ?? []),
    invocation(ctx, callId, toolName, status, options.invocation),
  ];
  const ok = options.resultOk ?? status === 'succeeded';
  addResult(ctx, { callId, ok, ...(ok ? { output: 'proof content' } : { error: 'tool failed' }) });
}

describe('Runtime execution evidence settlement', () => {
  it('accepts a no-tool response only when its Provider reply provenance matches a recorded request', () => {
    const ctx = context();
    expect(assessRuntimeEvidence(ctx, { requireReply: true })).toEqual({ kind: 'complete', knownFailures: [] });

    ctx.replyProvenance = undefined;
    expect(assessRuntimeEvidence(ctx, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'no Provider-authored reply is available',
    });
  });

  it('requires every recorded tool call to have exactly one Runtime invocation and result', () => {
    const missingInvocation = context();
    addCall(missingInvocation, 'call-1');
    addResult(missingInvocation, { callId: 'call-1', ok: true, output: 'proof content' });
    expect(assessRuntimeEvidence(missingInvocation, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'recorded tool call call-1 does not have exactly one invocation record',
    });

    const missingResult = context();
    addCall(missingResult, 'call-2');
    missingResult.toolInvocations = [invocation(missingResult, 'call-2')];
    expect(assessRuntimeEvidence(missingResult, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'tool result call-2 is missing',
    });

    const duplicateCall = context();
    addCall(duplicateCall, 'call-3');
    addCall(duplicateCall, 'call-3');
    duplicateCall.toolInvocations = [invocation(duplicateCall, 'call-3')];
    addResult(duplicateCall, { callId: 'call-3', ok: true, output: 'proof content' });
    expect(assessRuntimeEvidence(duplicateCall, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'recorded tool call identity call-3 is duplicated or missing',
    });
  });

  it('rejects duplicate identities, nonterminal calls, truncation, and invocation/result disagreement', () => {
    const duplicateInvocation = context();
    completeCall(duplicateInvocation);
    duplicateInvocation.toolInvocations!.push(invocation(duplicateInvocation, 'call-1'));
    expect(assessRuntimeEvidence(duplicateInvocation, { requireReply: true }).kind).toBe('gap');

    const nonterminal = context();
    completeCall(nonterminal, 'call-2', { status: 'running', resultOk: false });
    expect(assessRuntimeEvidence(nonterminal, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'tool invocation call-2 has not reached a terminal status',
    });

    const truncated = context();
    completeCall(truncated, 'call-3', { invocation: { outputTruncated: true } });
    expect(assessRuntimeEvidence(truncated, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'tool invocation call-3 output is truncated',
    });

    const disagreement = context();
    completeCall(disagreement, 'call-4', { status: 'failed', resultOk: true });
    expect(assessRuntimeEvidence(disagreement, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'tool invocation call-4 did not succeed but its result succeeded',
    });
  });

  it('treats permission outcomes and unknown effects as gaps, not successful completion', () => {
    const denied = context();
    completeCall(denied, 'call-denied', { status: 'approval_denied', resultOk: false });
    expect(assessRuntimeEvidence(denied, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'tool invocation call-denied is approval_denied',
    });

    const unknownEffect = context();
    completeCall(unknownEffect, 'call-effect', { toolName: 'write' });
    unknownEffect.sideEffects = [{
      idempotencyKey: 'tool:write:unknown',
      inputHash: 'a'.repeat(64),
      toolName: 'write',
      callId: 'call-effect',
      resourceKeys: [],
      effectKind: 'local_mutation',
      status: 'unknown',
      startedAt: FIXED_TIME,
    }];
    expect(assessRuntimeEvidence(unknownEffect, { requireReply: true })).toMatchObject({
      kind: 'gap',
      reason: 'side effect tool:write:unknown is unknown',
    });
  });

  it('preserves a known negative execution result without treating it as an evidence gap', () => {
    const ctx = context();
    completeCall(ctx, 'call-failed', { status: 'failed', resultOk: false });

    expect(assessRuntimeEvidence(ctx, { requireReply: true })).toEqual({
      kind: 'complete',
      knownFailures: ['tool invocation call-failed is failed'],
    });
  });

  it('records complete execution evidence as unverified, never as task acceptance', async () => {
    const ctx = context();
    completeCall(ctx);
    const events: unknown[] = [];
    ctx.appendDurableEvent = async (event) => { events.push(event); };

    const record = await recordRuntimeEvidenceSettlement(
      ctx,
      assessRuntimeEvidence(ctx, { requireReply: true }),
    );

    expect(record).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(record.reason).toContain('does not establish that the user task objective is complete');
    expect(ctx.verificationHistory).toEqual([record]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'verification_recorded', payload: { verdict: 'unverified' } });
  });
});
