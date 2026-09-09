import { describe, expect, it } from 'vitest';
import type {
  CacheLedgerObservation,
  CacheObservation,
  CacheObservationStatus,
  DurableModelRequestProjection,
} from '@littlesheep/types';
import { buildCacheQualityReport } from './cache-quality-report.js';
import type { ModelRequestLatencySummary } from './model-latency-report.js';

function ledger(
  kind: CacheLedgerObservation['kind'],
  status: CacheObservationStatus,
  overrides: Partial<CacheLedgerObservation> = {},
): CacheLedgerObservation {
  return { kind, status, requestCount: 1, ...overrides };
}

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
    providerPrompt: ledger('provider_prompt', 'miss', { tokenCount: 100, cachedTokenCount: 0, hitRatio: 0 }),
    lsContext: ledger('ls_context', 'unavailable', { reason: 'context_cache_event_not_observed' }),
    memoryEmbedding: ledger('memory_embedding', 'unavailable', { reason: 'memory_cache_event_not_observed' }),
    ...overrides,
  };
}

function latency(overrides: Partial<ModelRequestLatencySummary> = {}): ModelRequestLatencySummary {
  return {
    version: 1,
    requestCount: 3,
    completedCount: 3,
    unavailableCount: 0,
    receivedCount: 3,
    pendingCount: 0,
    abortedCount: 0,
    failureCount: 0,
    p50Ms: 10,
    p95Ms: 20,
    maxMs: 20,
    ...overrides,
  };
}

function modelRequest(
  overrides: Partial<DurableModelRequestProjection> = {},
): DurableModelRequestProjection {
  return {
    requestId: 'request-1',
    status: 'received',
    startedEventId: 'event-started-1',
    startedAt: '2026-09-09T00:00:00.000Z',
    settledAt: '2026-09-09T00:00:00.100Z',
    ...overrides,
  };
}

