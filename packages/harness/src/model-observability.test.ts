import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmClient } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import type { ToolStreamEvent } from '@littlesheep/types';
import { makeCtx, makeTool } from './tests/helpers.js';
import {
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
  bindExactContextTokenCounter,
  callModelChat,
  callModelChatStream,
  preferDirectModelOutput,
  prepareModelRequest,
  recordModelRequest,
  recordProviderUsage,
} from './model-observability.js';

function request(messageCount = 2, toolCount = 1, includeImage = true): ChatRequest {
  const messages: ChatRequest['messages'] = Array.from({ length: messageCount }, (_, index) => ({
    role: index === 0 ? 'system' : index === messageCount - 1 ? 'user' : 'assistant',
    content: index === messageCount - 1
      ? [
          { type: 'text' as const, text: `USER_SECRET_${index}` },
          ...(includeImage ? [{
            type: 'image_url' as const,
            image_url: { url: 'data:image/png;base64,IMAGE_SECRET_BYTES', detail: 'auto' as const },
          }] : []),
        ]
      : `PROMPT_SECRET_${index}`,
  }));
  return {
    model: 'openai/gpt-test',
    messages,
    tools: Array.from({ length: toolCount }, (_, index) => ({
      type: 'function' as const,
      function: {
        name: `tool-${index}`,
        description: `TOOL_SCHEMA_SECRET_${index}`,
        parameters: { type: 'object', properties: { secret: { const: `VALUE_SECRET_${index}` } } },
      },
    })),
    tool_choice: 'auto',
    temperature: 0,
    max_tokens: 900,
    stream: true,
  };
}

function registeredTools(count: number) {
  return Array.from({ length: count }, (_, index) => makeTool(`tool-${index}`, {
    ok: true,
    output: 'ok',
  }));
}

