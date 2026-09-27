// @littlesheep/harness — stages/verify/structural-evidence.test.ts
//
// HC-03: proof that the narrow structural passes are decided from what a *real*
// run records, not from a plan.
//
// Every case below drives `createDefaultHarness(...).run(ctx)` end to end: the
// model call, the tool execution boundary, the side-effect ledger, VERIFY and
// FINALIZE all run for real, and the assertions read the RunContext the run
// produced. Nothing here pre-fills a `taskBook` or a `taskExecution` to obtain a
// `pass` — the two retired shapes are used in exactly one place, the last
// `describe`, to prove they no longer verify anything on their own.
//
// Two Runtime-owned inputs are worth naming, because a test fixture cannot
// always reproduce them:
//
// - `ctx.sideEffects` is NOT written by hand anywhere in this file. The mock
//   `write` tool goes through the same `ToolExecutionService` as the real one,
//   so the Runtime's own ledger (`createSideEffectLifecycle` →
//   `describeSideEffect`) records the effect: a tool that is not declared
//   read-only and returns no read resources is an effect, whatever it is called.
// - `ctx.history` IS supplied by hand for the write-then-read shape. The
//   arguments of that shape come from the run's transcript, and `ctx.history` is
//   the Runtime-owned transcript projection the run was built with; the mock
//   session manager cannot replay the current run's own assistant tool calls
//   (they are recorded in `ctx.produced` while the run is in flight). The
//   fixture therefore supplies the same `text` + `tool_calls` assistant blocks
//   the Runtime persists, with the same call ids the model emits, and the calls
//   still execute for real. `does not reach the write-read pass ...` below pins
//   down what a run without that projection does today.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { textMessage, type Message, type RunContext, type StageResult } from '@littlesheep/types';
import { createDefaultHarness } from '../../default-harness.js';
import {
  createMockLlm,
  createMockMemoryStore,
  createMockSessionManager,
  makeCtx,
  makeTool,
  textResponse,
  toolCallResponse,
} from '../../tests/helpers.js';

const MARKER = 'proof-7319';

const baseDeps = {
  model: 'test',
  config: DEFAULT_CONFIG,
  branding: DEFAULT_BRANDING,
};

function makeHarness(llm: ReturnType<typeof createMockLlm>) {
  return createDefaultHarness({
    ...baseDeps,
    llm,
    sessionManager: createMockSessionManager(),
    memoryStore: createMockMemoryStore(),
  });
}

function traceNames(result: StageResult): string[] {
  return (result.meta?.trace as Array<{ name: string }> | undefined)?.map((entry) => entry.name) ?? [];
}

/**
 * One assistant transcript record: the preamble plus the tool call.
 *
 * This is the shape `persistToolCalls` writes for a model that said something
 * before calling a tool, and it is deliberately the shape the session-history
 * projection keeps: a message with tool calls but no text block is dropped from
 * `ctx.history` when a run is built from a session.
 */
function transcriptCall(id: string, name: string, input: Record<string, unknown>): Message {
  return {
    id: `transcript:${id}`,
    role: 'assistant',
    content: [
      { type: 'text', text: `Calling ${name}.` },
      { type: 'tool_calls', calls: [{ id, name, input, rawArguments: JSON.stringify(input) }] },
    ],
    timestamp: '2026-09-27T00:00:00.000Z',
    stage: 'execute',
  };
}

