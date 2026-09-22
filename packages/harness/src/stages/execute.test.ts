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
  it('bridges OpenAI format → internal {id, name, input, rawArguments}', () => {
    const tc = convertToolCall({
      id: 'call_1', type: 'function',
      function: { name: 'read', arguments: '{"file_path":"/x"}' },
    });
    // The raw argument string travels with the call so a later run can replay the
    // exact assistant message instead of re-serializing the parsed object.
    expect(tc).toEqual({
      id: 'call_1',
      name: 'read',
      input: { file_path: '/x' },
      rawArguments: '{"file_path":"/x"}',
    });
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
      systemPrompts.push(allText(request));
      return textResponse('done');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'inspect the repository') });
    ctx.profilePromptAddon = 'PROFILE_SENTINEL_EXECUTE';

    await stage(ctx);

    expect(systemPrompts[0]).toContain('PROFILE_SENTINEL_EXECUTE');
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
      // The named tool narrows the *execution* scope only: the catalog the
      // provider sees is still the session's registered set.
      expect(request.tools?.map((tool) => tool.function.name)).toEqual(['glob', 'read']);
      expect(request.messages.some((message) => String(message.content).includes('continuity-history-anchor'))).toBe(true);
    }
    expect(glob.calls).toHaveLength(1);
    expect(read.calls).toHaveLength(0);
  });


  it('streams thinking and per-turn prose into the ordered model transcript', async () => {
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
    // The model-facing result carries action-able fields only: `status` and
    // `durationMs` were framing text (20% of all tool-result characters measured).
    expect(JSON.parse(String(toolMessage?.content))).toEqual({
      ok: true,
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
      // A compliant model reads the Runtime control message and answers; the mock
      // does the same instead of relying on `tool_choice: 'none'`, which made the
      // provider render the prompt without the tool catalog and lose the cache.
      const forced = request.messages.some((message) => typeof message.content === 'string'
        && message.content.includes('no new evidence'));
      if (!request.tools || forced) return textResponse('bounded final answer');
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
    // The forced turn keeps the tool list *and* `auto`: the provider renders the
    // prompt without the catalog under `none`, which cost 1.8k-2.0k prompt tokens
    // and the cached prefix on every forced request of the real-long-task runs.
    expect(finalRequest.tools).toBeDefined();
    expect(finalRequest.tool_choice).toBe('auto');
    expect(finalRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('no new evidence'),
      }),
    ]));
  });

  it('restores the no-progress latch and refuses tools on the first resumed turn', async () => {
    const llm = createMockLlm((request) => (request.tools && !request.messages.some((message) => (
      typeof message.content === 'string' && message.content.includes('no new evidence')
    ))
      ? toolCallResponse([{ id: 'unexpected', name: 'lookup', args: {} }])
      : textResponse('resumed bounded final answer')));
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
    const resumedRequest = llm.chat.mock.calls[0]?.[0] as import('@littlesheep/llm').ChatRequest;
    // Same contract as the forced turn: the tool list and `auto` stay (so the prefix
    // is unchanged) and the model is told the tools are unavailable.
    expect(resumedRequest.tools).toBeDefined();
    expect(resumedRequest.tool_choice).toBe('auto');
    expect(resumedRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('no new evidence'),
      }),
    ]));
    expect(ctx.loopBudget.toolLoopIterationsUsed).toBe(4);
  });

  it('refuses a tool call that ignores the forced final answer instead of failing the run', async () => {
    const llm = createMockLlm((request) => {
      const forced = request.messages.some((message) => typeof message.content === 'string'
        && (message.content.includes('no new evidence')
          || message.content.includes('tools are unavailable')));
      if (forced && request.messages.some((message) => typeof message.content === 'string'
        && message.content.includes('tools are unavailable'))) {
        return textResponse('answered after refusal');
      }
      return toolCallResponse([{ id: 'stubborn', name: 'lookup', args: {} }]);
    });
    const tool = makeTool('lookup', { ok: true, output: 'x' });
    tool.execution = {
      concurrency: 'parallel',
      resources: () => [{ key: 'probe:lookup', mode: 'read' }],
    };
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

    // The call is denied, nothing runs, and the run still produces its answer.
    expect(result).toMatchObject({ next: 'verify', ok: true });
    expect(tool.calls).toHaveLength(0);
    expect(ctx.reply).toBe('answered after refusal');
   expect(ctx.toolResults?.some((entry) => entry.error?.includes('tools are unavailable'))).toBe(true);
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

  // Runtime tail sections are also persisted now (they sit in the request the
  // Provider caches, and a later run replays them). They are not conversation, so
  // these assertions look at the tool-round messages only.
  const conversational = (produced: RunContext['produced']) => produced.filter((message) => message.runtimeTail !== true);

  it('stop → ctx.produced 无 tool 消息', async () => {
    const llm = createMockLlm(textResponse('done'));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'go') });
    await stage(ctx);
    expect(conversational(ctx.produced)).toEqual([]);
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
    const produced = conversational(ctx.produced);
    expect(produced).toHaveLength(2);
    expect(produced[0]!.role).toBe('assistant');
    expect(produced[0]!.content[0]!.type).toBe('tool_calls');
    expect(produced[1]!.role).toBe('tool');
    expect(produced[1]!.content[0]!.type).toBe('tool_result');
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
    const produced = conversational(ctx.produced);
    expect(produced).toHaveLength(3); // 1 assistant + 2 tool
    expect(produced[0]!.role).toBe('assistant');
    expect(produced[0]!.content[0]!.type).toBe('tool_calls');
    expect(produced[1]!.role).toBe('tool');
    expect(produced[2]!.role).toBe('tool');
  });

  it('未知工具 → ctx.produced 含 tool_result(ok=false)', async () => {
    const llm = createMockLlm([
      toolCallResponse([{ id: 'c1', name: 'nope', args: {} }]),
      textResponse('recovered'),
    ]);
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'x') });
    await stage(ctx);
    const produced = conversational(ctx.produced);
    expect(produced).toHaveLength(2);
    const toolMsg = produced[1]!;
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

  it('settles a determinate tool failure as failed so the run can continue', async () => {
    const tool = makeTool('mutate', { ok: false, error: 'partial mutation failure' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'failed-effect-call', name: 'mutate', args: { value: 'x' } }]),
      textResponse('effect result failed'),
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
    // A known non-zero outcome is settled, not ambiguous: reporting it as
    // unknown stopped the whole run and prevented reaction to a failed command.
    expect(ctx.sideEffects?.[0]).toMatchObject({ status: 'failed', toolName: 'mutate' });
    expect(settlements).toEqual([expect.objectContaining({ status: 'failed' })]);
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
