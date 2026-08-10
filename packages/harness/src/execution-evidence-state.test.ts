import { describe, expect, it } from 'vitest';
import type { RunContext, ToolInvocationRecord } from '@littlesheep/types';
import {
  replaceSideEffectEvidence,
  replaceToolResults,
  upsertToolInvocationEvidence,
  writeExecutionEvidenceState,
} from './execution-evidence-state.js';

function makeContext(): RunContext {
  return {
    runId: 'run-execution-evidence',
    sessionId: 'session-execution-evidence' as RunContext['sessionId'],
    inbound: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: '2026-08-10T00:00:00.000Z' },
    cwd: 'C:\\workspace',
    model: 'test-model',
    tools: [],
    toolContext: { sessionId: 'session-execution-evidence' as RunContext['sessionId'], runId: 'run-execution-evidence', cwd: 'C:\\workspace' },
    history: [],
    produced: [],
    maxRecoveryAttempts: 2,
    startedAt: '2026-08-10T00:00:00.000Z',
  };
}

function invocation(status: ToolInvocationRecord['status']): ToolInvocationRecord {
  return {
    version: 1,
    id: 'invocation-1',
    callId: 'call-1',
    runId: 'run-execution-evidence',
    sessionId: 'session-execution-evidence' as RunContext['sessionId'],
    toolName: 'read',
    toolSource: 'builtin',
    inputHash: 'hash',
    status,
    proposedAt: '2026-08-10T00:00:00.000Z',
    startedAt: '2026-08-10T00:00:00.000Z',
    approval: { required: false, decision: 'not_required' },
    evidenceIds: [],
  };
}

describe('execution evidence state boundary', () => {
  it('rejects a forbidden batch before mutating any field', () => {
    const ctx = makeContext();
    ctx.toolResults = [{ callId: 'old', ok: true, output: 'old' }];

    expect(() => writeExecutionEvidenceState(ctx, 'verify', {
      toolResults: [{ callId: 'new', ok: true, output: 'new' }],
      toolInvocationsTruncated: true,
    })).toThrow(/cannot be written during 'verify'/);
    expect(ctx.toolResults[0]?.callId).toBe('old');
    expect(ctx.toolInvocationsTruncated).toBeUndefined();
  });

  it('replaces results and upserts invocation records without mutating prior arrays', () => {
    const ctx = makeContext();
    replaceToolResults(ctx, 'execute', [{ callId: 'call-1', ok: true, output: 'done' }]);
    upsertToolInvocationEvidence(ctx, 'execute', invocation('running'), { retained: true, truncated: false });
    const firstRecords = ctx.toolInvocations;
    upsertToolInvocationEvidence(ctx, 'execute', invocation('succeeded'), { retained: true, truncated: true });

    expect(ctx.toolResults).toEqual([{ callId: 'call-1', ok: true, output: 'done' }]);
    expect(ctx.toolInvocations).toHaveLength(1);
    expect(ctx.toolInvocations?.[0]?.status).toBe('succeeded');
    expect(ctx.toolInvocations).not.toBe(firstRecords);
    expect(ctx.toolInvocationsTruncated).toBe(true);
  });

  it('detaches restored side-effect records from checkpoint input', () => {
    const ctx = makeContext();
    const sideEffects = [{
      idempotencyKey: 'effect-1',
      toolName: 'write',
      status: 'succeeded' as const,
      resourceKeys: ['workspace:file'],
    }];
    replaceSideEffectEvidence(ctx, 'runner-restore', sideEffects);
    sideEffects[0]!.resourceKeys.push('later');

    expect(ctx.sideEffects?.[0]?.resourceKeys).toEqual(['workspace:file']);
  });
});
