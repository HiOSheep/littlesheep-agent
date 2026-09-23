// CE-04: an ordinary execution failure stays in the main loop.
//
// Before this, any `ok: false` set the forced-final-answer latch, so a single
// missing path or a failing test command ended the turn's ability to act and the
// user had to say "continue". Authoritative boundaries — a permission denial, a
// hard safety rejection, an unknown tool, an outcome the Runtime cannot prove —
// must keep ending it: the model may not probe around them.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import type { RunContext, SideEffectCheckpoint, ToolResult } from '@littlesheep/types';
import { createExecuteStage } from '../execute.js';
import { classifyToolFailure } from './tool-failure-disposition.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from '../../tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

function invocation(
  callId: string,
  status: RunContext['toolInvocations'] extends (infer T)[] | undefined ? T['status'] : never,
  errorKind?: string,
) {
  return {
    version: 1 as const,
    id: `record-${callId}`,
    callId,
    runId: 'run-1',
    sessionId: 'test-session',
    toolName: 'read',
    toolSource: 'builtin',
    status,
    proposedAt: '2026-09-23T00:00:00.000Z',
    approval: { required: false as const, decision: 'not_required' as const },
    evidenceIds: [],
    ...(errorKind ? { errorKind } : {}),
  } as NonNullable<RunContext['toolInvocations']>[number];
}

function failed(callId: string): ToolResult {
  return { callId, ok: false, error: 'Path not found: D:\\work\\missing.md' };
}

function effect(callId: string, status: SideEffectCheckpoint['status']): SideEffectCheckpoint {
  return {
    idempotencyKey: `tool:exec:${callId}`,
    inputHash: 'a'.repeat(64),
    toolName: 'exec',
    callId,
    resourceKeys: [],
    effectKind: 'external',
    status,
    startedAt: '2026-09-23T00:00:00.000Z',
  } as SideEffectCheckpoint;
}

describe('tool failure disposition', () => {
  it('treats a recorded determinate failure as correctable', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('call-1', 'failed')];

    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'correctable',
      reason: 'status_failed',
      effectful: false,
    });
  });

  it('keeps permission, hard-policy, validation and unknown-tool failures authoritative', () => {
    const cases: Array<[NonNullable<RunContext['toolInvocations']>[number]['status'], string]> = [
      ['approval_denied', 'status_approval_denied'],
      ['hard_denied', 'status_hard_denied'],
      ['validation_failed', 'status_validation_failed'],
      ['unknown_tool', 'status_unknown_tool'],
      ['repeated_call_blocked', 'status_repeated_call_blocked'],
      ['aborted', 'status_aborted'],
    ];
    for (const [status, reason] of cases) {
      const ctx = makeCtx({}) as RunContext;
      ctx.toolInvocations = [invocation('call-1', status)];
      expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
        disposition: 'authoritative',
        reason,
      });
    }
  });

  it('keeps a declared boundary error kind authoritative even when the status is failed', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('call-1', 'failed', 'side_effect_replay')];

    // CE-06: a replay refusal is final for the call but not for the run. Nothing
    // executed and nothing is unknown, so the model may observe with a structured
    // tool instead of the turn ending here.
    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'correctable',
      reason: 'side_effect_replay',
      effectful: true,
    });
  });

  it('stops on the host-level read-only protection of the core source', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('call-1', 'failed', 'core_source_read_only')];

    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'authoritative',
      reason: 'core_source_read_only',
    });
  });

  it('stops on a repeated-call guard that is not a replay refusal', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('call-1', 'repeated_call_blocked', 'repeated_call')];

    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'authoritative',
      reason: 'repeated_call',
    });
  });

  it('keeps an unresolvable side effect authoritative and reports it as effectful', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('call-1', 'failed')];
    ctx.sideEffects = [effect('call-1', 'unknown')];

    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'authoritative',
      reason: 'unsettled_effect_unknown',
      effectful: true,
    });
  });

  it('keeps a settled effectful failure correctable but marks it effectful', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('call-1', 'failed')];
    ctx.sideEffects = [effect('call-1', 'failed')];

    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'correctable',
      effectful: true,
    });
  });

  it('stays authoritative when no invocation record exists', () => {
    const ctx = makeCtx({}) as RunContext;

    expect(classifyToolFailure(ctx, failed('call-1'))).toMatchObject({
      disposition: 'authoritative',
      reason: 'no_invocation_record',
    });
  });
});

