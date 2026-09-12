import { describe, expect, it } from 'vitest';
import type {
  CacheObservation,
  DurableModelRequestProjection,
  DurableVerificationProjection,
} from '@littlesheep/types';
import { buildCacheQualityReport } from './cache-quality-report.js';
import { compareHarnessPaths } from './harness-path-comparison.js';
import type { ModelRequestLatencySummary } from './model-latency-report.js';

function observation(overrides: Partial<CacheObservation> = {}): CacheObservation {
  return {
    version: 1,
    usageSchemaVersion: 'llm-chat-usage.v1',
    adapter: 'llm-chat',
    provider: 'openai',
    model: 'gpt-test',
    requestKind: 'reply',
    requestIndex: 1,
    modelRequestId: 'request-1',
    scope: { version: 1, permissionPolicyId: 'research', keySource: 'provided' },
    stablePrefixVersion: 'StablePrefixV1',
    dynamicSuffixVersion: 'DynamicSuffixV1',
    normalizedRequestVersion: 'NormalizedRequestV1',
    boundaryMarker: '<!-- LITTLESHEEP_CACHE_BOUNDARY -->',
    stablePrefix: { version: 1, algorithm: 'hmac-sha256', keySource: 'provided', byteLength: 1, itemCount: 1 },
    dynamicSuffix: { version: 1, algorithm: 'hmac-sha256', keySource: 'provided', byteLength: 1, itemCount: 1 },
    normalizedRequest: { version: 1, algorithm: 'hmac-sha256', keySource: 'provided', byteLength: 1, itemCount: 1 },
    components: { provider: 'p', model: 'm', requestKind: 'r', systemPrompt: 's', toolSchema: 't', scope: 'sc' },
    invalidationReasons: [],
    providerPrompt: { kind: 'provider_prompt', status: 'miss', requestCount: 1, tokenCount: 100, cachedTokenCount: 0, hitRatio: 0 },
    lsContext: { kind: 'ls_context', status: 'unavailable', requestCount: 1, reason: 'context_cache_event_not_observed' },
    memoryEmbedding: { kind: 'memory_embedding', status: 'unavailable', requestCount: 1, reason: 'memory_cache_event_not_observed' },
    ...overrides,
  };
}

function modelRequest(promptTokens: number, cachedPromptTokens: number, durationMs: number): DurableModelRequestProjection {
  const startedMs = Date.parse('2026-09-11T00:00:00.000Z');
  return {
    requestId: `request-${promptTokens}`,
    status: 'received',
    startedEventId: 'event-started',
    startedAt: '2026-09-11T00:00:00.000Z',
    settledAt: new Date(startedMs + durationMs).toISOString(),
    providerUsage: {
      promptTokens,
      completionTokens: 10,
      totalTokens: promptTokens + 10,
      cachedPromptTokens,
      cacheStatus: 'miss',
      reconciliation: 'unavailable',
    },
  };
}

function verification(verdict: DurableVerificationProjection['verdict']): DurableVerificationProjection {
  return {
    attempt: 1,
    verdict,
    source: 'structural',
    reasonHash: 'a'.repeat(64),
    reasonLength: 10,
    failedStepIds: [],
  };
}

describe('CACHE-09 harness path comparison', () => {
  it('reports per-path cost, latency, outcome and quality deltas without inventing data', () => {
    const shadow = buildCacheQualityReport({
      observations: [observation({ modelRequestId: 'shadow-1' })],
      modelRequests: [modelRequest(100, 0, 20)],
      verifications: [verification('pass')],
    });
    const next = buildCacheQualityReport({
      observations: [observation({ modelRequestId: 'next-1' })],
      modelRequests: [modelRequest(130, 65, 40)],
      verifications: [verification('pass')],
    });

    const comparison = compareHarnessPaths([
      { label: 'shadow', report: shadow },
      { label: 'next', report: next },
    ]);
    expect(comparison.paths.map((entry) => entry.label)).toEqual(['shadow', 'next']);
    expect(comparison.paths[0]?.summary).toMatchObject({
      label: 'shadow',
      requestCount: 1,
      promptTokens: 100,
      cachedPromptTokens: 0,
      latencyP95Ms: 20,
      verificationPassRate: 1,
    });
    expect(comparison.paths[1]?.summary).toMatchObject({
      label: 'next',
      requestCount: 1,
      promptTokens: 130,
      cachedPromptTokens: 65,
      latencyP95Ms: 40,
    });
    expect(comparison.deltas).toMatchObject({
      requestCount: 0,
      promptTokens: 30,
      cachedPromptTokens: 65,
      latencyP95Ms: 20,
      verificationPassRate: 0,
    });
    expect(comparison.incomplete).not.toContain('promptTokens');
    expect(comparison.incomplete).not.toContain('verificationPassRate');
  });

  it('marks metrics incomplete instead of guessing when usage or verification evidence is absent', () => {
    const withUsage = buildCacheQualityReport({
      observations: [observation()],
      modelRequests: [modelRequest(100, 0, 20)],
      verifications: [verification('pass')],
    });
    const withoutUsage = buildCacheQualityReport({
      observations: [observation()],
      modelRequests: [{ requestId: 'no-usage', status: 'received', startedEventId: 'event-started', startedAt: '2026-09-11T00:00:00.000Z', settledAt: '2026-09-11T00:00:00.020Z' }],
    });

    const comparison = compareHarnessPaths([
      { label: 'shadow', report: withUsage },
      { label: 'next', report: withoutUsage },
    ]);
    expect(comparison.incomplete).toContain('promptTokens');
    expect(comparison.incomplete).toContain('cachedPromptTokens');
    expect(comparison.incomplete).toContain('verificationPassRate');
    expect(comparison.deltas.promptTokens).toBeUndefined();
    expect(comparison.deltas.verificationPassRate).toBeUndefined();
  });
});
