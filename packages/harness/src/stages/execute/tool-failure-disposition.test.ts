// CE-04: an ordinary execution failure stays in the main loop.
//
// Before this, any `ok: false` set the forced-final-answer latch, so a single
// missing path or a failing test command ended the turn's ability to act and the
// user had to say "continue". Authoritative boundaries — a permission denial, a
// hard safety rejection, an unknown tool, an outcome the Runtime cannot prove —
// must keep ending it: the model may not probe around them.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import type { RunContext, SideEffectCheckpoint, ToolResult } from '@littlesheep/types';
import { createExecuteStage } from '../execute.js';
import { classifyToolFailure } from './tool-failure-disposition.js';
import { notAdmittedResult } from './tool-result-persistence.js';
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

  it('allows only a trusted pre-execution Schema validation record to be corrected', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('schema-call', 'validation_failed', 'input_validation')];
    expect(classifyToolFailure(ctx, { ...failed('schema-call'), meta: { errorKind: 'input_validation' } })).toMatchObject({
      disposition: 'correctable', reason: 'runtime_input_validation', effectful: false,
    });
  });

  it('does not trust result metadata or tool error text to relabel a parallel-contract refusal as Schema input', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('denied-call', 'validation_failed', 'parallel_step_contract')];
    expect(classifyToolFailure(ctx, { ...failed('denied-call'), meta: { errorKind: 'input_validation' } })).toMatchObject({
      disposition: 'authoritative', reason: 'status_validation_failed',
    });
  });

  it('keeps an input validation status authoritative if any side-effect record exists', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [invocation('schema-call', 'validation_failed', 'input_validation')];
    ctx.sideEffects = [effect('schema-call', 'unknown')];
    expect(classifyToolFailure(ctx, { ...failed('schema-call'), meta: { errorKind: 'input_validation' } })).toMatchObject({
      disposition: 'authoritative', reason: 'status_validation_failed', effectful: true,
    });
  });

  it('does not treat an invocation with execution lifecycle timestamps as a pre-execution schema rejection', () => {
    const ctx = makeCtx({}) as RunContext;
    ctx.toolInvocations = [{
      ...invocation('schema-call', 'validation_failed', 'input_validation'),
      startedAt: '2026-09-23T00:00:01.000Z',
    }];
    expect(classifyToolFailure(ctx, { ...failed('schema-call'), meta: { errorKind: 'input_validation' } })).toMatchObject({
      disposition: 'authoritative', reason: 'status_validation_failed', effectful: false,
    });
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

  // A capability the Runtime withheld has no invocation record either, but it is a
  // scope decision the model can correct. Measured on the parallel-load gate: an
  // opening `use_skill` call on a request restricted to `write`/`read` disabled
  // every tool, and the task's file was never written.
  it('treats a declared scope refusal as correctable despite the missing record', () => {
    const ctx = makeCtx({}) as RunContext;

    expect(classifyToolFailure(ctx, notAdmittedResult(
      'call-1',
      'step-1',
      'Runtime scope: use write or read for this request.',
    ))).toMatchObject({
      disposition: 'correctable',
      reason: 'tool_not_admitted',
      effectful: false,
    });
  });
});