describe('structural pass evidence comes from the run itself', () => {
  it('passes a run with one successful read-only call and a Provider reply', async () => {
    const glob = makeTool('glob', { ok: true, output: 'attachments/' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-1', name: 'glob', args: { pattern: '*' } }]),
      textResponse('共有 1 个条目：attachments/'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', '请使用 glob 工具读取当前文件夹，只告诉我顶层条目数量和名称，不要修改任何文件。'),
      tools: [glob],
    });

    const result = await h.run(ctx);

    // The run really went through VERIFY; the pass is the last verification record.
    expect(traceNames(result)).toEqual(['enter', 'classify', 'execute', 'verify', 'finalize']);
    expect(result.next).toBe('exit');
    expect(result.ok).toBe(true);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
    expect(glob.calls).toHaveLength(1);
    // The evidence the pass reads is the run's own; nothing created a write effect.
    expect(ctx.toolInvocations?.map((invocation) => invocation.toolName)).toEqual(['glob']);
    expect(ctx.sideEffects ?? []).toHaveLength(0);
  });

  it('passes an exact write-then-read run whose read returned the written content', async () => {
    const write = makeTool('write', { ok: true, output: 'Wrote proof.txt' });
    const read = makeTool('read', { ok: true, output: MARKER });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'write-1', name: 'write', args: { file_path: 'proof.txt', content: MARKER } }]),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'proof.txt' } }]),
      textResponse(`proof.txt was verified as ${MARKER}.`),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', `Write proof.txt with ${MARKER}, then read it back and report both values.`),
      tools: [write, read],
    });

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    expect(result.ok).toBe(true);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
    expect(ctx.toolInvocations?.map((invocation) => invocation.toolName)).toEqual(['write', 'read']);
    expect(ctx.toolInvocations?.every((invocation) => (
      invocation.status === 'succeeded'
      && invocation.toolSource === 'builtin'
      && invocation.outputTruncated !== true
    ))).toBe(true);
    // The write effect is the Runtime's own record of the executed call, not a
    // fixture value: exactly one settled `write` effect for the write invocation.
    expect(ctx.sideEffects).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({
      toolName: 'write',
      status: 'succeeded',
      callId: ctx.toolInvocations?.[0]?.callId,
    });
    expect(write.calls).toHaveLength(1);
    expect(read.calls).toHaveLength(1);
  });

  it('reads the call arguments from the run itself, not from the pre-run history projection', async () => {
    // No seeded `history`: the arguments have to come from what this run recorded while it ran
    // (`ctx.produced`). This is the reachability proof for the write-then-read channel — before the
    // arguments were read from `ctx.history`, which is built from the session *before* the run, so a
    // fresh run could hold both invocations and still never satisfy the branch.
    const write = makeTool('write', { ok: true, output: 'Wrote proof.txt' });
    const read = makeTool('read', { ok: true, output: MARKER });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'write-1', name: 'write', args: { file_path: 'proof.txt', content: MARKER } }]),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'proof.txt' } }]),
      textResponse(`proof.txt was verified as ${MARKER}.`),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', `Write proof.txt with ${MARKER}, then read it back and report both values.`),
      tools: [write, read],
    });

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    expect(ctx.history ?? []).toHaveLength(0);
    expect(ctx.toolInvocations?.map((invocation) => invocation.toolName)).toEqual(['write', 'read']);
    expect(ctx.sideEffects).toHaveLength(1);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'pass', source: 'structural' });
  });
});

describe('evidence outside the narrow shapes stays unverified', () => {
  it('does not pass two read-only calls', async () => {
    const glob = makeTool('glob', { ok: true, output: 'notes.txt' });
    const read = makeTool('read', { ok: true, output: 'hello' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-1', name: 'glob', args: { pattern: '*' } }]),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'notes.txt' } }]),
      textResponse('notes.txt says hello.'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', 'Find the workspace entries and then read notes.txt.'),
      tools: [glob, read],
    });

    const result = await h.run(ctx);

    // Two successful read-only calls are a wider shape than the fast path proves,
    // so the run is published as unverified rather than as verified.
    expect(result.next).toBe('exit');
    expect(ctx.toolInvocations).toHaveLength(2);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
  });

  it('does not pass a single call to a tool outside the read-only set', async () => {
    const exec = makeTool('exec', { ok: true, output: 'build done' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'exec-1', name: 'exec', args: { command: 'pnpm build' } }]),
      textResponse('The build finished.'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', 'Run the build once and report what it printed.'),
      tools: [exec],
    });

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    expect(ctx.toolInvocations?.map((invocation) => invocation.toolName)).toEqual(['exec']);
    // The call succeeded and settled an effect: it is an external action, so it is
    // outside the read-only shape no matter how clean the result looks.
    expect(ctx.sideEffects?.map((effect) => effect.toolName)).toEqual(['exec']);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
  });

  it('does not pass a single read whose result was sanitized', async () => {
    // A binary file: the Runtime's own sanitizer replaces the bytes with a hex
    // preview and marks the result. The bytes the model saw are not the file.
    const read = makeTool('read', { ok: true, output: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]) });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'logo.png' } }]),
      textResponse('logo.png starts with a PNG signature.'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', 'Read logo.png and tell me what the first bytes are.'),
      tools: [read],
    });

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    expect(ctx.toolInvocations).toHaveLength(1);
    // The rejection is the sanitized result, not a truncated invocation: the
    // preview is short enough to travel intact.
    expect(ctx.toolInvocations?.[0]?.outputTruncated).not.toBe(true);
    expect(ctx.toolResults?.[0]?.sanitized).toBe(true);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
  });

  it('does not pass a single failed read', async () => {
    const read = makeTool('read', { ok: false, error: 'file not found' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'missing.txt' } }]),
      textResponse('missing.txt could not be read.'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', 'Read missing.txt and report its contents.'),
      tools: [read],
    });

    const result = await h.run(ctx);

    // A recorded failure is a known outcome: the answer is still published, and
    // the failure stays in the record instead of becoming a pass.
    expect(result.next).toBe('exit');
    expect(ctx.toolInvocations?.[0]?.status).toBe('failed');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(ctx.verificationHistory?.at(-1)?.reason).toContain('read-1 is failed');
  });

  it('does not pass a write then a read of a different path', async () => {
    const write = makeTool('write', { ok: true, output: 'Wrote proof.txt' });
    const read = makeTool('read', { ok: true, output: MARKER });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'write-1', name: 'write', args: { file_path: 'proof.txt', content: MARKER } }]),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'other.txt' } }]),
      textResponse(`proof.txt was verified as ${MARKER}.`),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', `Write proof.txt with ${MARKER}, then read it back and report both values.`),
      tools: [write, read],
      history: [
        transcriptCall('write-1', 'write', { file_path: 'proof.txt', content: MARKER }),
        transcriptCall('read-1', 'read', { file_path: 'other.txt' }),
      ],
    });

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    // Both calls succeeded and the read returned exactly the written bytes: the
    // one fact that fails the shape is that it read a different file.
    expect(ctx.toolInvocations?.map((invocation) => invocation.status)).toEqual(['succeeded', 'succeeded']);
    expect(ctx.toolResults?.[1]?.output).toBe(MARKER);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
  });

  it('does not pass a write then a read whose output differs from the written content', async () => {
    const write = makeTool('write', { ok: true, output: 'Wrote proof.txt' });
    const read = makeTool('read', { ok: true, output: 'proof-plain-0000' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'write-1', name: 'write', args: { file_path: 'proof.txt', content: MARKER } }]),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { file_path: 'proof.txt' } }]),
      textResponse(`proof.txt was verified as ${MARKER}.`),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', `Write proof.txt with ${MARKER}, then read it back and report both values.`),
      tools: [write, read],
      history: [
        transcriptCall('write-1', 'write', { file_path: 'proof.txt', content: MARKER }),
        transcriptCall('read-1', 'read', { file_path: 'proof.txt' }),
      ],
    });

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    // Same path, same shape, successful calls: only the read-back value differs,
    // and that alone must keep the run out of `pass`.
    expect(ctx.toolInvocations?.map((invocation) => invocation.status)).toEqual(['succeeded', 'succeeded']);
    expect(ctx.toolResults?.[1]?.output).not.toBe(MARKER);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
  });
});