describe('the main loop after a failed call', () => {
  it('lets the model correct a missing path in the same run and still deliver', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        return toolCallResponse([{ id: 'read-missing', name: 'read', args: { file_path: 'notes.md' } }]);
      }
      if (turn === 2) return toolCallResponse([{ id: 'list-dir', name: 'glob', args: { pattern: '*' } }]);
      return textResponse('notes.md is missing; here is what the directory holds instead.');
    });
    const read = makeTool('read', { ok: false, error: 'Path not found: notes.md' });
    const glob = makeTool('glob', { ok: true, output: 'notes-draft.md' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [read, glob], inbound: textMessage('user', 'summarize notes.md') });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    // Both calls ran: the failure did not close the loop, so the model observed
    // the directory in the same run instead of asking the user to say "continue".
    expect(read.calls).toHaveLength(1);
    expect(glob.calls).toHaveLength(1);
    expect(llm.chat).toHaveBeenCalledTimes(3);
    // The failed result is still in the record, and the answer is published.
    expect(ctx.toolResults?.some((entry) => entry.ok === false)).toBe(true);
    expect(ctx.reply).toBe('notes.md is missing; here is what the directory holds instead.');
  });

  it('still ends the run when the boundary refuses a call', async () => {
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      const refused = request.messages.some((message) => typeof message.content === 'string'
        && message.content.includes('Do not call another tool in this step'));
      if (refused) return textResponse('the write was refused by the runtime policy');
      return toolCallResponse([{ id: 'write-core', name: 'write', args: { file_path: 'x.md' } }]);
    });
    const write = makeTool('write', { ok: true, output: 'written' }, { requiresApproval: true });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [write], inbound: textMessage('user', 'write into the core source') });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    // The refusal is authoritative: one more answer, then the run stops. The tool
    // never ran, because the approval boundary refused it before invocation.
    expect(write.calls).toHaveLength(0);
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Do not call another tool in this step'),
      }),
    ]));
  });

  it('tells the model a failed effectful call may already have changed the workspace', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      if (turn === 1) return toolCallResponse([{ id: 'exec-1', name: 'exec', args: { command: 'node build.js' } }]);
      return textResponse('the build failed; I inspected the output directory first');
    });
    const exec = makeTool('exec', { ok: false, error: 'exit code 1' });
    exec.execution = { concurrency: 'exclusive', resources: () => [{ key: 'external:process', mode: 'write' }] };
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [exec], inbound: textMessage('user', 'run the build') });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('may already have changed the workspace'),
      }),
    ]));
    // The runtime does not replay it: exactly one invocation was attempted.
    expect(exec.calls).toHaveLength(1);
  });

  it('bounds a model that repeats the same failing observation', async () => {
    const llm = createMockLlm(() => toolCallResponse([{ id: `read-${Math.random()}`, name: 'read', args: { file_path: 'notes.md' } }]));
    const read = makeTool('read', { ok: false, error: 'Path not found: notes.md' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [read], inbound: textMessage('user', 'read notes.md') });

    await stage(ctx);

    // A repeated identical failure adds no evidence, so the no-progress bound
    // ends the loop instead of letting the model retry forever: three executions
    // (the first counts as new evidence), then the withheld rounds.
    expect(read.calls).toHaveLength(3);
    expect(llm.chat).toHaveBeenCalledTimes(6);
  });
});
