import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import {
  assertCacheObservationScope,
  authorizeCacheObservationScope,
  buildCacheObservation,
  buildCacheScopePartition,
} from './cache-observability.js';

const request: ChatRequest = {
  model: 'test/model',
  messages: [{
    role: 'system',
    content: 'Stable policy v1\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=one',
  }, { role: 'user', content: 'secret user message' }],
  stream: true,
};

function observation(overrides: Partial<Parameters<typeof buildCacheObservation>[0]> = {}) {
  return buildCacheObservation({
    request,
    provider: 'openai',
    model: request.model,
    requestKind: 'reply',
    requestIndex: 1,
    modelRequestId: 'request-1',
    sessionId: 'session-a',
    workspaceScope: 'C:\\Work\\LittleSheep',
    permissionPolicyId: 'research',
    key: 'scope-fixture-key',
    ...overrides,
  });
}

describe('CACHE-06 cache scope authorization', () => {
  it('requires session, workspace and permission scope before a cache read', () => {
    const current = observation();
    expect(authorizeCacheObservationScope(current, {
      sessionId: 'session-a',
      workspaceScope: 'c:/work/littlesheep',
      permissionPolicyId: 'research',
      key: 'scope-fixture-key',
    })).toEqual({ allowed: true, reason: 'scope_match' });

    expect(authorizeCacheObservationScope(current, {
      sessionId: 'session-b',
      workspaceScope: 'C:\\Work\\LittleSheep',
      permissionPolicyId: 'research',
      key: 'scope-fixture-key',
    })).toEqual({ allowed: false, reason: 'scope_mismatch' });
    expect(authorizeCacheObservationScope(current, {
      sessionId: 'session-a',
      workspaceScope: 'D:\\Other',
      permissionPolicyId: 'research',
      key: 'scope-fixture-key',
    })).toEqual({ allowed: false, reason: 'scope_mismatch' });
    expect(authorizeCacheObservationScope(current, {
      sessionId: 'session-a',
      workspaceScope: 'C:\\Work\\LittleSheep',
      permissionPolicyId: 'restricted',
      key: 'scope-fixture-key',
    })).toEqual({ allowed: false, reason: 'scope_mismatch' });
  });

  it('fails closed when the HMAC identity is unavailable or changes source', () => {
    const current = observation();
    expect(authorizeCacheObservationScope(current, {
      sessionId: 'session-a',
      workspaceScope: 'C:\\Work\\LittleSheep',
      permissionPolicyId: 'research',
      key: null,
    })).toEqual({ allowed: false, reason: 'key_unavailable' });
    expect(authorizeCacheObservationScope(current, {
      sessionId: 'session-a',
      workspaceScope: 'C:\\Work\\LittleSheep',
      permissionPolicyId: 'research',
    })).toEqual({ allowed: false, reason: 'key_source_mismatch' });
    expect(() => assertCacheObservationScope(current, {
      sessionId: 'session-b',
      workspaceScope: 'C:\\Work\\LittleSheep',
      permissionPolicyId: 'research',
      key: 'scope-fixture-key',
    })).toThrow('cache scope authorization denied: scope_mismatch');
  });

  it('keeps partition identity redacted and deterministic across restart-style reconstruction', () => {
    const first = buildCacheScopePartition({
      sessionId: 'session-a',
      workspaceScope: 'C:\\Work\\LittleSheep',
      permissionPolicyId: 'research',
      key: 'scope-fixture-key',
    });
    const second = buildCacheScopePartition({
      sessionId: 'session-a',
      workspaceScope: 'c:/work/littlesheep',
      permissionPolicyId: 'research',
      key: 'scope-fixture-key',
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('session-a');
    expect(JSON.stringify(first)).not.toContain('LittleSheep');
  });

  it('does not correlate concurrent observations from different scopes', async () => {
    const observations = await Promise.all([
      Promise.resolve(observation({ sessionId: 'session-a' })),
      Promise.resolve(observation({ sessionId: 'session-b' })),
      Promise.resolve(observation({ workspaceScope: 'D:\\Other' })),
      Promise.resolve(observation({ permissionPolicyId: 'full' })),
    ]);
    expect(new Set(observations.map((item) => item.scope.partitionDigest)).size).toBe(4);
    expect(new Set(observations.map((item) => item.stablePrefix.fingerprint)).size).toBe(4);
  });
});
