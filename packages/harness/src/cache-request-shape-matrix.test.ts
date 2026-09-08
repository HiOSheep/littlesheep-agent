import { describe, expect, it } from 'vitest';
import type { ChatRequest, ToolSpec } from '@littlesheep/llm';
import {
  buildCacheObservation,
  canonicalSerialize,
  classifyProviderCacheUsage,
} from './cache-observability.js';

const tools: ToolSpec[] = [
  { type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'write', description: 'Write', parameters: { type: 'object' } } },
];

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'openai/gpt-test',
    messages: [
      {
        role: 'system',
        content: 'Stable policy v1\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=one',
      },
      { role: 'assistant', content: 'recent answer' },
      { role: 'user', content: 'current user message' },
    ],
    tools,
    stream: true,
    temperature: 0,
    max_tokens: 256,
    ...overrides,
  };
}

const promptComponents = {
  promptVersion: 'prompt-v1',
  systemPolicy: 'policy-v1',
  soul: 'soul-v1',
  userProfile: 'user-v1',
  memoryRevision: 'memory-v1',
  summary: 'summary-v1',
  locale: 'zh-HK/24',
} as const;

function observe(input: Partial<Parameters<typeof buildCacheObservation>[0]> = {}) {
  const req = input.request ?? request();
  const { request: _request, ...rest } = input;
  return buildCacheObservation({
    request: req,
    provider: 'openai',
    model: req.model,
    requestKind: 'reply',
    requestIndex: 1,
    modelRequestId: 'request-1',
    sessionId: 'session-a',
    workspaceScope: 'C:\\Work\\LittleSheep',
    permissionPolicyId: 'research',
    promptComponents,
    key: 'shape-matrix-key',
    ...rest,
  });
}

