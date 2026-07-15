import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { makeCtx, makeTool } from './tests/helpers.js';
import {
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
  prepareModelRequest,
  recordModelRequest,
  recordProviderUsage,
} from './model-observability.js';

function request(messageCount = 2, toolCount = 1): ChatRequest {
  const messages: ChatRequest['messages'] = Array.from({ length: messageCount }, (_, index) => ({
    role: index === 0 ? 'system' : index === messageCount - 1 ? 'user' : 'assistant',
    content: index === messageCount - 1
      ? [
          { type: 'text' as const, text: `USER_SECRET_${index}` },
          {
            type: 'image_url' as const,
            image_url: { url: 'data:image/png;base64,IMAGE_SECRET_BYTES', detail: 'auto' as const },
          },
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
  it('records a frozen request/context shape without prompt text or image bytes', () => {
    const ctx = makeCtx({ tools: registeredTools(1) });
    const snapshot = recordModelRequest(ctx, 'execute_tool_loop', request());
    const serialized = JSON.stringify({ snapshot, contexts: ctx.contextSnapshots });

    expect(snapshot).toMatchObject({
      stage: 'execute',
      requestIndex: 1,
      provider: 'openai',
      model: 'gpt-test',
      totalMessageCount: 2,
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
    const oversized = recordModelRequest(ctx, 'execute_tool_loop', request(70, 70));

    expect(oversized.messages).toHaveLength(MAX_SNAPSHOT_MESSAGES);
    expect(oversized.totalMessageCount).toBe(70);
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

    const prepared = prepareModelRequest(ctx, 'execute_tool_loop', {
      ...request(),
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
      accuracy: 'unavailable',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      reason: expect.stringContaining('has not verified a client-side counter'),
    });
  });

  it('fails closed for forbidden tools, forbidden calls, and oversized outputs', () => {
    const ctx = makeCtx({ tools: registeredTools(1) });

    expect(() => prepareModelRequest(ctx, 'reply', request())).toThrow(/forbids tools/);
    expect(() => prepareModelRequest(ctx, 'finalize', request(2, 0))).toThrow(/without another model request/);
    expect(() => prepareModelRequest(ctx, 'classify', {
      ...request(2, 0),
      max_tokens: 257,
    })).toThrow(/exceeds budget 256/);
    expect(ctx.modelRequests).toBeUndefined();
    expect(ctx.contextSnapshots).toBeUndefined();
  });
});