describe('CACHE-09/10 cache quality report', () => {
  it('keeps the three ledgers separate and only computes provider hit ratio from complete usage', () => {
    const report = buildCacheQualityReport({
      observations: [
        observation({
          modelRequestId: 'r1',
          providerPrompt: ledger('provider_prompt', 'hit', {
            tokenCount: 100,
            cachedTokenCount: 100,
            hitRatio: 1,
          }),
        }),
        observation({
          modelRequestId: 'r2',
          providerPrompt: ledger('provider_prompt', 'partial', {
            tokenCount: 100,
            cachedTokenCount: 40,
            hitRatio: 0.4,
          }),
        }),
        observation({
          modelRequestId: 'r3',
          providerPrompt: ledger('provider_prompt', 'miss', {
            tokenCount: 100,
            cachedTokenCount: 0,
            hitRatio: 0,
          }),
        }),
      ],
      latency: latency(),
    });

    expect(report.requestCount).toBe(3);
    expect(report.providerPrompt).toMatchObject({
      statusCounts: { hit: 1, miss: 1, partial: 1, unavailable: 0, unknown: 0 },
      tokenCount: 300,
      cachedTokenCount: 140,
      hitRatio: 140 / 300,
    });
    expect(report.lsContext.statusCounts).toEqual({ hit: 0, miss: 0, partial: 0, unavailable: 3, unknown: 0 });
    expect(report.memoryEmbedding.statusCounts).toEqual({ hit: 0, miss: 0, partial: 0, unavailable: 3, unknown: 0 });
    expect(report.partitions).toEqual([{ provider: 'openai', model: 'gpt-test', requestCount: 3 }]);
    expect(report.releaseGate.status).toBe('blocked');
    expect(report.releaseGate.reasons).not.toContain('provider_usage_incomplete');
    expect(report.releaseGate.reasons).not.toContain('latency_unavailable');
    expect(report.releaseGate.reasons).toContain('context_cache_not_observed');
    expect(report.releaseGate.reasons).toContain('memory_cache_not_observed');
    expect(report.releaseGate.reasons).toContain('real_provider_reconciliation_not_verified');
  });

  it('keeps provider usage unavailable instead of inventing a hit ratio', () => {
    const report = buildCacheQualityReport({
      observations: [observation({
        providerPrompt: ledger('provider_prompt', 'unavailable', { reason: 'provider_usage_missing' }),
      })],
    });

    expect(report.providerPrompt.tokenCount).toBeUndefined();
    expect(report.providerPrompt.cachedTokenCount).toBeUndefined();
    expect(report.providerPrompt.hitRatio).toBeUndefined();
    expect(report.releaseGate.reasons).toContain('provider_usage_incomplete');
    expect(report.releaseGate.reasons).toContain('latency_unavailable');
  });

  it('summarizes provider tokens and request outcome rates from durable requests', () => {
    const report = buildCacheQualityReport({
      observations: [
        observation({ modelRequestId: 'request-1' }),
        observation({ modelRequestId: 'request-2' }),
      ],
      modelRequests: [
        modelRequest({
          requestId: 'request-1',
          providerUsage: {
            promptTokens: 100,
            completionTokens: 10,
            reasoningTokens: 3,
            totalTokens: 113,
            cachedPromptTokens: 40,
            cacheStatus: 'partial',
            reconciliation: 'unavailable',
          },
          settledAt: '2026-09-09T00:00:00.100Z',
        }),
        modelRequest({
          requestId: 'request-2',
          status: 'aborted',
          settledAt: '2026-09-09T00:00:00.300Z',
        }),
      ],
    });

    expect(report.providerTokens).toEqual({
      requestCount: 2,
      completeRequestCount: 1,
      unavailableRequestCount: 1,
    });
    expect(report.outcomes).toMatchObject({
      requestCount: 2,
      receivedCount: 1,
      abortedCount: 1,
      receivedRate: 0.5,
      abortedRate: 0.5,
      failureRate: 0,
    });
    expect(report.releaseGate.reasons).toContain('provider_token_totals_incomplete');
  });

  it('surfaces unexplained misses and never marks the release gate ready', () => {
    const report = buildCacheQualityReport({
      observations: [observation({
        invalidationReasons: ['unknown'],
        primaryInvalidationReason: 'unknown',
      })],
      latency: latency({ requestCount: 1, completedCount: 1, receivedCount: 1 }),
    });

    expect(report.invalidationReasons).toEqual([{ reason: 'unknown', count: 1 }]);
    expect(report.releaseGate).toMatchObject({ status: 'blocked' });
    expect(report.releaseGate.reasons).toContain('unexplained_cache_miss');
    expect(report.releaseGate.reasons).toContain('real_provider_reconciliation_not_verified');
  });

  it('returns unavailable when there are no observations', () => {
    expect(buildCacheQualityReport({ observations: [] })).toMatchObject({
      requestCount: 0,
      releaseGate: { status: 'unavailable', reasons: ['no_observations'] },
    });
  });

  it('degrades the gate when store entries are unreadable', () => {
    const report = buildCacheQualityReport({
      observations: [observation()],
      latency: latency({ requestCount: 1, completedCount: 1, receivedCount: 1 }),
      unreadableEntryCount: 2,
    });

    expect(report.unreadableEntryCount).toBe(2);
    expect(report.releaseGate.reasons).toContain('cache_entries_unreadable');
  });

  it('does not retain request identities or scope digests in the report', () => {
    const report = buildCacheQualityReport({
      observations: [observation({
        modelRequestId: 'secret-request-id',
        scope: {
          version: 1,
          sessionDigest: 'secret-session-digest',
          workspaceDigest: 'secret-workspace-digest',
          permissionPolicyId: 'research',
          partitionDigest: 'secret-partition-digest',
          keySource: 'provided',
        },
      })],
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('secret-request-id');
    expect(serialized).not.toContain('secret-session-digest');
    expect(serialized).not.toContain('secret-workspace-digest');
    expect(serialized).not.toContain('secret-partition-digest');
  });
});
