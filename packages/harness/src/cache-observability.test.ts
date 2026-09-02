import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import {
  buildCacheObservation,
  canonicalSerialize,
  classifyProviderCacheUsage,
} from './cache-observability.js';
import { makeCtx } from './tests/helpers.js';
import { prepareModelRequest, recordProviderUsage } from './model-observability.js';

function cacheRequest(options: {
  user?: string;
  volatile?: string;
  tools?: ChatRequest['tools'];
} = {}): ChatRequest {
  return {
    model: 'gpt-test',
    messages: [
      {
        role: 'system',
        content: `Stable policy v1\n\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\n\n${options.volatile ?? 'run-id-1\n2026-09-02T00:00:00.000Z'}`,
      },
      { role: 'user', content: options.user ?? '当前用户正文 SECRET_USER' },
    ],
    tools: options.tools,
    temperature: 0,
    max_tokens: 200,
    stream: true,
  };
}

function observation(request: ChatRequest, overrides: Partial<Parameters<typeof buildCacheObservation>[0]> = {}) {
  return buildCacheObservation({
    request,
    provider: 'openai',
    model: request.model,
    requestKind: 'reply',
    requestIndex: 1,
    modelRequestId: 'request-1',
    sessionId: 'session-1',
    workspaceScope: 'C:\\Work\\LittleSheep',
    permissionPolicyId: 'research',
    key: 'test-cache-observation-key',
    ...overrides,
  });
}

describe('cache observability', () => {
  it('canonicalizes keys, Unicode/newlines, Map and Set deterministically', () => {
    const left = { z: 'e\r\n', a: 'cafe\u0301', values: new Set(['b', 'a']), map: new Map([['b', 2], ['a', 1]]) };
    const right = { map: new Map([['a', 1], ['b', 2]]), values: new Set(['a', 'b']), a: 'café', z: 'e\n' };
    expect(canonicalSerialize(left)).toBe(canonicalSerialize(right));
    expect(canonicalSerialize({ value: -0 })).toBe('{"value":0}');
    expect(canonicalSerialize({ value: undefined })).toBe('{}');
    expect(canonicalSerialize([undefined])).toBe('[null]');
  });

  it('keeps the stable prefix unchanged when only dynamic/user fields change', () => {
    const first = observation(cacheRequest());
    const second = observation(cacheRequest({
      user: '另一个用户问题',
      volatile: 'run-id-2\n2026-09-02T00:00:01.000Z\ntool-duration=42',
    }), { requestIndex: 2, modelRequestId: 'request-2' });

    expect(second.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(second.dynamicSuffix.fingerprint).not.toBe(first.dynamicSuffix.fingerprint);
    expect(second.normalizedRequest.fingerprint).not.toBe(first.normalizedRequest.fingerprint);
  });

  it('records only the relevant invalidation reason for a same-scope schema change', () => {
    const first = observation(cacheRequest({ tools: [{
      type: 'function',
      function: { name: 'read', description: 'read', parameters: { type: 'object' } },
    }] }));
    const changedSchema = observation(cacheRequest({ tools: [{
      type: 'function',
      function: { name: 'write', description: 'write', parameters: { type: 'object' } },
    }] }), { previous: first, requestIndex: 2, modelRequestId: 'request-2' });
    expect(changedSchema.invalidationReasons).toEqual(['tool_schema_changed']);

    const changedSession = observation(cacheRequest(), { previous: first, sessionId: 'session-2' });
    expect(changedSession.invalidationReasons).toEqual(['session_reset']);
  });

  it('treats provider-facing tool order as an explicit stable-prefix difference', () => {
    const first = observation(cacheRequest({ tools: [
      { type: 'function', function: { name: 'a', description: 'a', parameters: {} } },
      { type: 'function', function: { name: 'b', description: 'b', parameters: {} } },
    ] }));
    const reordered = observation(cacheRequest({ tools: [
      { type: 'function', function: { name: 'b', description: 'b', parameters: {} } },
      { type: 'function', function: { name: 'a', description: 'a', parameters: {} } },
    ] }), { previous: first, requestIndex: 2, modelRequestId: 'request-2' });
    expect(reordered.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
    expect(reordered.invalidationReasons).toEqual(['tool_schema_changed']);
  });

  it('partitions fingerprints by session, workspace and permission without exposing content', () => {
    const first = observation(cacheRequest());
    const otherSession = observation(cacheRequest(), { sessionId: 'session-2' });
    const otherWorkspace = observation(cacheRequest(), { workspaceScope: 'D:\\Other' });
    const otherPermission = observation(cacheRequest(), { permissionPolicyId: 'restricted' });
    const serialized = JSON.stringify(first);

    expect(otherSession.scope.partitionDigest).not.toBe(first.scope.partitionDigest);
    expect(otherWorkspace.scope.partitionDigest).not.toBe(first.scope.partitionDigest);
    expect(otherPermission.scope.partitionDigest).not.toBe(first.scope.partitionDigest);
    expect(otherSession.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
    expect(serialized).not.toContain('SECRET_USER');
    expect(serialized).not.toContain('Stable policy');
    expect(serialized).not.toContain('C:\\Work');
  });

  it('reports provider cache hit, miss, partial and unavailable without estimates', () => {
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5, cachedPromptTokens: 100 }).ledger).toMatchObject({ status: 'hit', hitRatio: 1 });
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5, cachedPromptTokens: 0 }).ledger).toMatchObject({ status: 'miss', hitRatio: 0 });
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5, cachedPromptTokens: 25 }).ledger).toMatchObject({ status: 'partial', hitRatio: 0.25 });
    expect(classifyProviderCacheUsage({ promptTokens: 100, completionTokens: 5 }).ledger).toMatchObject({ status: 'unavailable' });
    expect(classifyProviderCacheUsage(undefined).ledger).toMatchObject({ status: 'unavailable' });
    expect(classifyProviderCacheUsage({ promptTokens: 10, completionTokens: 1, cachedPromptTokens: 11 }).ledger).toMatchObject({ status: 'unknown' });
  });

  it('binds cache evidence to the prepared request and updates it after provider usage', () => {
    const ctx = makeCtx();
    ctx.cacheObservationKey = 'test-cache-observation-key';
    const prepared = prepareModelRequest(ctx, 'reply', cacheRequest());
    expect(ctx.modelRequests?.[0]?.cacheObservation).toMatchObject({
      stablePrefixVersion: 'StablePrefixV1',
      providerPrompt: { status: 'unavailable', reason: 'provider_usage_pending' },
    });

    recordProviderUsage(ctx, prepared, {
      promptTokens: 120,
      completionTokens: 8,
      cachedPromptTokens: 60,
    });

    expect(ctx.modelRequests?.[0]?.cacheObservation?.providerPrompt).toMatchObject({
      status: 'partial',
      tokenCount: 120,
      cachedTokenCount: 60,
      hitRatio: 0.5,
    });
    expect(ctx.contextSnapshots?.[0]?.providerUsage).toMatchObject({
      promptTokens: 120,
      cachedPromptTokens: 60,
    });
  });

  it('retains unavailable status when a provider response has no usage', () => {
    const ctx = makeCtx();
    ctx.cacheObservationKey = 'test-cache-observation-key';
    const prepared = prepareModelRequest(ctx, 'reply', cacheRequest());
    recordProviderUsage(ctx, prepared, undefined);

    expect(ctx.modelRequests?.[0]?.cacheObservation?.providerPrompt).toMatchObject({
      status: 'unavailable',
      reason: 'provider_usage_missing',
    });
    expect(ctx.contextSnapshots?.[0]?.providerUsage).toBeUndefined();
  });
});
