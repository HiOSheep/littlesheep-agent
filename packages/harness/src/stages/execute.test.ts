// @littlesheep/harness — stages/execute.test.ts
import { describe, it, expect } from 'vitest';
import { createExecuteStage, convertToolCall } from './execute.js';
import {
  createMockLlm, textResponse, toolCallResponse, makeCtx, makeTool,
} from '../tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';
import type { TaskBook, ToolStreamEvent } from '@littlesheep/types';

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

  it('includes taskBook goal, success criteria, and overdelivery limit in the execution prompt', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((req) => {
      systemPrompts.push(String(req.messages[0]?.content ?? ''));
      return textResponse('done');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      inbound: textMessage('user', 'review the core'),
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
    expect(events.map((evt) => evt.type)).toEqual([
      'step_start',
      'tool_start',
      'tool_end',
      'step_done',
      'step_start',
      'step_done',
    ]);
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

  it('loop exceeds 20 iterations → recover', async () => {
    // Always returns a tool_call — never stops.
    const llm = createMockLlm(() => toolCallResponse([{ id: 'c', name: 'lookup', args: {} }]));
    const tool = makeTool('lookup', { ok: true, output: 'x' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'loop') });
    const res = await stage(ctx);
    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeded 20/);
    expect(ctx.lastError?.stage).toBe('execute');
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
});