describe('recordModelRequest', () => {
  it('HA-04-06 projects the first fully prepared request prompt, not an earlier base prompt', () => {
    const events: import('@littlesheep/types').ToolStreamEvent[] = [];
    const ctx = makeCtx();
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => events.push(event);
    const prepared = prepareModelRequest(ctx, 'reply', request(2, 0));
    const effectivePrompt = prepared.messages
      .filter((message) => message.role === 'system')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n\n');

    expect(ctx.systemPromptProjection).toBe(effectivePrompt);
    expect(events.filter((event) => event.type === 'system_prompt')).toEqual([
      expect.objectContaining({
        phaseId: `system-prompt:${ctx.modelRequests?.[0]?.id}`,
        description: 'reply',
        summary: effectivePrompt,
      }),
    ]);
  });

  it('records a frozen request/context shape without prompt text or image bytes', () => {
    const ctx = makeCtx({ tools: registeredTools(1) });
    const snapshot = recordModelRequest(ctx, 'execute_tool_loop', request());
    const serialized = JSON.stringify({ snapshot, contexts: ctx.contextSnapshots });

    expect(snapshot).toMatchObject({
      stage: 'execute',
      requestIndex: 1,
      provider: 'openai',
      model: 'gpt-test',
      // system + user + the stable capability facts + the environment brief.
      totalMessageCount: 4,
      totalToolCount: 1,
      stream: true,
      callContract: {
        id: 'core-flow/execute_tool_loop@1',
        purpose: 'execute_tool_loop',
      },
    });
    expect(snapshot.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ctx.contextSnapshots?.[0]?.budget).toMatchObject({ status: 'unknown' });
    expect(ctx.contextSnapshots?.[0]?.localTokenLedger).toMatchObject({
      source: 'local',
      accuracy: 'unavailable',
    });
    expect(serialized).not.toContain('PROMPT_SECRET');
    expect(serialized).not.toContain('USER_SECRET');
    expect(serialized).not.toContain('IMAGE_SECRET_BYTES');
    expect(serialized).not.toContain('TOOL_SCHEMA_SECRET');
    expect(serialized).not.toContain('VALUE_SECRET');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(ctx.contextSnapshots?.[0])).toBe(true);
  });

  it('caps message, item, tool, and per-run snapshot collections', () => {
    const ctx = makeCtx({ tools: registeredTools(70) });
    const oversized = recordModelRequest(ctx, 'execute_tool_loop', request(70, 70, false));

    expect(oversized.messages).toHaveLength(MAX_SNAPSHOT_MESSAGES);
    // 70 supplied messages plus the stable capability facts and the environment
    // brief (this run has no task state, so there is no trailing volatile block).
    expect(oversized.totalMessageCount).toBe(72);
    expect(oversized.messagesTruncated).toBe(true);
    expect(oversized.toolNames).toHaveLength(MAX_SNAPSHOT_TOOLS);
    expect(oversized.totalToolCount).toBe(70);
    expect(oversized.toolsTruncated).toBe(true);
    expect(ctx.contextSnapshots?.[0]?.items).toHaveLength(MAX_SNAPSHOT_ITEMS);
    expect(ctx.contextSnapshots?.[0]?.itemsTruncated).toBe(true);

    for (let index = 1; index < 70; index++) {
      recordModelRequest(ctx, 'reply', request(2, 0));
    }
    expect(ctx.modelRequests).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(ctx.contextSnapshots).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(ctx.modelRequests?.[0]?.requestIndex).toBe(7);
    expect(ctx.modelRequests?.at(-1)?.requestIndex).toBe(70);
  });

  it('binds provider usage to the exact prepared Context snapshot', () => {
    const ctx = makeCtx();
    const first = prepareModelRequest(ctx, 'decide', request(2, 0));
    const second = prepareModelRequest(ctx, 'reply', request(2, 0));

    recordProviderUsage(ctx, first, {
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedPromptTokens: 40,
      reasoningTokens: 12,
    });

    expect(ctx.contextSnapshots?.[0]?.providerUsage).toMatchObject({
      source: 'provider',
      provider: 'openai',
      model: 'gpt-test',
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedPromptTokens: 40,
      reasoningTokens: 12,
    });
    expect(ctx.contextSnapshots?.[1]?.providerUsage).toBeUndefined();
    expect(ctx.modelRequests?.map((snapshot) => snapshot.callContract?.purpose)).toEqual([
      'decide',
      'reply',
    ]);
    expect(ctx.modelRequests?.[0]?.callContract?.memoryIntentPolicy.allowed).toEqual(['read', 'none']);
    expect(ctx.modelRequests?.[1]?.callContract?.outputSchema.schemaId).toBe('chat-reply.v1');
    expect(ctx.modelRequests?.[0]?.callContract).not.toBe(ctx.modelRequests?.[1]?.callContract);
    expect(Object.isFrozen(ctx.contextSnapshots?.[0])).toBe(true);

    recordProviderUsage(ctx, second, undefined);
    expect(ctx.contextSnapshots?.[1]?.providerUsage).toBeUndefined();
  });

  it('HA-03-05 accepts one usage callback per request and marks conflicts incomplete', () => {
    const ctx = makeCtx();
    const prepared = prepareModelRequest(ctx, 'reply', request(2, 0));
    const usage = {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 50,
      durationMs: 1_000,
      transportAttempt: 1,
      observedAttemptCount: 1,
    };

    recordProviderUsage(ctx, prepared, usage);
    recordProviderUsage(ctx, prepared, usage);
    expect(ctx.usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      requestCount: 1,
      usageReportedRequestCount: 1,
      usageCompleteness: 'complete',
    });

    recordProviderUsage(ctx, prepared, { ...usage, completionTokens: 21, totalTokens: 121 });
    expect(ctx.usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      requestCount: 1,
      usageReportedRequestCount: 1,
      usageCompleteness: 'partial',
    });
  });

  it('applies model-specific reasoning controls before Context snapshotting', () => {
    const ctx = makeCtx({ tools: registeredTools(1) });
    ctx.resolvedRunConfig = {
      version: 1,
      runId: ctx.runId,
      resolvedAt: '2026-07-13T00:00:00.000Z',
      origin: 'test',
      behaviorModeId: 'general',
      permissionPolicyId: 'research',
      workflowStrategyId: 'core-flow',
      contextStrategyId: 'context-v1',
      memoryStrategyId: 'index-first-v1',
      toolSelectionStrategyId: 'registered-tools-v1',
      outputContractId: 'user-reply-v1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning: 'ultra',
      parameters: {},
      availableToolNames: [],
      approvalRequiredToolNames: [],
      userOverrides: {},
      projectOverrides: {},
    };

    bindExactContextTokenCounter(ctx, {
      id: 'deepseek-v4-provider-calibrated-tokenizer-v2',
      supports: (provider, model) => provider === 'deepseek' && model === 'deepseek-v4-pro',
      countRequest: () => 120,
    });

    const prepared = prepareModelRequest(ctx, 'execute_tool_loop', {
      ...request(2, 1, false),
      model: 'deepseek-v4-pro',
      temperature: 0,
    });

    expect(prepared.reasoning_effort).toBe('max');
    expect(prepared.thinking).toEqual({ type: 'enabled', clear_thinking: undefined });
    expect(prepared.temperature).toBeUndefined();
    expect(ctx.modelRequests?.[0]).toMatchObject({
      reasoningEffort: 'max',
      thinkingMode: 'enabled',
    });
    expect(ctx.contextSnapshots?.[0]?.localTokenLedger).toMatchObject({
      accuracy: 'exact',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      tokenizerId: 'deepseek-v4-provider-calibrated-tokenizer-v2',
      promptTokens: 120,
    });

    recordProviderUsage(ctx, prepared, { promptTokens: 120, completionTokens: 8 });
    expect(ctx.contextSnapshots?.[0]?.providerUsage?.localCalibration).toEqual({
      version: 1,
      tokenizerId: 'deepseek-v4-provider-calibrated-tokenizer-v2',
      localPromptTokens: 120,
      differenceTokens: 0,
      relativeDifference: 0,
      status: 'exact_match',
    });
  });

  it('makes the DeepSeek V4 auto path explicit before local token accounting', () => {
    const ctx = makeCtx();
    ctx.resolvedRunConfig = {
      version: 1,
      runId: ctx.runId,
      resolvedAt: '2026-07-13T00:00:00.000Z',
      origin: 'test',
      behaviorModeId: 'general',
      permissionPolicyId: 'research',
      workflowStrategyId: 'core-flow',
      contextStrategyId: 'context-v1',
      memoryStrategyId: 'index-first-v1',
      toolSelectionStrategyId: 'registered-tools-v1',
      outputContractId: 'user-reply-v1',
      provider: 'deepseek',
      // V4.1-served names no longer claim the calibrated V4 counter.
      model: 'deepseek-v4-pro',
      reasoning: 'auto',
      parameters: {},
      availableToolNames: [],
      approvalRequiredToolNames: [],
      userOverrides: {},
      projectOverrides: {},
    };
    bindExactContextTokenCounter(ctx, {
      id: 'deepseek-v4-provider-calibrated-tokenizer-v2',
      supports: (provider, model) => provider === 'deepseek' && model === 'deepseek-v4-pro',
      countRequest: (prepared) => {
        expect(prepared.thinking).toEqual({ type: 'disabled' });
        return 88;
      },
    });

    const prepared = prepareModelRequest(ctx, 'reply', {
      ...request(2, 0),
      model: 'deepseek-v4-pro',
    });

    expect(prepared.thinking).toEqual({ type: 'disabled' });
    expect(ctx.modelRequests?.[0]).toMatchObject({ thinkingMode: 'disabled' });
    expect(ctx.contextSnapshots?.[0]?.localTokenLedger).toMatchObject({
      accuracy: 'exact',
      promptTokens: 88,
    });
  });

  it('does not let a direct-output compatibility call override the run reasoning policy', () => {
    const ctx = makeCtx();
    ctx.resolvedRunConfig = {
      version: 1,
      runId: ctx.runId,
      resolvedAt: '2026-07-13T00:00:00.000Z',
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
      reasoning: 'ultra',
      parameters: {},
      availableToolNames: [],
      approvalRequiredToolNames: [],
      userOverrides: {},
      projectOverrides: {},
    };
    const direct = preferDirectModelOutput(ctx, {
      ...request(2, 0),
      model: 'deepseek-v4-flash',
      max_tokens: 500,
    });

    const prepared = prepareModelRequest(ctx, 'decide', direct);

    expect(prepared.reasoning_effort).toBe('max');
    expect(prepared.thinking).toEqual({ type: 'enabled', clear_thinking: undefined });
    expect(ctx.modelRequests?.[0]).toMatchObject({ reasoningEffort: 'max', thinkingMode: 'enabled' });
  });

  it('fails closed for forbidden tools, forbidden calls, and oversized outputs', () => {
    const ctx = makeCtx({ tools: registeredTools(1) });

    expect(() => prepareModelRequest(ctx, 'reply', request())).toThrow(/forbids tools/);
    expect(() => prepareModelRequest(ctx, 'finalize', request(2, 0))).toThrow(/without another model request/);
    expect(() => prepareModelRequest(ctx, 'classify', {
      ...request(2, 0),
      max_tokens: 257,
    })).toThrow(/exceeds budget 200/);
    expect(ctx.modelRequests).toBeUndefined();
    expect(ctx.contextSnapshots).toBeUndefined();
  });
});

