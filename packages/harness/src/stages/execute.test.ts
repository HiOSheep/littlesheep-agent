// @littlesheep/harness — stages/execute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createExecuteStage, convertToolCall } from './execute.js';
import { createDecideStage } from './decide.js';
import {
  createMockLlm, textResponse, toolCallResponse, makeCtx, makeTool, lastConversationText, allText,
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
  it('promotes a bounded loop through a standalone Runtime control proposal', async () => {
    const llm = createMockLlm(toolCallResponse([{
      id: 'upgrade-1',
      name: 'request_task_book',
      args: {
        reasonCode: 'dependency_discovered',
        reason: 'The requested fix spans dependent modules.',
        remainingGoal: 'Update the dependent module and run verification.',
      },
    }]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', '帮我修复这个文件') });
    ctx.classification = {
      activity: 'execute',
      type: 'problem',
      confidence: 0.8,
      source: 'rules',
      reasonCode: 'action_request',
      workPolicy: {
        version: 1,
        route: 'execute',
        sourceMessageId: String(ctx.inbound.id),
        executionMode: 'bounded_loop',
        reasonCode: 'bounded_single_goal',
      },
    };
    ctx.persistRuntimeCheckpoint = vi.fn(async () => 'checkpoint-upgrade');

    const result = await stage(ctx);

    expect(result).toMatchObject({
      next: 'decide',
      ok: true,
      meta: { workPolicyUpgradeRequestId: `${ctx.runId}:work-policy-upgrade:1` },
    });
    expect(ctx.workPolicyUpgradeRequest).toMatchObject({
      reasonCode: 'dependency_discovered',
      reason: 'The requested fix spans dependent modules.',
      remainingGoal: 'Update the dependent module and run verification.',
      modelAttemptsUsed: 1,
    });
    expect(ctx.toolInvocations).toBeUndefined();
    expect(ctx.produced).toEqual([]);
    expect(ctx.persistRuntimeCheckpoint).toHaveBeenCalledTimes(1);
    const sent = llm.chat.mock.calls[0]?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(sent.tools?.map((tool) => tool.function.name)).toContain('request_task_book');
  });

  it('promotes after completed work, plans only the remainder, and preserves the shared budget', async () => {
    const inspectA = makeTool('inspect_a', { ok: true, output: 'A complete' });
    const inspectB = makeTool('inspect_b', { ok: true, output: 'B complete' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'call-a', name: 'inspect_a', args: { target: 'A' } }]),
      toolCallResponse([{
        id: 'upgrade-1',
        name: 'request_task_book',
        args: {
          reasonCode: 'dependency_discovered',
          reason: 'A exposed a dependent B check.',
          remainingGoal: 'Inspect and report B without repeating A.',
        },
      }]),
      textResponse(JSON.stringify({
        assessment: {
          userNeed: 'Inspect the remaining dependency B.',
          complexity: 'simple',
          goal: 'Inspect and report B without repeating A.',
          successCriteria: ['B is inspected and reported'],
          needsClarification: false,
        },
        taskBook: {
          steps: [{
            id: 'inspect-b',
            description: 'Inspect dependency B.',
            tools: ['inspect_b'],
            acceptanceCriteria: ['B inspection result is available'],
          }],
        },
      })),
      toolCallResponse([{ id: 'call-b', name: 'inspect_b', args: { target: 'B' } }]),
      textResponse('A remains complete; B is now inspected and complete.'),
    ]);
    const ctx = makeCtx({
      inbound: textMessage('user', 'Inspect A and finish the directly dependent work.'),
      tools: [inspectA, inspectB],
    });
    ctx.classification = {
      activity: 'execute',
      type: 'problem',
      confidence: 0.96,
      source: 'rules',
      reasonCode: 'action_request',
      workPolicy: {
        version: 1,
        route: 'execute',
        sourceMessageId: String(ctx.inbound.id),
        executionMode: 'bounded_loop',
        reasonCode: 'bounded_single_goal',
      },
    };
    ctx.persistRuntimeCheckpoint = vi.fn(async () => 'checkpoint-upgrade');

    const firstExecution = await createExecuteStage({ ...deps, llm })(ctx);

    expect(firstExecution).toMatchObject({ next: 'decide', ok: true });
    expect(ctx.workPolicyUpgradeRequest).toMatchObject({
      remainingGoal: 'Inspect and report B without repeating A.',
      completedToolCallIds: ['call-a'],
      budget: { toolLoopIterationsUsed: 2, maxToolLoopIterations: 20 },
    });
    expect(inspectA.calls).toHaveLength(1);
    expect(inspectB.calls).toHaveLength(0);

    const decision = await createDecideStage({ ...deps, llm })(ctx);

    expect(decision).toMatchObject({ next: 'execute', ok: true });
    expect(ctx.taskBook?.steps).toHaveLength(1);
    expect(ctx.taskBook?.steps[0]?.tools).toEqual(['inspect_b']);
    const decideRequest = llm.chat.mock.calls[2]?.[0] as import('@littlesheep/llm').ChatRequest;
    expect(lastConversationText(decideRequest)).toContain('Already completed tool call ids: call-a');
    expect(lastConversationText(decideRequest)).toContain('Budget already used: 2');

    const secondExecution = await createExecuteStage({ ...deps, llm })(ctx);

    expect(secondExecution).toMatchObject({ next: 'verify', ok: true });
    expect(inspectA.calls).toHaveLength(1);
    expect(inspectB.calls).toHaveLength(1);
    expect(ctx.toolResults?.map((result) => result.callId)).toEqual(['call-a', 'call-b']);
    expect(ctx.loopBudget).toMatchObject({ toolLoopIterationsUsed: 4, maxToolLoopIterations: 20 });
    expect(ctx.reply).toBe('A remains complete; B is now inspected and complete.');
    expect(llm.chat).toHaveBeenCalledTimes(5);
  });

  it('rejects a promotion control mixed with user tool calls before executing either', async () => {
    const write = makeTool('write', { ok: true, output: 'unexpected' });
    const llm = createMockLlm(toolCallResponse([{
      id: 'upgrade-1', name: 'request_task_book',
      args: { reasonCode: 'scope_expanded', reason: 'more work', remainingGoal: 'finish the remaining work' },
    }, {
      id: 'write-1', name: 'write', args: { file_path: 'x', content: 'x' },
    }]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', '帮我修复这个文件'), tools: [write] });
    ctx.classification = {
      activity: 'execute', type: 'problem', confidence: 0.8, source: 'rules', reasonCode: 'action_request',
      workPolicy: {
        version: 1, route: 'execute', sourceMessageId: String(ctx.inbound.id),
        executionMode: 'bounded_loop', reasonCode: 'bounded_single_goal',
      },
    };

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'recover', ok: false });
    expect(result.error).toMatch(/standalone Runtime control/);
    expect(write.calls).toHaveLength(0);
  });
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
      systemPrompts.push(allText(request));
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
    ctx.profilePromptAddon = 'PROFILE_SENTINEL_COMPACT_FINAL';
    ctx.bootstrap = { 'SOUL.md': 'SOUL_SENTINEL_COMPACT_FINAL' };
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
    expect(finalRequest.max_tokens).toBe(300);
    const finalSystem = String(finalRequest.messages[0]?.content ?? '');
    const finalInput = String(finalRequest.messages[1]?.content ?? '');
    // The live Runtime clock travels in the trailing message, outside the
    // Provider's cacheable prefix.
    expect(finalRequest.messages.map((message) => String(message.content)).join('\n')).toContain('# Runtime Clock');
    expect(finalSystem).toContain('one completed Runtime-validated read-only tool call');
    expect(finalSystem).toContain('PROFILE_SENTINEL_COMPACT_FINAL');
    expect(finalSystem).toContain('SOUL_SENTINEL_COMPACT_FINAL');
    // The compact clock lives in the trailing message, never in the system prompt.
    const finalRuntime = String(finalRequest.messages.at(-1)?.content ?? '');
    expect(finalRuntime).toContain('# Runtime Clock');
    expect(finalRuntime).not.toContain('# Live Runtime State');
    expect(finalSystem).not.toContain('# Runtime Clock');
    expect(finalSystem).not.toContain('You are the final response assembler.');
    expect(finalInput).toContain('Verified glob result:\nalpha.txt');
    expect(finalInput).not.toContain('Task goal:');
    expect(finalInput).not.toContain('Step results:');
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
    expect(events.filter((event) => event.type !== 'model_activity').map((event) => event.type)).toEqual([
      'step_start', 'tool_start', 'tool_end', 'step_done',
    ]);
  });

  it('executes an admitted autonomous read proposal without an execute tool-loop model call', async () => {
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
    const ctx = makeCtx({
      tools: [glob],
      toolSources: { glob: 'builtin' },
      inbound: textMessage('user', '请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。'),
      classification: {
        activity: 'execute',
        type: 'problem',
        confidence: 0.96,
        source: 'llm',
        reason: 'workspace inspection requires evidence',
      },
      taskBook: singleGlobTaskBook({ pattern: '*', path: '.', max_results: 100 }),
      toolContext: {
        permissionMode: 'research',
        containerRoot: process.cwd(),
      },
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(glob.calls).toHaveLength(1);
    expect(glob.calls[0]?.input).toEqual({ pattern: '*', path: '.', max_results: 100 });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_final_reply',
    ]);
    expect(ctx.replyProvenance?.purpose).toBe('execute_final_reply');
    expect(ctx.taskExecution?.steps[0]?.output).toContain('alpha.txt');
    expect(ctx.toolInvocations).toHaveLength(1);
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

  it('narrows a bounded explicit continuation loop to the named tool while retaining history', async () => {
    const glob = makeTool('glob', { ok: true, output: 'alpha.txt' }, {
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
    });
    glob.execution = parallelFilePolicy('path', 'read', true);
    const read = makeTool('read', { ok: true, output: 'unused' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-bounded-history', name: 'glob', args: { pattern: '*', path: '.' } }]),
      textResponse('已读取条目，并继续承接 continuity-history-anchor。'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const prior = textMessage('assistant', '上一轮目标是 continuity-history-anchor。');
    const ctx = makeCtx({
      tools: [glob, read],
      history: [prior],
      inbound: textMessage('user', '继续上一轮，请使用 glob 工具读取当前工作区顶层条目'),
      classification: explicitGlobClassification(),
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(llm.chat).toHaveBeenCalledTimes(2);
    for (const [request] of llm.chat.mock.calls) {
      expect(request.tools?.map((tool) => tool.function.name)).toEqual(['glob']);
      expect(request.messages.some((message) => String(message.content).includes('continuity-history-anchor'))).toBe(true);
    }
    expect(glob.calls).toHaveLength(1);
    expect(read.calls).toHaveLength(0);
  });

  it('includes taskBook goal, success criteria, and overdelivery limit in the execution prompt', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((req) => {
      systemPrompts.push(allText(req));
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
    // The task book travels as the `taskbook` skill instead of being pushed
    // into every execute request.
    expect(systemPrompts[0]).not.toContain('Task book (from DECIDE)');
    expect(systemPrompts[0]).not.toContain('Goal: find core gaps');
    expect(systemPrompts[0]).not.toContain('gaps are named');
    expect(systemPrompts[0]).not.toContain('Overdelivery limit: 1.5x');
    expect(systemPrompts[0]).toContain('SOUL_SENTINEL_SINGLE_STEP_VOICE');
    expect(systemPrompts[0]).toContain('It may be shown to the user directly');
  });

  it('streams thinking and per-turn prose into the ordered next-Harness transcript', async () => {
    const tool = makeTool('glob', { ok: true, output: 'attachments/' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-1', name: 'glob', args: { pattern: '*' } }]),
      textResponse('共 1 个条目。'),
    ]);
    llm.chatStream.mockImplementation(async (request, onDelta) => {
      onDelta({ type: 'reasoning_delta', delta: '先确认目录里有什么。' });
      const response = await llm.chat(request);
      if (typeof response.content === 'string' && response.content.length > 0) {
        onDelta({ type: 'delta', delta: response.content });
      }
      return response;
    });
    const stage = createExecuteStage({ ...deps, llm });
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', '用 glob 列出顶层条目'),
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
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => { events.push(event); };

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    const transcript = events.filter((event) => event.type === 'model_reasoning' || event.type === 'model_text');
    expect(transcript[0]).toMatchObject({ type: 'model_reasoning', stage: 'execute', reasoningStatus: 'running' });
    expect(transcript.some((event) => event.type === 'model_reasoning' && event.reasoningStatus === 'done')).toBe(true);
    expect(transcript.some((event) => event.type === 'model_text' && (event.summary ?? '').includes('glob'))).toBe(false);
    const ordered = events.filter((event) => event.type === 'model_reasoning' || event.type === 'model_text' || event.type === 'tool_start').map((event) => event.type);
    expect(ordered[0]).toBe('model_reasoning');
    expect(ordered).toContain('tool_start');
    expect(ordered.indexOf('tool_start')).toBeGreaterThan(ordered.indexOf('model_reasoning'));
  });

  it('keeps the transcript out of the legacy path unless it is explicitly enabled', async () => {
    const tool = makeTool('glob', { ok: true, output: 'attachments/' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-1', name: 'glob', args: { pattern: '*' } }]),
      textResponse('共 1 个条目。'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', '用 glob 列出顶层条目') });
    ctx.onToolEvent = (event) => { events.push(event); };

    await stage(ctx);

    expect(events.some((event) => event.type === 'model_reasoning' || event.type === 'model_text')).toBe(false);
    expect(llm.chatStream).not.toHaveBeenCalled();
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

  it('HA-04-04 retracts an invalid citation preview before retrying while keeping only durable Web projections', async () => {
    const pageBody = 'CURRENT_PUBLIC_PAGE_BODY_SENTINEL';
    const rawQuery = 'latest private-looking project query';
    const citationId = 'web-test-run-citation-1';
    const projection = {
      version: 1 as const,
      providerId: 'fixture',
      generatedAt: '2026-08-29T00:00:00.000Z',
      citationIds: [citationId],
      citationCount: 1,
      documentCount: 0,
      cached: false,
      partial: false,
      truncated: false,
      blocked: false,
      stale: false,
      completeness: 'complete' as const,
      citations: [{
        id: citationId,
        url: 'https://example.com/',
        origin: 'https://example.com',
        urlHash: 'a'.repeat(64),
        provider: 'fixture',
        fetchedAt: '2026-08-29T00:00:00.000Z',
        status: 'search_result' as const,
        truncated: false,
      }],
    };
    const webTool: AgentTool = {
      name: 'web_search',
      description: 'fixture web search',
      inputSchema: z.object({ query: z.string() }).strict(),
      persistence: {
        projectInput(input) {
          const query = String((input as { query?: unknown }).query ?? '');
          return { queryHash: `hash:${query.length}`, queryChars: query.length, sensitiveQuery: false };
        },
      },
      async execute() {
        return {
          callId: '',
          ok: true,
          output: JSON.stringify({ kind: 'web_search', citationIds: [citationId] }),
          modelOutput: {
            kind: 'web_search_results',
            externalUntrusted: true,
            results: [{ citationId, snippet: pageBody }],
          },
          webEvidence: projection,
        };
      },
    };
    const events: ToolStreamEvent[] = [];
    let webReplyAttempts = 0;
    const llm = createMockLlm((request) => {
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      if (!toolMessage) {
        return toolCallResponse([{ id: 'web-call-1', name: 'web_search', args: { query: rawQuery } }]);
      }
      expect(String(toolMessage.content)).toContain(pageBody);
      expect(String(toolMessage.content)).toContain('externalUntrusted');
      webReplyAttempts += 1;
      if (webReplyAttempts === 1) return textResponse('citation missing on first attempt');
      return textResponse(`citation-backed result [citation:${citationId}]`);
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [webTool],
      inbound: textMessage('user', '查最新公开资料'),
      toolContext: {
        permissionMode: 'restricted',
        networkPolicy: {
          version: 1,
          enabled: true,
          providerId: 'fixture',
          mode: 'public_anonymous',
          allowDomains: [],
          blockDomains: [],
          strictReadApproval: false,
          maxResults: 10,
          maxQueryChars: 2_000,
          maxQueriesPerRun: 4,
          maxFetchesPerRun: 4,
          maxConcurrentRequests: 4,
          searchTimeoutMs: 15_000,
          fetchTimeoutMs: 20_000,
          totalTimeoutMs: 90_000,
          maxResponseBytes: 2 * 1024 * 1024,
          maxExtractedChars: 40_000,
          maxRedirects: 5,
          cacheEnabled: true,
          cacheTtlSeconds: 300,
          cacheMaxBytes: 64 * 1024 * 1024,
          browserFallback: 'approval_required',
          sensitiveQueryPolicy: 'approve',
        },
      },
      taskBook: {
        assessment: {
          userNeed: '查最新公开资料', complexity: 'trivial', goal: '查证公开资料',
          successCriteria: ['返回有引用的结论'], requiresTaskBook: false, maxExtraScopeRatio: 1,
        },
        goal: '查证公开资料', complexity: 'trivial', successCriteria: ['返回有引用的结论'],
        steps: [{ id: 'web-step', description: '搜索公开资料', tools: ['web_search'] }],
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: '只返回查证结果' },
      },
    });
    ctx.onToolEvent = (event) => events.push(event);
    const onAssistantReplace = vi.fn();
    ctx.onAssistantReplace = onAssistantReplace;

    const result = await stage(ctx);

    expect(result).toMatchObject({ ok: true, next: 'verify' });
    expect(ctx.reply).toBe(`citation-backed result [citation:${citationId}]`);
    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(onAssistantReplace).toHaveBeenCalledTimes(1);
    expect(onAssistantReplace).toHaveBeenCalledWith('');
    expect(ctx.webEvidence).toEqual(projection);
    expect(ctx.toolResults?.[0]).not.toHaveProperty('modelOutput');
    const durableState = JSON.stringify({
      produced: ctx.produced,
      toolResults: ctx.toolResults,
      taskExecution: ctx.taskExecution,
      toolInvocations: ctx.toolInvocations,
      events,
    });
    expect(durableState).not.toContain(pageBody);
    expect(durableState).not.toContain(rawQuery);
    expect(durableState).toContain(citationId);
    expect(durableState).toContain('queryHash');
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
    expect(allText(finalRequest)).toContain('Follow progressive disclosure');
    expect(allText(finalRequest)).toContain('Never hide failed or partial steps');
    expect(allText(finalRequest)).toContain('Do not dump raw command output or private chain-of-thought');
    expect(allText(finalRequest)).toContain('SOUL_SENTINEL_USER_FACING_VOICE');
    expect(events.filter((event) => event.type !== 'model_activity').map((evt) => evt.type)).toEqual([
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
      const system = allText(request);
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
      const system = allText(request);
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
      const system = allText(request);
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
    expect(events.filter((event) => event.type !== 'model_activity').map((event) => event.type)).toEqual([
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

  it('routes a model user-input request to ask_user instead of executing a tool', async () => {
    const llm = createMockLlm(toolCallResponse([{
      id: 'q1',
      name: 'request_user_input',
      args: { field: 'targetFile', prompt: '要改哪个文件？', required: true },
    }]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', '帮我改一下那个文件') });

    const res = await stage(ctx);

    // The model's own question becomes the turn's clarification; nothing is
    // executed and no tool result is fabricated for it.
    expect(res.next).toBe('ask_user');
    expect(res.ok).toBe(true);
    expect(ctx.clarificationRequest?.copySource).toBe('model');
    expect(ctx.clarificationRequest?.questions[0]).toMatchObject({
      field: 'targetFile',
      prompt: '要改哪个文件？',
      required: true,
    });
    expect(ctx.toolResults ?? []).toHaveLength(0);
  });

  it('rejects a user input request mixed with other tool calls', async () => {
    const tool = makeTool('lookup', { ok: true, output: 'unused' });
    const llm = createMockLlm(toolCallResponse([
      { id: 'q1', name: 'request_user_input', args: { field: 'target', prompt: '哪个？' } },
      { id: 'c1', name: 'lookup', args: { q: 'x' } },
    ]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', '改一下') });

    const res = await stage(ctx);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/standalone tool call/);
    expect(tool.calls).toHaveLength(0);
  });

  it('keeps every tool-loop round a strict extension of the previous request', async () => {
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const requests: import('@littlesheep/llm').ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return requests.length === 1
        ? toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }])
        : textResponse('final answer');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'lookup x'),
      history: [
        textMessage('user', '第一个历史问题'),
        textMessage('assistant', '第一个历史回答'),
        textMessage('user', '第二个历史问题'),
        textMessage('assistant', '第二个历史回答'),
      ],
    });

    const res = await stage(ctx);

    expect(res.next).toBe('verify');
    expect(requests).toHaveLength(2);
    const first = requests[0]!;
    const second = requests[1]!;
    // A Provider prefix cache only matches from token 0, so every later round of
    // the same step must repeat the stable head of the earlier request unchanged
    // (system + history + current request) and only append after it. Dropping
    // older history here would diverge the second message and forfeit the whole
    // cached prefix; only the re-injected volatile runtime tail may differ.
    let volatileTail = 0;
    while (
      volatileTail < first.messages.length - 1
      && first.messages[first.messages.length - 1 - volatileTail]!.role === 'system'
    ) {
      volatileTail += 1;
    }
    const stableHead = first.messages.slice(0, first.messages.length - volatileTail);
    expect(stableHead.length).toBeGreaterThan(1);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    expect(second.messages.slice(0, stableHead.length)).toEqual(stableHead);
    expect(second.messages.some((message) => String(message.content).includes('第一个历史问题'))).toBe(true);
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

  it('restores the no-progress latch and disables tools on the first resumed turn', async () => {
    const llm = createMockLlm((request) => request.tools
      ? toolCallResponse([{ id: 'unexpected', name: 'lookup', args: {} }])
      : textResponse('resumed bounded final answer'));
    const tool = makeTool('lookup', { ok: true, output: 'x' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'loop') });
    ctx.loopBudget = {
      attemptsUsed: 3,
      maxAttempts: 64,
      elapsedMs: 1_000,
      maxElapsedMs: 0,
      noProgressRounds: 2,
      maxNoProgressRounds: 2,
      toolLoopIterationsUsed: 3,
      maxToolLoopIterations: 20,
      evidenceFingerprints: ['a'.repeat(64)],
      evidenceFingerprintSaturated: true,
    };

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(tool.calls).toHaveLength(0);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect((llm.chat.mock.calls[0]?.[0] as import('@littlesheep/llm').ChatRequest).tools).toBeUndefined();
    expect(ctx.loopBudget.toolLoopIterationsUsed).toBe(4);
  });

  it('does not reset the persisted twenty-turn budget after recovery', async () => {
    const llm = createMockLlm(textResponse('must not run'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'loop') });
    ctx.loopBudget = {
      attemptsUsed: 20,
      maxAttempts: 64,
      elapsedMs: 1_000,
      maxElapsedMs: 0,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
      toolLoopIterationsUsed: 20,
      maxToolLoopIterations: 20,
    };

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'recover', ok: false });
    expect(result.error).toContain('persisted 20-iteration run budget');
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('treats identical content from different Runtime resources as distinct evidence', async () => {
    let turn = 0;
    const llm = createMockLlm((request) => {
      turn += 1;
      if (turn <= 2) {
        return toolCallResponse([{
          id: `read-${turn}`,
          name: 'read_resource',
          args: { path: turn === 1 ? 'a.txt' : 'b.txt' },
        }]);
      }
      return textResponse('both resources checked');
    });
    const tool = makeTool('read_resource', { ok: true, output: 'same contents' });
    tool.execution = {
      concurrency: 'parallel',
      resources: (input) => [{
        key: `workspace:${String((input as { path?: unknown }).path)}`,
        mode: 'read',
      }],
    };
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', '读取 a.txt 和 b.txt') });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(tool.calls).toHaveLength(2);
    expect((llm.chat.mock.calls[2]?.[0] as import('@littlesheep/llm').ChatRequest).tools).toBeDefined();
    expect(ctx.loopBudget?.noProgressRounds).toBe(0);
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
    const settlements: Array<{ status?: string }> = [];
    ctx.appendDurableEvent = vi.fn(async (event) => {
      if (event.type === 'effect_settled') settlements.push(event.payload as { status?: string });
    });

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(tool.calls).toHaveLength(0);
    expect(ctx.toolResults?.[0]?.error).toContain('until its checkpoint is durable');
    expect(ctx.sideEffects?.[0]?.status).toBe('failed');
    expect(settlements).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      toolName: 'mutate',
      toolSource: 'plugin:test-mutation',
      status: 'failed',
      errorKind: 'checkpoint_before_effect',
    });
  });

  it('keeps an invoked effect unknown when the tool returns a non-success result', async () => {
    const tool = makeTool('mutate', { ok: false, error: 'partial mutation failure' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'failed-effect-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('effect result unknown'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    const settlements: Array<{ status?: string }> = [];
    ctx.appendDurableEvent = vi.fn(async (event) => {
      if (event.type === 'effect_settled') settlements.push(event.payload as { status?: string });
    });

    await stage(ctx);

    expect(tool.calls).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'unknown', toolName: 'mutate' });
    expect(settlements).toEqual([expect.objectContaining({ status: 'unknown' })]);
  });

  it('records effect ownership in the intent and releases it only after durable settlement', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'mutation completed' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'owned-effect-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('effect completed'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    const lifecycle: string[] = [];
    const durablePayloads: Array<Record<string, unknown>> = [];
    ctx.effectLeases = {
      acquire: vi.fn(async () => ({
        kind: 'acquired' as const,
        ownerId: 'a'.repeat(64),
        leaseUntil: '2026-09-10T01:00:00.000Z',
      })),
      confirm: vi.fn(async () => ({ ownerId: 'a'.repeat(64), leaseUntil: '2026-09-10T01:00:01.000Z' })),
      release: vi.fn(async () => { lifecycle.push('release'); }),
    };
    ctx.appendDurableEvent = vi.fn(async (event) => {
      lifecycle.push(event.type);
      durablePayloads.push(event.payload);
    });

    await stage(ctx);

    expect(tool.calls).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({
      status: 'succeeded',
      ownerId: 'a'.repeat(64),
      leaseUntil: '2026-09-10T01:00:01.000Z',
    });
    expect(durablePayloads.find((payload) => payload.effectId)).toMatchObject({
      ownerId: 'a'.repeat(64),
      leaseUntil: '2026-09-10T01:00:00.000Z',
    });
    expect(durablePayloads.find((payload) => payload.status === 'succeeded')).toMatchObject({
      ownerId: 'a'.repeat(64),
      leaseUntil: '2026-09-10T01:00:01.000Z',
    });
    expect(lifecycle.indexOf('release')).toBeGreaterThan(lifecycle.indexOf('effect_settled'));
    expect(ctx.effectLeases.release).toHaveBeenCalledTimes(1);
  });

  it('does not invoke an effect when another worker owns its lease', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'must not run' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'conflicted-effect-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('effect lease conflict'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    ctx.effectLeases = {
      acquire: vi.fn(async () => ({ kind: 'conflict' as const, leaseUntil: '2026-09-10T01:00:00.000Z' })),
      confirm: vi.fn(),
      release: vi.fn(),
    };
    ctx.appendDurableEvent = vi.fn();

    await stage(ctx);

    expect(tool.calls).toHaveLength(0);
    expect(ctx.appendDurableEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'effect_intent_created' }));
    expect(ctx.toolInvocations?.[0]).toMatchObject({ status: 'failed', errorKind: 'side_effect_blocked' });
    expect(ctx.toolResults?.[0]?.error).toContain('owned by another worker');
  });

  it('refuses to settle a completed effect after its ownership fence is lost', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'mutation completed' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'lost-effect-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('effect owner lost'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    ctx.effectLeases = {
      acquire: vi.fn(async () => ({
        kind: 'acquired' as const,
        ownerId: 'a'.repeat(64),
        leaseUntil: '2026-09-10T01:00:00.000Z',
      })),
      confirm: vi.fn(async () => { throw new Error('ownership changed'); }),
      release: vi.fn(),
    };
    const durableEvents: string[] = [];
    ctx.appendDurableEvent = vi.fn(async (event) => { durableEvents.push(event.type); });

    await stage(ctx);

    expect(tool.calls).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'unknown', error: expect.stringContaining('ownership changed') });
    expect(durableEvents).toContain('effect_intent_created');
    expect(durableEvents).not.toContain('effect_settled');
    expect(ctx.toolInvocations?.[0]).toMatchObject({ status: 'failed', errorKind: 'effect_settlement_persistence' });
    expect(ctx.effectLeases.release).not.toHaveBeenCalled();
  });

  it('settles a pre-invocation abort as cancelled without invoking the effectful tool', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'must not run' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'aborted-effect-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('aborted before mutation'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate safely') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    const controller = new AbortController();
    ctx.signal = controller.signal;
    controller.abort();
    const settlements: Array<{ status?: string }> = [];
    ctx.appendDurableEvent = vi.fn(async (event) => {
      if (event.type === 'effect_settled') settlements.push(event.payload as { status?: string });
    });

    await stage(ctx);

    expect(tool.calls).toHaveLength(0);
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'cancelled', toolName: 'mutate' });
    expect(settlements).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      status: 'aborted',
      errorKind: 'run_aborted_before_effect',
    });
  });

  it('does not invoke an effectful tool when intent durability is ambiguous', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'must not run' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'intent-failure-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('intent durability failed'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const durableEvents: string[] = [];
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate safely') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    ctx.appendDurableEvent = vi.fn(async (event) => {
      durableEvents.push(event.type);
      if (event.type === 'effect_intent_created') throw new Error('event store unavailable');
    });

    await stage(ctx);

    expect(tool.calls).toHaveLength(0);
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'unknown', toolName: 'mutate' });
    expect(durableEvents).toContain('effect_intent_created');
    expect(durableEvents).not.toContain('effect_settled');
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      status: 'failed',
      errorKind: 'effect_intent_persistence',
    });
  });

  it('keeps an effect unknown when settlement durability is ambiguous and never appends a compensating settlement', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'mutation completed' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'settlement-failure-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('settlement durability failed'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const durableEvents: string[] = [];
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate safely') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    ctx.appendDurableEvent = vi.fn(async (event) => {
      durableEvents.push(event.type);
      if (event.type === 'effect_settled') throw new Error('settlement store unavailable');
    });

    await stage(ctx);

    expect(tool.calls).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'unknown', toolName: 'mutate' });
    expect(durableEvents.filter((type) => type === 'effect_settled')).toHaveLength(1);
    expect(ctx.toolResults?.[0]?.error).toContain('not durably settled');
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      status: 'failed',
      errorKind: 'effect_settlement_persistence',
    });
  });

  it('preserves a durable effect settlement when the post-effect checkpoint fails', async () => {
    const tool = makeTool('mutate', { ok: true, output: 'mutation completed' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'checkpoint-after-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('checkpoint failed after the mutation'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const durableEvents: string[] = [];
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'mutate safely') });
    ctx.toolSources = { mutate: 'plugin:test-mutation' };
    ctx.appendDurableEvent = vi.fn(async (event) => { durableEvents.push(event.type); });
    let checkpointCalls = 0;
    ctx.persistRuntimeCheckpoint = vi.fn(async () => {
      checkpointCalls += 1;
      if (checkpointCalls === 2) throw new Error('checkpoint store unavailable');
      return `checkpoint-${checkpointCalls}`;
    });

    await stage(ctx);

    expect(tool.calls).toHaveLength(1);
    expect(checkpointCalls).toBe(2);
    expect(durableEvents.filter((type) => type === 'effect_settled')).toHaveLength(1);
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'succeeded', toolName: 'mutate' });
    expect(ctx.toolResults?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('checkpoint persistence failed'),
      meta: { effectSettlement: 'durable', checkpointPersistence: 'failed' },
    });
    expect(ctx.toolInvocations?.[0]).toMatchObject({
      status: 'failed',
      errorKind: 'checkpoint_after_effect',
    });
  });
});