describe('the main loop after a failed call', () => {
  it.each([
    ['wrong field name', { filePath: 'target.txt', content: 'corrected' }],
    ['wrong field type', { path: 42, content: 'corrected' }],
    ['missing required field', { path: 'target.txt' }],
  ])('returns structured trusted Schema feedback and runs a corrected call after %s', async (_label, invalidInput) => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s1a-schema-'));
    try {
      const target = join(root, 'target.txt');
      let turn = 0;
      const requests: ChatRequest[] = [];
      const llm = createMockLlm((request) => {
        requests.push(request);
        turn += 1;
        if (turn === 1) return toolCallResponse([{ id: 'invalid-schema', name: 'fixture_write', args: invalidInput as Record<string, unknown> }]);
        if (turn === 2) return toolCallResponse([{ id: 'corrected-schema', name: 'fixture_write', args: { path: 'target.txt', content: 'corrected' } }]);
        return textResponse('The corrected fixture file is present.');
      });
      const write = makeTool('fixture_write', { ok: true, output: 'written' }, {
        inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
      });
      let effects = 0;
      write.execute = async (input) => {
        effects += 1;
        const args = input as { path: string; content: string };
        if (args.path !== 'target.txt') throw new Error('fixture path escaped its contract');
        await writeFile(target, args.content, 'utf8');
        return { callId: '', ok: true, output: 'written' };
      };
      const stage = createExecuteStage({ ...deps, llm });
      const ctx = makeCtx({
        tools: [write],
        inbound: textMessage('user', 'Write target.txt with the requested fixture content.'),
        toolContext: { cwd: root, workspaceRoot: root },
      });

      const result = await stage(ctx);

      expect(result).toMatchObject({ ok: true, next: 'finalize' });
      expect(effects).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('corrected');
      expect(ctx.toolInvocations?.map((record) => record.status)).toEqual(['validation_failed', 'succeeded']);
      expect(ctx.toolInvocations?.[0]).toMatchObject({ errorKind: 'input_validation' });
      const validationFeedback = JSON.stringify(requests[1]?.messages.filter((message) => message.role === 'tool'));
      expect(validationFeedback).toContain('runtime_schema');
      expect(validationFeedback).toContain('invalid_type');
      expect(validationFeedback).not.toContain('"received":42');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds repeated invalid Schema proposals without executing the tool', async () => {
    const llm = createMockLlm(() => toolCallResponse([{ id: `invalid-${Math.random()}`, name: 'fixture_write', args: { path: 42, content: 'never written' } }]));
    const write = makeTool('fixture_write', { ok: true, output: 'written' }, {
      inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [write], inbound: textMessage('user', 'Write the fixture file.') });

    await stage(ctx);

    expect(write.calls).toHaveLength(0);
    expect(ctx.toolInvocations?.filter((record) => record.errorKind === 'input_validation').length).toBeGreaterThan(0);
    expect(llm.chat.mock.calls.length).toBeLessThanOrEqual(6);
    expect(ctx.toolInvocations?.every((record) => record.status === 'validation_failed')).toBe(true);
  });

  it('does not dispatch the corrected call after cancellation is accepted', async () => {
    const controller = new AbortController();
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      if (turn === 1) return toolCallResponse([{ id: 'invalid-before-cancel', name: 'fixture_write', args: { path: 42 } }]);
      if (turn === 2) {
        controller.abort();
        return toolCallResponse([{ id: 'corrected-after-cancel', name: 'fixture_write', args: { path: 'target.txt', content: 'must not run' } }]);
      }
      return textResponse('The run was cancelled before the corrected operation started.');
    });
    const write = makeTool('fixture_write', { ok: true, output: 'written' }, {
      inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [write], inbound: textMessage('user', 'Write target.txt after correcting its arguments.') });
    ctx.signal = controller.signal;

    await stage(ctx);

    expect(write.calls).toHaveLength(0);
    expect(ctx.toolInvocations?.map((record) => record.status)).toContain('aborted');
    expect(ctx.toolInvocations?.some((record) => record.status === 'succeeded')).toBe(false);
  });

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

    expect(result).toMatchObject({ ok: true, next: 'finalize' });
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
    const ctx = makeCtx({
      tools: [write],
      inbound: textMessage('user', 'write into the core source'),
      toolContext: { approve: async () => false },
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: false, next: 'recover' });
    expect(result.error).toContain('approval_denied');
    // The refusal is authoritative: the model's follow-up cannot turn a denied
    // operation into a publishable completion. The tool never ran.
    expect(write.calls).toHaveLength(0);
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toBeUndefined();
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
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
      if (turn === 1) return toolCallResponse([{ id: 'write-1', name: 'write', args: { file_path: 'build.log', content: 'build output' } }]);
      return textResponse('the build failed; I inspected the output directory first');
    });
    const write = makeTool('write', { ok: false, error: 'exit code 1' });
    write.execution = { concurrency: 'exclusive', resources: () => [{ key: 'external:process', mode: 'write' }] };
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [write], inbound: textMessage('user', 'run the build') });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'finalize' });
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('may already have changed the workspace'),
      }),
    ]));
    // The runtime does not replay it: exactly one invocation was attempted.
    expect(write.calls).toHaveLength(1);
  });

  // CE-04: a batch that half succeeds must keep the half that worked. The
  // failure is not allowed to discard the batch, and the succeeded effect must
  // not be replayed when the model fixes the other part.
  it('keeps the successful half of a mixed batch and only reworks what failed', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        return toolCallResponse([
          { id: 'write-ok', name: 'write', args: { file_path: 'kept.txt' } },
          { id: 'write-missing', name: 'write', args: { file_path: 'missing/thing.txt' } },
        ]);
      }
      if (turn === 2) return toolCallResponse([{ id: 'write-retry', name: 'write', args: { file_path: 'missing/thing.txt' } }]);
      return textResponse('kept.txt was written; the second file is there now too.');
    });
    const write = makeTool('write', { ok: true, output: 'written' });
    let attempts = 0;
    (write as { execute: unknown }).execute = async () => {
      attempts += 1;
      write.calls.push({});
      // Only the first call of the first round fails.
      return attempts === 2
        ? { callId: '', ok: false, error: 'Path not found: missing/thing.txt' }
        : { callId: '', ok: true, output: 'written' };
    };
    write.execution = {
      concurrency: 'exclusive',
      resources: (input) => [{ key: `fs:${String((input as { file_path?: string }).file_path ?? '')}`, mode: 'write' as const }],
    };
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [write], inbound: textMessage('user', '写两个文件') });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'finalize' });
    // Both results of the mixed round are preserved, in order.
    const round = (ctx.toolResults ?? []).slice(0, 2);
    expect(round.map((entry) => entry.ok)).toEqual([true, false]);
    expect(round[1]?.error).toContain('Path not found');
    // The model reworked only the failed path, and the succeeded write was not
    // re-issued by the Runtime.
    expect(attempts).toBe(3);
    expect(ctx.reply).toBe('kept.txt was written; the second file is there now too.');
  });

  it('bounds a model that repeats the same failing observation', async () => {    const llm = createMockLlm(() => toolCallResponse([{ id: `read-${Math.random()}`, name: 'read', args: { file_path: 'notes.md' } }]));
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