describe('legacy history does not verify', () => {
  it('does not pass a run whose context carries a completed legacy task book and no live calls', async () => {
    // A resumed run as it looks today: the checkpoint restored a TaskBook and its
    // TaskExecution, and the session projection carries an earlier transcript of
    // write-then-read. None of it is evidence about this run, which made no tool
    // call of its own, so the retired structures cannot produce a `pass`.
    const taskBook: NonNullable<RunContext['taskBook']> = {
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
    const taskExecution: NonNullable<RunContext['taskExecution']> = {
      goal: taskBook.goal,
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-09-27T00:00:00.000Z',
      endedAt: '2026-09-27T00:00:02.000Z',
      steps: [{
        stepId: 'write-proof',
        description: 'write proof.txt',
        status: 'done',
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        output: 'Wrote proof.txt',
        toolCallIds: ['write-1'],
        toolResults: [{ callId: 'write-1', ok: true, output: 'Wrote proof.txt' }],
      }, {
        stepId: 'read-proof',
        description: 'read proof.txt',
        status: 'done',
        startedAt: '2026-09-27T00:00:01.000Z',
        endedAt: '2026-09-27T00:00:02.000Z',
        output: MARKER,
        toolCallIds: ['read-1'],
        toolResults: [{ callId: 'read-1', ok: true, output: MARKER }],
      }],
    };
    const llm = createMockLlm(textResponse(`proof.txt 已核对，内容为 ${MARKER}。`));
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', `核对 resume-proof.txt 的内容并汇报，期望值是 ${MARKER}。`),
      history: [
        transcriptCall('write-1', 'write', { file_path: 'proof.txt', content: MARKER }),
        transcriptCall('read-1', 'read', { file_path: 'proof.txt' }),
      ],
    });
    ctx.taskBook = taskBook;
    ctx.taskExecution = taskExecution;

    const result = await h.run(ctx);

    expect(result.next).toBe('exit');
    expect(result.ok).toBe(true);
    // The run's own evidence is what decides: it made no call, so the completed
    // legacy plan and the inherited transcript verify nothing.
    expect(ctx.toolInvocations ?? []).toHaveLength(0);
    expect(ctx.toolResults ?? []).toHaveLength(0);
    expect(ctx.sideEffects ?? []).toHaveLength(0);
    expect(ctx.reply).toContain(MARKER);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
  });
});