describe('CACHE-08 request shape and lifecycle matrix', () => {
  it('keeps repeated requests and cross-stage differences explainable', () => {
    const first = observe();
    const repeated = observe({ requestIndex: 2, modelRequestId: 'request-2' });
    expect(repeated.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(repeated.dynamicSuffix.fingerprint).toBe(first.dynamicSuffix.fingerprint);

    const otherMessage = observe({
      request: request({ messages: [
        { role: 'system', content: 'Stable policy v1\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=two' },
        { role: 'assistant', content: 'different recent answer' },
        { role: 'user', content: 'different user message' },
      ] }),
      previous: first,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(otherMessage.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(otherMessage.dynamicSuffix.fingerprint).not.toBe(first.dynamicSuffix.fingerprint);

    const otherStage = observe({
      requestKind: 'execute_tool_loop',
      previous: first,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(otherStage.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
    expect(otherStage.invalidationReasons).toContain('request_kind_changed');
  });

  it('records manual clear and replay without changing stable prefix bytes', () => {
    const first = observe();
    const cleared = observe({
      previous: first,
      manualClear: true,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(cleared.invalidationReasons).toContain('manual_clear');
    expect(cleared.primaryInvalidationReason).toBe('manual_clear');
    expect(cleared.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);

    const replayed = observe({
      previous: cleared,
      replayed: true,
      requestIndex: 3,
      modelRequestId: 'request-3',
    });
    expect(replayed.invalidationReasons).toContain('replayed');
    expect(replayed.primaryInvalidationReason).toBe('replayed');
    expect(replayed.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);

    const both = observe({
      previous: replayed,
      manualClear: true,
      replayed: true,
      requestIndex: 4,
      modelRequestId: 'request-4',
    });
    expect(both.invalidationReasons).toEqual(['manual_clear', 'replayed']);
    expect(both.primaryInvalidationReason).toBe('manual_clear');
  });

  it('records runtime clear and replay reasons even without a previous observation', () => {
    expect(observe({ manualClear: true }).invalidationReasons).toEqual(['manual_clear']);
    expect(observe({ replayed: true }).invalidationReasons).toEqual(['replayed']);
  });

  it('keeps tool results and tool-loop continuations inside the dynamic suffix', () => {
    const base = observe();
    const boundary = 'Stable policy v1\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=one';
    const firstLoop = observe({
      request: request({
        messages: [
          { role: 'system', content: boundary },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"secret-path"}' },
            }],
          },
          { role: 'tool', content: 'TOOL_RESULT_SECRET', tool_call_id: 'call-1', name: 'read' },
          { role: 'user', content: 'continue after tool' },
        ],
      }),
      previous: base,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(firstLoop.stablePrefix.fingerprint).toBe(base.stablePrefix.fingerprint);
    expect(firstLoop.dynamicSuffix.fingerprint).not.toBe(base.dynamicSuffix.fingerprint);
    expect(firstLoop.invalidationReasons).toEqual([]);

    const secondLoop = observe({
      request: request({
        messages: [
          { role: 'system', content: boundary },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"secret-path"}' },
            }],
          },
          { role: 'tool', content: 'TOOL_RESULT_SECRET', tool_call_id: 'call-1', name: 'read' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-2',
              type: 'function',
              function: { name: 'write', arguments: '{"path":"secret-output"}' },
            }],
          },
          { role: 'tool', content: 'SECOND_TOOL_RESULT_SECRET', tool_call_id: 'call-2', name: 'write' },
          { role: 'user', content: 'finish after second tool' },
        ],
      }),
      previous: firstLoop,
      requestIndex: 3,
      modelRequestId: 'request-3',
    });
    expect(secondLoop.stablePrefix.fingerprint).toBe(base.stablePrefix.fingerprint);
    expect(secondLoop.invalidationReasons).toEqual([]);

    const serialized = canonicalSerialize(secondLoop);
    expect(serialized).not.toContain('TOOL_RESULT_SECRET');
    expect(serialized).not.toContain('SECOND_TOOL_RESULT_SECRET');
    expect(serialized).not.toContain('secret-path');
    expect(serialized).not.toContain('secret-output');
  });

  it('separates memory, summary and attachment revisions from stable policy bytes', () => {
    const first = observe();
    const changedMemory = observe({
      previous: first,
      promptComponents: { ...promptComponents, memoryRevision: 'memory-v2' },
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    const changedSummary = observe({
      previous: changedMemory,
      promptComponents: { ...promptComponents, memoryRevision: 'memory-v2', summary: 'summary-v2' },
      requestIndex: 3,
      modelRequestId: 'request-3',
    });
    expect(changedMemory.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(changedMemory.invalidationReasons).toEqual(['memory_revision_changed']);
    expect(changedSummary.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(changedSummary.invalidationReasons).toEqual(['summary_compacted']);
  });

  it('canonicalizes tool order but invalidates additions and schema edits', () => {
    const first = observe();
    const reordered = observe({
      request: request({ tools: [...tools].reverse() }),
      previous: first,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(reordered.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(reordered.invalidationReasons).toEqual([]);
    const added = observe({
      request: request({ tools: [...tools, { type: 'function', function: { name: 'glob', description: 'Glob', parameters: {} } }] }),
      previous: first,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(added.invalidationReasons).toEqual(['tool_schema_changed']);
    expect(added.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
  });

  it('covers provider/model/config partitions and concurrent session separation', async () => {
    const first = observe();
    expect(observe({ provider: 'deepseek', previous: first }).invalidationReasons).toContain('provider_changed');
    expect(observe({ model: 'deepseek-v4', previous: first }).invalidationReasons).toContain('model_changed');
    expect(observe({ request: request({ stream: false }), previous: first }).stablePrefix.fingerprint)
      .toBe(first.stablePrefix.fingerprint);

    const sameScope = await Promise.all(Array.from({ length: 16 }, (_, index) => Promise.resolve(observe({
      requestIndex: index + 1,
      modelRequestId: `same-${index}`,
    }))));
    expect(new Set(sameScope.map((item) => item.stablePrefix.fingerprint)).size).toBe(1);
    const differentScopes = await Promise.all([
      Promise.resolve(observe({ sessionId: 'session-b' })),
      Promise.resolve(observe({ workspaceScope: 'D:\\Other' })),
      Promise.resolve(observe({ permissionPolicyId: 'restricted' })),
    ]);
    expect(new Set([first, ...differentScopes].map((item) => item.scope.partitionDigest)).size).toBe(4);
  });

  it('keeps missing, partial and invalid Provider usage distinct', () => {
    expect(classifyProviderCacheUsage(undefined).ledger.status).toBe('unavailable');
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5 }).ledger.status).toBe('unavailable');
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5, cachedPromptTokens: 25 }).ledger)
      .toMatchObject({ status: 'partial', hitRatio: 0.25 });
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5, cachedPromptTokens: 101 }).ledger.status)
      .toBe('unknown');
  });

  it('does not retain request content when the matrix is serialized', () => {
    const serialized = canonicalSerialize(observe());
    expect(serialized).not.toContain('current user message');
    expect(serialized).not.toContain('recent answer');
    expect(serialized).not.toContain('Stable policy v1');
    expect(serialized).not.toContain('shape-matrix-key');
  });
});
