// @littlesheep/harness — stages/execute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createExecuteStage, convertToolCall } from './execute.js';
import {
  createMockLlm, textResponse, toolCallResponse, makeCtx, makeTool,
} from '../tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { parallelFilePolicy } from '@littlesheep/tools';
import { RUNTIME_EVENT_VERSION, textMessage } from '@littlesheep/types';
import type {
  AgentTool,
  RuntimeEventDecision,
  RuntimeEventEnvelope,
  RuntimeEventQueueLike,
  TaskBook,
  ToolStreamEvent,
} from '@littlesheep/types';
import { z } from 'zod';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

function threeStepTaskBook(): TaskBook {
  return {
    assessment: {
      userNeed: 'complete three steps',
      complexity: 'standard',
      goal: 'complete the workflow',
      successCriteria: ['all three steps are complete'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'complete the workflow',
    complexity: 'standard',
    successCriteria: ['all three steps are complete'],
    steps: [
      { id: 'step-1', title: 'One', description: 'complete step one' },
      { id: 'step-2', title: 'Two', description: 'complete step two' },
      { id: 'step-3', title: 'Three', description: 'complete step three' },
    ],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
  };
}

function singleGlobTaskBook(input: unknown): TaskBook {
  return {
    assessment: {
      userNeed: '读取工作区顶层条目',
      complexity: 'trivial',
      goal: '读取工作区顶层条目',
      successCriteria: ['返回数量和名称'],
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    goal: '读取工作区顶层条目',
    complexity: 'trivial',
    successCriteria: ['返回数量和名称'],
    steps: [{
      id: 'step-1',
      description: '使用 glob 读取顶层条目',
      tools: ['glob'],
      toolProposal: { name: 'glob', input },
      execution: {
        mode: 'serial',
        resources: [{ key: 'workspace:.', mode: 'read' }],
        sideEffect: 'read',
      },
    }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: '只返回结果' },
  };
}

function explicitGlobClassification() {
  return {
    activity: 'execute' as const,
    type: 'problem' as const,
    confidence: 0.96,
    source: 'rules' as const,
    reason: 'explicit tool instruction',
  };
}

describe('convertToolCall', () => {
  it('bridges OpenAI format → internal {id, name, input}', () => {
    const tc = convertToolCall({
      id: 'call_1', type: 'function',
      function: { name: 'read', arguments: '{"file_path":"/x"}' },
    });
    expect(tc).toEqual({ id: 'call_1', name: 'read', input: { file_path: '/x' } });
  });

  it('falls back to {} on invalid JSON args', () => {
    const tc = convertToolCall({
      id: 'c2', type: 'function',
      function: { name: 'x', arguments: 'not-json' },
    });
    expect(tc.input).toEqual({});
  });

  it('falls back to {} on empty args', () => {
    const tc = convertToolCall({
      id: 'c3', type: 'function',
      function: { name: 'x', arguments: '' },
    });
    expect(tc.input).toEqual({});
  });
});

describe('executeStage', () => {
  it('stop → sets ctx.reply, transitions to verify', async () => {
    const llm = createMockLlm(textResponse('all done'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'do something') });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(res.ok).toBe(true);
    expect(ctx.reply).toBe('all done');
    expect(ctx.toolResults).toEqual([]);
  });

  it('includes the active behavior profile in the execution system prompt', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      systemPrompts.push(String(request.messages[0]?.content ?? ''));
      return textResponse('done');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'inspect the repository') });
    ctx.profilePromptAddon = 'PROFILE_SENTINEL_EXECUTE';

    await stage(ctx);

    expect(systemPrompts[0]).toContain('PROFILE_SENTINEL_EXECUTE');
  });

  it('executes an admitted explicit read proposal without an execute tool-loop model call', async () => {
    const glob = makeTool('glob', {
      ok: true,
      output: 'alpha.txt\nbeta.md\nnested\\',
    }, {
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        max_results: z.number().int().positive().optional().default(100),
      }),
    });
    glob.execution = parallelFilePolicy('path', 'read', true);
    const llm = createMockLlm(textResponse('共有 3 个顶层条目：alpha.txt、beta.md、nested。'));
    const stage = createExecuteStage({ ...deps, llm });
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx({
      tools: [glob],
      inbound: textMessage('user', '请使用 glob 工具读取当前工作区顶层条目'),
      classification: explicitGlobClassification(),
      taskBook: singleGlobTaskBook({ pattern: '*', path: '.', max_results: 100 }),
      toolContext: {
        permissionMode: 'research',
        containerRoot: process.cwd(),
      },
    });
    ctx.resolvedRunConfig = {
      version: 1,
      runId: ctx.runId,
      resolvedAt: '2026-08-03T00:00:00.000Z',
      origin: 'test',
      behaviorModeId: 'general',
      permissionPolicyId: 'research',
      workflowStrategyId: 'core-flow',
      contextStrategyId: 'context-v1',
      memoryStrategyId: 'index-first-v1',
      toolSelectionStrategyId: 'registered-tools-v1',
      outputContractId: 'user-reply-v1',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoning: 'auto',
      parameters: {},
      availableToolNames: ['glob'],
      approvalRequiredToolNames: [],
      userOverrides: {},
      projectOverrides: {},
    };
    ctx.onToolEvent = (event) => events.push(event);

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(glob.calls).toHaveLength(1);
    expect(glob.calls[0]?.input).toEqual({ pattern: '*', path: '.', max_results: 100 });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const finalRequest = llm.chat.mock.calls[0]?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(finalRequest.tools).toBeUndefined();
    expect(finalRequest.thinking).toEqual({ type: 'disabled' });
    expect(finalRequest.temperature).toBeUndefined();
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_final_reply',
    ]);
    expect(ctx.reply).toBe('共有 3 个顶层条目：alpha.txt、beta.md、nested。');
    expect(ctx.replyProvenance?.purpose).toBe('execute_final_reply');
    expect(ctx.taskExecution?.steps[0]?.output).toContain('alpha.txt');
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      toolName: 'glob',
      status: 'succeeded',
      approval: { required: false, decision: 'not_required' },
    });
    expect(ctx.produced.map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(events.map((event) => event.type)).toEqual([
      'step_start', 'tool_start', 'tool_end', 'step_done',
    ]);
  });

  it('executes explicit write and read proposals with only the final reply model call', async () => {
    const write = makeTool('write', { ok: true, output: 'Wrote proof.txt' }, {
      requiresApproval: true,
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    });
    write.execution = parallelFilePolicy('file_path', 'write');
    const read = makeTool('read', { ok: true, output: 'proof-7319' }, {
      inputSchema: z.object({ file_path: z.string() }),
    });
    read.execution = parallelFilePolicy('file_path', 'read');
    const llm = createMockLlm(textResponse('proof.txt was written and verified as proof-7319.'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [write, read],
      inbound: textMessage('user', 'Please use the write tool and read tool to verify proof.txt with proof-7319.'),
      classification: explicitGlobClassification(),
      toolContext: {
        permissionMode: 'full',
        containerRoot: process.cwd(),
      },
      taskBook: {
        assessment: {
          userNeed: 'write and verify proof.txt',
          complexity: 'standard',
          goal: 'write then read proof.txt',
          successCriteria: ['proof.txt contains proof-7319'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 1,
        },
        goal: 'write then read proof.txt',
        complexity: 'standard',
        successCriteria: ['proof.txt contains proof-7319'],
        steps: [{
          id: 'write-proof',
          description: 'write proof.txt',
          tools: ['write'],
          toolProposal: { name: 'write', input: { file_path: 'proof.txt', content: 'proof-7319' } },
          execution: {
            mode: 'serial',
            resources: [{ key: 'workspace:proof.txt', mode: 'write' }],
            sideEffect: 'write',
          },
        }, {
          id: 'read-proof',
          description: 'read proof.txt',
          tools: ['read'],
          toolProposal: { name: 'read', input: { file_path: 'proof.txt' } },
          execution: {
            mode: 'serial',
            dependsOn: ['write-proof'],
            resources: [{ key: 'workspace:proof.txt', mode: 'read' }],
            sideEffect: 'read',
          },
        }],
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
      },
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(write.calls).toHaveLength(1);
    expect(read.calls).toHaveLength(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_final_reply',
    ]);
    expect(ctx.taskExecution?.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(ctx.sideEffects).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({ toolName: 'write', status: 'succeeded' });
  });

  it('passes the configured invocation timeout to explicit tools', async () => {
    let observedAborted = false;
    const slow = makeTool('read', { ok: true, output: 'unused' }, {
      inputSchema: z.object({ file_path: z.string() }),
    });
    slow.execution = parallelFilePolicy('file_path', 'read');
    slow.execute = async (_input, context) => new Promise((resolve) => {
      context.signal?.addEventListener('abort', () => {
        observedAborted = true;
        resolve({ callId: '', ok: false, error: 'stopped' });
      }, { once: true });
    });
    const llm = createMockLlm(textResponse('读取超时。'));
    const stage = createExecuteStage({
      ...deps,
      config: {
        ...DEFAULT_CONFIG,
        tools: { ...DEFAULT_CONFIG.tools, invocationTimeoutMs: 1_000 },
      },
      llm,
    });
    const ctx = makeCtx({
      tools: [slow],
      toolSources: { read: 'builtin' },
      inbound: textMessage('user', '请使用 read 工具读取 slow.txt'),
      classification: explicitGlobClassification(),
      taskBook: {
        ...singleGlobTaskBook({ pattern: '*' }),
        steps: [{
          id: 'step-1',
          tools: ['read'],
          toolProposal: { name: 'read', input: { file_path: 'slow.txt' } },
          execution: {
            mode: 'serial',
            resources: [{ key: 'workspace:slow.txt', mode: 'read' }],
            sideEffect: 'read',
          },
        }],
      },
    });

    await stage(ctx);

    expect(observedAborted).toBe(true);
    expect(ctx.toolInvocations?.[0]).toMatchObject({ status: 'timed_out' });
  });

  it('directly executes an explicit builtin exec proposal only with full permission', async () => {
    const exec = makeTool('exec', { ok: true, output: 'sustained-anchor' }, {
      requiresApproval: true,
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().positive().optional().default(120_000),
      }),
    });
    const llm = createMockLlm(textResponse('命令已完成并返回 sustained-anchor。'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [exec],
      toolSources: { exec: 'builtin' },
      inbound: textMessage('user', '请只使用 exec 工具执行 echo sustained-anchor'),
      classification: explicitGlobClassification(),
      toolContext: { permissionMode: 'full', containerRoot: process.cwd() },
      taskBook: {
        ...singleGlobTaskBook({ pattern: '*' }),
        steps: [{
          id: 'step-1',
          tools: ['exec'],
          toolProposal: { name: 'exec', input: { command: 'echo sustained-anchor', timeout_ms: 120_000 } },
          execution: { mode: 'serial', resources: [], sideEffect: 'external' },
        }],
      },
    });

    await stage(ctx);

    expect(exec.calls).toHaveLength(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual(['execute_final_reply']);
    expect(ctx.sideEffects?.[0]).toMatchObject({ toolName: 'exec', status: 'succeeded', effectKind: 'external' });
  });

  it('lets Runtime derive a missing side-effect declaration for explicit builtin exec in full mode', async () => {
    const exec = makeTool('exec', { ok: true, output: 'runtime-derived-exec' }, {
      requiresApproval: true,
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().positive().optional().default(120_000),
      }),
    });
    const llm = createMockLlm(textResponse('命令完成。'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [exec],
      toolSources: { exec: 'builtin' },
      inbound: textMessage('user', '请只使用 exec 工具执行 echo runtime-derived-exec'),
      classification: explicitGlobClassification(),
      toolContext: { permissionMode: 'full', containerRoot: process.cwd() },
      taskBook: {
        ...singleGlobTaskBook({ pattern: '*' }),
        steps: [{
          id: 'step-1',
          tools: ['exec'],
          toolProposal: { name: 'exec', input: { command: 'echo runtime-derived-exec' } },
        }],
      },
    });

    await stage(ctx);

    expect(exec.calls).toHaveLength(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual(['execute_final_reply']);
    expect(ctx.sideEffects?.[0]).toMatchObject({ toolName: 'exec', status: 'succeeded', effectKind: 'external' });
  });

  it('applies a pause after the completed tool wave without requesting a final reply', async () => {
    let pauseReady = false;
    const exec = makeTool('exec', { ok: true, output: 'sustained-anchor' }, {
      requiresApproval: true,
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().positive().optional().default(120_000),
      }),
    });
    exec.execute = vi.fn(async () => {
      pauseReady = true;
      return { callId: '', ok: true, output: 'sustained-anchor', durationMs: 1 };
    });
    const llm = createMockLlm(textResponse('must not be requested'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [exec],
      toolSources: { exec: 'builtin' },
      inbound: textMessage('user', '请只使用 exec 工具执行 echo sustained-anchor'),
      classification: explicitGlobClassification(),
      toolContext: { permissionMode: 'full', containerRoot: process.cwd() },
      taskBook: {
        ...singleGlobTaskBook({ pattern: '*' }),
        steps: [{
          id: 'step-1',
          tools: ['exec'],
          toolProposal: { name: 'exec', input: { command: 'echo sustained-anchor', timeout_ms: 120_000 } },
          execution: { mode: 'serial', resources: [], sideEffect: 'external' },
        }],
      },
    });
    const pauseEvent: RuntimeEventEnvelope = {
      version: RUNTIME_EVENT_VERSION,
      id: 'pause-after-tool',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      sequence: 1,
      type: 'pause_requested',
      source: 'app',
      status: 'queued',
      receivedAt: '2026-08-03T10:00:00.000Z',
      payload: { reason: 'pause after the active tool finishes' },
    };
    const settleDecisionBatch = vi.fn((_token: string, decisions: readonly RuntimeEventDecision[]) => {
      pauseReady = false;
      return [{
        ...pauseEvent,
        status: decisions[0]?.status ?? 'ignored',
        decisionReason: decisions[0]?.reason,
      }];
    });
    ctx.runtimeNow = () => new Date('2026-08-03T10:00:01.000Z');
    ctx.runtimeEventQueue = {
      openDecisionBatchForTypes: vi.fn((types: readonly RuntimeEventEnvelope['type'][]) => (
        pauseReady && types.includes('pause_requested')
          ? {
              token: 'pause-batch',
              openedAt: '2026-08-03T10:00:01.000Z',
              cursor: 0,
              events: [pauseEvent],
            }
          : undefined
      )),
      settleDecisionBatch,
      releaseDecisionBatch: vi.fn(() => true),
    } as unknown as RuntimeEventQueueLike;
    ctx.persistRuntimeCheckpoint = vi.fn(async () => 'effect-checkpoint');

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'exit', ok: false, error: 'run paused at a safe boundary' });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(ctx.taskExecution).toMatchObject({
      status: 'done',
      steps: [expect.objectContaining({ stepId: 'step-1', status: 'done' })],
    });
    expect(ctx.runtimeControl).toMatchObject({
      state: 'paused',
      reason: 'pause after the active tool finishes',
      eventIds: ['pause-after-tool'],
    });
    expect(settleDecisionBatch).toHaveBeenCalledTimes(1);
    expect(ctx.persistRuntimeCheckpoint).toHaveBeenCalledTimes(2);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(ctx.modelRequests).toBeUndefined();
    expect(ctx.reply).toBeUndefined();
  });

  it('allows only one final text round after an authoritative tool-boundary failure', async () => {
    const write = makeTool('write', { ok: true, output: 'written' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'unexpected-read', name: 'read', args: { file_path: 'proof.txt' } }]),
      textResponse('should not be requested'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [write],
      inbound: textMessage('user', 'write proof.txt'),
      taskBook: {
        assessment: {
          userNeed: 'write proof.txt',
          complexity: 'simple',
          goal: 'write proof.txt',
          successCriteria: ['proof.txt exists'],
          requiresTaskBook: false,
          maxExtraScopeRatio: 1,
        },
        goal: 'write proof.txt',
        complexity: 'simple',
        successCriteria: ['proof.txt exists'],
        steps: [{ id: 'write-proof', description: 'write proof.txt', tools: ['write'] }],
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
      },
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(ctx.taskExecution?.steps[0]).toMatchObject({ status: 'failed', failureKind: 'tool_error' });
    expect(ctx.toolInvocations?.[0]).toMatchObject({ toolName: 'read', status: 'unknown_tool' });
  });

  it('keeps explicit continuation requests on the history-aware tool loop', async () => {
    const glob = makeTool('glob', { ok: true, output: 'alpha.txt' }, {
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
    });
    glob.execution = parallelFilePolicy('path', 'read', true);
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-history', name: 'glob', args: { pattern: '*', path: '.' } }]),
      textResponse('已读取条目，并保留上一轮目标。'),
      textResponse('最终回答承接上一轮目标。'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const prior = textMessage('assistant', '上一轮目标是 continuity-history-anchor。');
    const ctx = makeCtx({
      tools: [glob],
      history: [prior],
      inbound: textMessage('user', '继续上一轮，请使用 glob 工具读取当前工作区顶层条目'),
      classification: explicitGlobClassification(),
      taskBook: singleGlobTaskBook({ pattern: '*', path: '.' }),
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(llm.chat).toHaveBeenCalledTimes(3);
    const first = llm.chat.mock.calls[0]?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(first.tools?.map((tool) => tool.function.name)).toEqual(['glob']);
    expect(first.messages.some((message) => String(message.content).includes('continuity-history-anchor'))).toBe(true);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop', 'execute_tool_loop', 'execute_final_reply',
    ]);
    expect(glob.calls).toHaveLength(1);
  });

  it('includes taskBook goal, success criteria, and overdelivery limit in the execution prompt', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((req) => {
      systemPrompts.push(String(req.messages[0]?.content ?? ''));
      return textResponse('done');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      inbound: textMessage('user', 'review the core'),
      bootstrap: { 'SOUL.md': 'SOUL_SENTINEL_SINGLE_STEP_VOICE' },
      taskBook: {
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
      },
    });

    const res = await stage(ctx);

    expect(res.next).toBe('verify');
    expect(systemPrompts[0]).toContain('Task book (from DECIDE)');
    expect(systemPrompts[0]).toContain('Goal: find core gaps');
    expect(systemPrompts[0]).toContain('gaps are named');
    expect(systemPrompts[0]).toContain('Overdelivery limit: 1.5x');
    expect(systemPrompts[0]).toContain('SOUL_SENTINEL_SINGLE_STEP_VOICE');
    expect(systemPrompts[0]).toContain('It may be shown to the user directly');
  });

  it('reuses the model-authored final step output for a trivial one-step task', async () => {
    const tool = makeTool('glob', { ok: true, output: 'attachments/' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-1', name: 'glob', args: { pattern: '*' } }]),
      textResponse('共有 1 个条目：attachments/'),
      textResponse('unexpected extra final reply'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', '请使用 glob 列出顶层条目'),
      taskBook: {
        assessment: {
          userNeed: '列出顶层条目',
          complexity: 'trivial',
          goal: '列出顶层条目',
          successCriteria: ['返回数量和名称'],
          requiresTaskBook: false,
          maxExtraScopeRatio: 1,
        },
        goal: '列出顶层条目',
        complexity: 'trivial',
        successCriteria: ['返回数量和名称'],
        steps: [{ id: 'step-1', description: '读取顶层条目', tools: ['glob'] }],
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: '只返回结果' },
      },
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    expect(ctx.reply).toBe('共有 1 个条目：attachments/');
    expect(ctx.replyProvenance).toMatchObject({ source: 'llm', purpose: 'execute_tool_loop' });
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('executes taskBook steps in order, records step results, and emits step/tool events', async () => {
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]),
      textResponse('step one result'),
      textResponse('step two result'),
      textResponse('final answer'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'lookup x and summarize'),
      bootstrap: { 'SOUL.md': 'SOUL_SENTINEL_USER_FACING_VOICE' },
      taskBook: {
        assessment: {
          userNeed: 'lookup and summarize',
          complexity: 'standard',
          goal: 'find x and summarize it',
          successCriteria: ['x is found', 'summary is written'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 1.5,
        },
        goal: 'find x and summarize it',
        complexity: 'standard',
        successCriteria: ['x is found', 'summary is written'],
        steps: [
          { id: 'find', title: 'Find', description: 'lookup x', tools: ['lookup'], acceptanceCriteria: ['x is found'] },
          { id: 'summarize', title: 'Summarize', description: 'summarize the finding', acceptanceCriteria: ['summary is written'] },
        ],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
      },
    });
    const events: ToolStreamEvent[] = [];
    ctx.onToolEvent = (evt) => events.push(evt);

    const res = await stage(ctx);

    expect(res.next).toBe('verify');
    expect(res.ok).toBe(true);
    expect(ctx.reply).toBe('final answer');
    expect(ctx.taskExecution?.status).toBe('done');
    expect(ctx.taskExecution?.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(ctx.taskExecution?.steps[0].toolCallIds).toEqual(['c1']);
    expect(ctx.toolResults?.[0].meta?.stepId).toBe('find');
    const finalRequest = llm.chat.mock.calls.at(-1)?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(finalRequest.messages[0]?.content).toContain('Follow progressive disclosure');
    expect(finalRequest.messages[0]?.content).toContain('Never hide failed or partial steps');
    expect(finalRequest.messages[0]?.content).toContain('Do not dump raw command output or private chain-of-thought');
    expect(finalRequest.messages[0]?.content).toContain('SOUL_SENTINEL_USER_FACING_VOICE');
    expect(events.map((evt) => evt.type)).toEqual([
      'step_start',
      'tool_start',
      'tool_end',
      'step_done',
      'step_start',
      'step_done',
    ]);
    expect(events.find((evt) => evt.type === 'tool_end')?.durationMs).toBeGreaterThanOrEqual(1);
  });

  it('executes independent TaskBook branches concurrently and merges evidence in stable step order', async () => {
    let activeTools = 0;
    let maxActiveTools = 0;
    const tool = makeTool('parallel-read', { ok: true, output: 'unused' });
    tool.execution = parallelFilePolicy('path', 'read');
    tool.execute = async (input) => {
      activeTools += 1;
      maxActiveTools = Math.max(maxActiveTools, activeTools);
      const path = String((input as { path?: string }).path ?? '');
      await new Promise((resolve) => setTimeout(resolve, path.startsWith('a') ? 30 : 5));
      activeTools -= 1;
      return { callId: '', ok: true, output: `read:${path}` };
    };
    const llm = createMockLlm(textResponse('unused'));
    llm.chat.mockImplementation(async (request: import('@littlesheep/llm').ChatRequest) => {
      const system = String(request.messages[0]?.content ?? '');
      if (system.includes('final response assembler')) return textResponse('parallel final answer');
      const stepId = system.includes('Step id: inspect-a') ? 'inspect-a' : 'inspect-b';
      if (request.messages.some((message) => message.role === 'tool')) return textResponse(`${stepId} result`);
      const path = stepId === 'inspect-a' ? 'a.txt' : 'b.txt';
      return toolCallResponse([{ id: `call-${stepId}`, name: 'parallel-read', args: { path } }]);
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'inspect both files'),
      toolContext: { containerRoot: process.cwd(), permissionMode: 'full' },
      taskBook: {
        assessment: {
          userNeed: 'inspect both files', complexity: 'standard', goal: 'inspect both files',
          successCriteria: ['both files inspected'], requiresTaskBook: true, maxExtraScopeRatio: 1,
        },
        goal: 'inspect both files',
        complexity: 'standard',
        successCriteria: ['both files inspected'],
        steps: [
          {
            id: 'inspect-a', description: 'inspect a', tools: ['parallel-read'],
            execution: { mode: 'parallel', sideEffect: 'read', resources: [{ key: 'workspace:a.txt', mode: 'read' }] },
          },
          {
            id: 'inspect-b', description: 'inspect b', tools: ['parallel-read'],
            execution: { mode: 'parallel', sideEffect: 'read', resources: [{ key: 'workspace:b.txt', mode: 'read' }] },
          },
        ],
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
      },
    });
    const events: ToolStreamEvent[] = [];
    ctx.onToolEvent = (event) => events.push(event);

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    expect(maxActiveTools).toBe(2);
    expect(ctx.taskExecution?.steps.map((step) => [step.stepId, step.executionMode, step.output])).toEqual([
      ['inspect-a', 'parallel', 'inspect-a result'],
      ['inspect-b', 'parallel', 'inspect-b result'],
    ]);
    expect(events.slice(0, 2).map((event) => event.type)).toEqual(['step_start', 'step_start']);
    expect(ctx.toolResults?.map((item) => item.meta?.stepId)).toEqual(['inspect-a', 'inspect-b']);
    expect(ctx.produced.filter((message) => message.role === 'tool').map((message) => {
      const content = message.content[0];
      return content?.type === 'tool_result' ? content.result.meta?.stepId : undefined;
    })).toEqual(['inspect-a', 'inspect-b']);
  });

  it('checkpoints each parallel effectful branch and preserves the bounded active set', async () => {
    let activeTools = 0;
    let maxActiveTools = 0;
    const tool = makeTool('parallel-write', { ok: true, output: 'unused' });
    tool.execution = parallelFilePolicy('path', 'write');
    tool.execute = async (input) => {
      activeTools += 1;
      maxActiveTools = Math.max(maxActiveTools, activeTools);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeTools -= 1;
      return { callId: '', ok: true, output: `wrote:${String((input as { path?: string }).path ?? '')}` };
    };
    const llm = createMockLlm(textResponse('unused'));
    llm.chat.mockImplementation(async (request: import('@littlesheep/llm').ChatRequest) => {
      const system = String(request.messages[0]?.content ?? '');
      if (system.includes('final response assembler')) return textResponse('writes complete');
      const stepId = system.includes('Step id: write-a') ? 'write-a' : 'write-b';
      if (request.messages.some((message) => message.role === 'tool')) return textResponse(`${stepId} result`);
      const path = stepId === 'write-a' ? 'write-a.txt' : 'write-b.txt';
      return toolCallResponse([{ id: `call-${stepId}`, name: 'parallel-write', args: { path } }]);
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'write both files'),
      toolContext: { containerRoot: process.cwd(), permissionMode: 'full' },
      taskBook: {
        assessment: {
          userNeed: 'write both files', complexity: 'standard', goal: 'write both files',
          successCriteria: ['both files written'], requiresTaskBook: true, maxExtraScopeRatio: 1,
        },
        goal: 'write both files',
        complexity: 'standard',
        successCriteria: ['both files written'],
        steps: ['write-a', 'write-b'].map((id) => ({
          id,
          description: id,
          tools: ['parallel-write'],
          execution: {
            mode: 'parallel' as const,
            sideEffect: 'write' as const,
            resources: [{ key: `workspace:${id}.txt`, mode: 'write' as const }],
          },
        })),
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
      },
    });
    const activeSnapshots: string[][] = [];
    ctx.persistRuntimeCheckpoint = vi.fn(async () => {
      activeSnapshots.push((ctx.taskExecution?.steps ?? [])
        .filter((step) => step.status === 'in_progress')
        .map((step) => step.stepId));
      await new Promise((resolve) => setTimeout(resolve, 1));
      return `checkpoint-${activeSnapshots.length}`;
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    expect(maxActiveTools).toBe(2);
    expect(ctx.persistRuntimeCheckpoint).toHaveBeenCalledTimes(4);
    expect(activeSnapshots.some((ids) => ids.length === 2)).toBe(true);
    expect(ctx.sideEffects?.map((effect) => [effect.stepId, effect.status])).toEqual([
      ['write-a', 'succeeded'],
      ['write-b', 'succeeded'],
    ]);
  });

  it('resumes an incomplete parallel branch without rerunning its completed sibling', async () => {
    const llm = createMockLlm(textResponse('unused'));
    llm.chat.mockImplementation(async (request: import('@littlesheep/llm').ChatRequest) => {
      const system = String(request.messages[0]?.content ?? '');
      if (system.includes('final response assembler')) return textResponse('resume complete');
      if (system.includes('Step id: completed')) throw new Error('completed sibling must not rerun');
      return textResponse('remaining result');
    });
    const taskBook: TaskBook = {
      assessment: {
        userNeed: 'resume work', complexity: 'standard', goal: 'resume work',
        successCriteria: ['both steps complete'], requiresTaskBook: true, maxExtraScopeRatio: 1,
      },
      goal: 'resume work',
      complexity: 'standard',
      successCriteria: ['both steps complete'],
      steps: ['completed', 'remaining'].map((id) => ({
        id,
        description: id,
        tools: [],
        execution: { mode: 'parallel', sideEffect: 'none', resources: [] },
      })),
      overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
    };
    const ctx = makeCtx({ inbound: textMessage('user', 'resume work'), taskBook });
    ctx.taskExecution = {
      goal: taskBook.goal,
      complexity: taskBook.complexity,
      status: 'running',
      startedAt: '2026-07-29T10:00:00.000Z',
      steps: [
        {
          stepId: 'completed', description: 'completed', status: 'done', executionMode: 'parallel',
          startedAt: '2026-07-29T10:00:00.000Z', endedAt: '2026-07-29T10:00:01.000Z',
          output: 'preserved result', toolCallIds: [], toolResults: [],
        },
        {
          stepId: 'remaining', description: 'remaining', status: 'failed', executionMode: 'parallel',
          startedAt: '2026-07-29T10:00:00.000Z', endedAt: '2026-07-29T10:00:01.000Z',
          error: 'interrupted', toolCallIds: [], toolResults: [],
        },
      ],
    };

    const result = await createExecuteStage({ ...deps, llm })(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    expect(ctx.taskExecution.steps.map((step) => [step.stepId, step.output])).toEqual([
      ['completed', 'preserved result'],
      ['remaining', 'remaining result'],
    ]);
    expect(llm.chat.mock.calls.filter((call) => String(call[0].messages[0]?.content).includes('Step id: completed')))
      .toHaveLength(0);
  });

  it('resumes a partial replan without rerunning completed steps', async () => {
    const llm = createMockLlm([
      textResponse('step two fixed'),
      textResponse('step three result'),
      textResponse('final resumed answer'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const taskBook = threeStepTaskBook();
    const ctx = makeCtx({ inbound: textMessage('user', 'complete the workflow'), taskBook });
    ctx.taskExecution = {
      goal: taskBook.goal,
      complexity: taskBook.complexity,
      status: 'failed',
      startedAt: '2026-07-10T00:00:00.000Z',
      steps: [
        {
          stepId: 'step-1', title: 'One', description: 'complete step one', status: 'done',
          startedAt: '2026-07-10T00:00:00.000Z', endedAt: '2026-07-10T00:00:01.000Z',
          output: 'preserved step one evidence', attempt: 1, toolCallIds: [], toolResults: [],
        },
        {
          stepId: 'step-2', title: 'Two', description: 'complete step two', status: 'failed',
          startedAt: '2026-07-10T00:00:01.000Z', endedAt: '2026-07-10T00:00:02.000Z',
          error: 'old failure', failureKind: 'verification_gap', attempt: 1,
          toolCallIds: [], toolResults: [],
        },
      ],
    };
    ctx.partialReplanRequest = {
      attempt: 1,
      requestedAt: '2026-07-10T00:00:03.000Z',
      targetStepIds: ['step-2', 'step-3'],
      reason: 'steps incomplete',
      feedback: 'fix step two and continue',
    };
    ctx.replanHistory = [{
      ...ctx.partialReplanRequest,
      preservedStepIds: ['step-1'],
      revisedStepIds: ['step-2', 'step-3'],
    }];
    const events: ToolStreamEvent[] = [];
    ctx.onToolEvent = (event) => events.push(event);

    const res = await stage(ctx);

    expect(res.next).toBe('verify');
    expect(ctx.taskExecution?.status).toBe('done');
    expect(ctx.taskExecution?.steps.map((step) => step.stepId)).toEqual(['step-1', 'step-2', 'step-3']);
    expect(ctx.taskExecution?.steps[0]?.output).toBe('preserved step one evidence');
    expect(ctx.taskExecution?.steps[0]?.attempt).toBe(1);
    expect(ctx.taskExecution?.steps[1]?.attempt).toBe(2);
    expect(ctx.taskExecution?.steps[2]?.attempt).toBe(1);
    expect(ctx.replanHistory?.[0]?.resumedAt).toBeTruthy();
    expect(events.map((event) => event.type)).toEqual([
      'step_skipped',
      'step_start', 'step_done',
      'step_start', 'step_done',
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it('classifies a missing path as a recoverable step failure', async () => {
    const tool = makeTool('read', { ok: false, error: 'ENOENT: file not found' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'read', args: { path: 'missing.txt' } }]),
      textResponse('The path could not be read.'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const taskBook = threeStepTaskBook();
    taskBook.steps = [{ id: 'step-1', description: 'read the target path', tools: ['read'] }];
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'read it'), taskBook });

    const res = await stage(ctx);

    expect(res.next).toBe('verify');
    expect(ctx.taskExecution?.status).toBe('failed');
    expect(ctx.taskExecution?.steps[0]?.failureKind).toBe('not_found');
  });

  it('tool_calls → executes tool, feeds back, then stop', async () => {
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]),
      textResponse('final answer'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'lookup x') });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(ctx.reply).toBe('final answer');
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]!.input).toEqual({ q: 'x' });
    expect(ctx.toolResults).toHaveLength(1);
    expect(ctx.toolResults![0].ok).toBe(true);
    expect(ctx.toolResults![0].output).toBe('found-it');
    const continuation = llm.chat.mock.calls[1]?.[0] as import('@littlesheep/llm').ChatRequest;
    const toolMessage = continuation.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({
      ok: true,
      status: 'succeeded',
      durationMs: 1,
      output: 'found-it',
    });
  });

  it('replays provider reasoning exactly across an interleaved tool call', async () => {
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const requests: import('@littlesheep/llm').ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]),
          reasoningContent: 'provider reasoning must be preserved',
        };
      }
      return textResponse('final answer');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'lookup x') });

    await stage(ctx);

    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        reasoning_content: 'provider reasoning must be preserved',
      }),
    ]));
  });

  it('unknown tool name → tool_result error, continues', async () => {
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'nope', args: {} }]),
      textResponse('recovered'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'x') });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(ctx.toolResults).toHaveLength(1);
    expect(ctx.toolResults![0].ok).toBe(false);
    expect(ctx.toolResults![0].error).toMatch(/unknown tool/);
  });

  it('requiresApproval denied by approver → error result, continues', async () => {
    const tool = makeTool('dangerous', { ok: true, output: 'never' }, { requiresApproval: true });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'dangerous', args: { x: 1 } }]),
      textResponse('after-deny'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'go'),
      toolContext: { approve: async () => false },
    });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(tool.calls).toHaveLength(0); // never executed
    expect(ctx.toolResults![0].ok).toBe(false);
    expect(ctx.toolResults![0].error).toMatch(/denied/);
  });

  it('requiresApproval without an approver fails closed', async () => {
    const tool = makeTool('protected-read', { ok: true, output: 'never' }, { requiresApproval: true });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'protected-read', args: {} }]),
      textResponse('after-deny'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'go') });

    await stage(ctx);

    expect(tool.calls).toHaveLength(0);
    expect(ctx.toolResults![0].error).toMatch(/approval unavailable/);
  });

  it('tool.execute throwing → error result, continues', async () => {
    const tool = makeTool('boom', { ok: true, output: 'never' });
    // override execute to throw
    tool.execute = async () => { throw new Error('tool boom'); };
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'boom', args: {} }]),
      textResponse('after-boom'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(ctx.toolResults![0].ok).toBe(false);
    expect(ctx.toolResults![0].error).toMatch(/tool boom/);
  });

  it('forces a final response after two tool rounds add no evidence', async () => {
    let requestIndex = 0;
    const llm = createMockLlm((request) => {
      requestIndex += 1;
      if (!request.tools) return textResponse('bounded final answer');
      return toolCallResponse([{
        id: `c-${requestIndex}`,
        name: 'lookup',
        args: { attempt: requestIndex },
      }]);
    });
    const tool = makeTool('lookup', { ok: true, output: 'x' });
    tool.execution = {
      concurrency: 'parallel',
      resources: () => [{ key: 'probe:lookup', mode: 'read' }],
    };
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'loop') });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(res.ok).toBe(true);
    expect(ctx.reply).toBe('bounded final answer');
    expect(tool.calls).toHaveLength(3);
    expect(llm.chat).toHaveBeenCalledTimes(4);
    const finalRequest = llm.chat.mock.calls[3]?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(finalRequest.tools).toBeUndefined();
    expect(finalRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('no new evidence'),
      }),
    ]));
  });

  it('treats distinct successful side effects as progress even when outputs match', async () => {
    let requestIndex = 0;
    const llm = createMockLlm((request) => {
      if (!request.tools) return textResponse('forced too early');
      requestIndex += 1;
      if (requestIndex > 4) return textResponse('all writes complete');
      return toolCallResponse([{
        id: `write-${requestIndex}`,
        name: 'write-probe',
        args: { path: `file-${requestIndex}.txt` },
      }]);
    });
    const tool = makeTool('write-probe', { ok: true, output: 'ok' });
    tool.execution = {
      concurrency: 'parallel',
      resources(input) {
        return [{
          key: `fs:${String((input as { path?: string }).path ?? 'unknown')}`,
          mode: 'write',
        }];
      },
    };
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'write four files') });

    const res = await stage(ctx);

    expect(res).toMatchObject({ next: 'verify', ok: true });
    expect(ctx.reply).toBe('all writes complete');
    expect(tool.calls).toHaveLength(4);
    expect(ctx.sideEffects?.filter((effect) => effect.status === 'succeeded')).toHaveLength(4);
    expect(llm.chat).toHaveBeenCalledTimes(5);
    const finalRequest = llm.chat.mock.calls[4]?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(finalRequest.tools).toBeDefined();
  });

  it('finishReason length → recover', async () => {
    const llm = createMockLlm(textResponse('partial...', 'length' as never));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'x') });
    const res = await stage(ctx);
    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/finishReason/);
  });

  it('multiple tool calls in one response all execute', async () => {
    const a = makeTool('a', { ok: true, output: 'A' });
    const b = makeTool('b', { ok: true, output: 'B' });
    const llm = createMockLlm([
      toolCallResponse([
        { id: 'c1', name: 'a', args: {} },
        { id: 'c2', name: 'b', args: {} },
      ]),
      textResponse('done'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [a, b], inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('verify');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(ctx.toolResults).toHaveLength(2);
  });

  it('executes independent parallel-safe tool calls concurrently', async () => {
    let releaseFirst: (() => void) | undefined;
    let firstCompleted = false;
    let secondStartedBeforeFirstCompleted = false;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tool = (name: string, execute: AgentTool['execute']): AgentTool => ({
      name,
      description: `${name} parallel test tool`,
      inputSchema: { parse: (input) => input },
      execution: { concurrency: 'parallel' },
      execute,
    });
    const first = tool('parallel-a', async () => {
      await Promise.race([firstGate, new Promise((resolve) => setTimeout(resolve, 100))]);
      firstCompleted = true;
      return { callId: '', ok: true, output: 'A' };
    });
    const second = tool('parallel-b', async () => {
      secondStartedBeforeFirstCompleted = !firstCompleted;
      releaseFirst?.();
      return { callId: '', ok: true, output: 'B' };
    });
    const llm = createMockLlm([
      toolCallResponse([
        { id: 'parallel-1', name: first.name, args: {} },
        { id: 'parallel-2', name: second.name, args: {} },
      ]),
      textResponse('done'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [first, second], inbound: textMessage('user', 'run both') });

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(secondStartedBeforeFirstCompleted).toBe(true);
    expect(ctx.toolResults?.map((item) => item.callId)).toEqual(['parallel-1', 'parallel-2']);
  });

  // ─── M3: ctx.produced persistence ──────────────────────────────────────

  it('stop → ctx.produced 为空（无 tool 消息）', async () => {
    const llm = createMockLlm(textResponse('done'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'go') });
    await stage(ctx);
    expect(ctx.produced).toEqual([]);
  });

  it('单个 tool 调用 → ctx.produced 有 1 个 assistant(tool_calls) + 1 个 tool(tool_result)', async () => {
    const tool = makeTool('lookup', { ok: true, output: 'found' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]),
      textResponse('done'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'go') });
    await stage(ctx);
    expect(ctx.produced).toHaveLength(2);
    expect(ctx.produced[0]!.role).toBe('assistant');
    expect(ctx.produced[0]!.content[0]!.type).toBe('tool_calls');
    expect(ctx.produced[1]!.role).toBe('tool');
    expect(ctx.produced[1]!.content[0]!.type).toBe('tool_result');
  });

  it('多个 tool 调用在一个 response → 1 个 assistant(tool_calls) + N 个 tool(tool_result)', async () => {
    const a = makeTool('a', { ok: true, output: 'A' });
    const b = makeTool('b', { ok: true, output: 'B' });
    const llm = createMockLlm([
      toolCallResponse([
        { id: 'c1', name: 'a', args: {} },
        { id: 'c2', name: 'b', args: {} },
      ]),
      textResponse('done'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [a, b], inbound: textMessage('user', 'go') });
    await stage(ctx);
    expect(ctx.produced).toHaveLength(3); // 1 assistant + 2 tool
    expect(ctx.produced[0]!.role).toBe('assistant');
    expect(ctx.produced[0]!.content[0]!.type).toBe('tool_calls');
    expect(ctx.produced[1]!.role).toBe('tool');
    expect(ctx.produced[2]!.role).toBe('tool');
  });

  it('未知工具 → ctx.produced 含 tool_result(ok=false)', async () => {
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'nope', args: {} }]),
      textResponse('recovered'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'x') });
    await stage(ctx);
    expect(ctx.produced).toHaveLength(2);
    const toolMsg = ctx.produced[1]!;
    expect(toolMsg.role).toBe('tool');
    const block = toolMsg.content[0] as { type: 'tool_result'; result: { ok: boolean; error?: string } };
    expect(block.type).toBe('tool_result');
    expect(block.result.ok).toBe(false);
    expect(block.result.error).toMatch(/unknown tool/);
  });

  it('fails closed before an effectful tool when its runtime checkpoint is not durable', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'must not run' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'checkpoint-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('checkpoint failure acknowledged'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate safely') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    ctx.persistRuntimeCheckpoint = vi.fn(async () => { throw new Error('durable store unavailable'); });

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(tool.calls).toHaveLength(0);
    expect(ctx.toolResults?.[0]?.error).toContain('until its checkpoint is durable');
    expect(ctx.sideEffects?.[0]?.status).toBe('unknown');
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      toolName: 'mutate',
      toolSource: 'plugin:test-mutation',
      status: 'failed',
      errorKind: 'checkpoint_before_effect',
    });
  });
});