/** UX-21: a retried Provider call must be visible while it is being retried. */
describe('transport retry visibility', () => {
  function retryingLlm(onRetry: (request: ChatRequest) => void, streaming: boolean): LlmClient {
    const response = { content: '结算正文', toolCalls: [], finishReason: 'stop' as const };
    return {
      chat: async (req: ChatRequest) => {
        onRetry(req);
        return response;
      },
      chatStream: async (req: ChatRequest, onDelta: (chunk: { type: 'reset' } | { type: 'delta'; delta: string }) => void) => {
        onRetry(req);
        onDelta({ type: 'reset' });
        onDelta({ type: 'delta', delta: '结算正文' });
        return response;
      },
    } as unknown as LlmClient;
  }

  const progress = {
    retry: 2,
    maxRetries: 5,
    delayMs: 2000,
    failureClass: 'rate_limited' as const,
    status: 429,
    error: new Error('HTTP 429'),
  };

  it('announces the retry on the request activity phase and keeps the caller request untouched', async () => {
    const events: ToolStreamEvent[] = [];
    const callerProgress: number[] = [];
    const ctx = makeCtx({ inbound: textMessage('user', '请重试刚才的请求') });
    ctx.onToolEvent = (event) => events.push(event);
    const prepared = prepareModelRequest(ctx, 'reply', request(2, 0));
    prepared.onTransportRetry = (info) => callerProgress.push(info.retry);

    await callModelChat(ctx, retryingLlm((req) => req.onTransportRetry?.(progress), false), prepared);

    const requestId = ctx.modelRequests?.[0]?.id;
    const summaries = events
      .filter((event) => event.type === 'model_activity')
      .map((event) => event.summary);
    expect(summaries).toEqual([
      '模型正在生成回复',
      '第 2 次重试 / 最多 5 次：Provider 限流（HTTP 429），2.0 秒后重发',
      '模型已完成：生成回复',
    ]);
    // One row per logical request: the retry reuses the request's own phase.
    expect(events.filter((event) => event.type === 'model_activity').map((event) => event.phaseId))
      .toEqual([`model-request:${requestId}`, `model-request:${requestId}`, `model-request:${requestId}`]);
    // The caller's own observer still runs, and the request object it owns is not rewritten.
    expect(callerProgress).toEqual([2]);
    expect(prepared.onTransportRetry).toBeInstanceOf(Function);
  });

  it('reports the retry on the streaming path too, before the streamed text restarts', async () => {
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx({ inbound: textMessage('user', '继续输出') });
    ctx.onToolEvent = (event) => events.push(event);
    const prepared = prepareModelRequest(ctx, 'reply', request(2, 0));
    const deltas: string[] = [];

    await callModelChatStream(
      ctx,
      retryingLlm((req) => req.onTransportRetry?.(progress), true),
      prepared,
      (chunk) => deltas.push(chunk.type),
    );

    const retry = events.find((event) => event.type === 'model_activity' && event.summary?.includes('次重试'));
    expect(retry).toMatchObject({ activityStatus: 'running', activityKind: 'model_request' });
    // The retry is announced before the preview is reset and re-streamed.
    expect(deltas).toEqual(['reset', 'delta']);
    expect(prepared.onTransportRetry).toBeUndefined();
  });
});
