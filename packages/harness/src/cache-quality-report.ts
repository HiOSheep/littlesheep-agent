// CACHE-09/10 redacted quality report. It aggregates the three independent
// ledgers and durable latency evidence without retaining prompt, tool, scope
// or provider payload content. A report never claims `ready`: real Provider
// reconciliation and the full CACHE-10 release gate remain explicit blockers.

import type {
  CacheInvalidationReason,
  CacheLedgerObservation,
  CacheObservation,
  CacheObservationStatus,
} from '@littlesheep/types';
import type { ModelRequestLatencySummary } from './model-latency-report.js';

export interface CacheLedgerSummary {
  readonly statusCounts: Readonly<Record<CacheObservationStatus, number>>;
  readonly tokenCount?: number;
  readonly cachedTokenCount?: number;
  readonly hitRatio?: number;
  readonly reasonCounts: ReadonlyArray<{ reason: string; count: number }>;
}

export interface CacheQualityReport {
  readonly version: 1;
  readonly requestCount: number;
  readonly partitions: ReadonlyArray<{ provider: string; model: string; requestCount: number }>;
  readonly providerPrompt: CacheLedgerSummary;
  readonly lsContext: CacheLedgerSummary;
  readonly memoryEmbedding: CacheLedgerSummary;
  readonly invalidationReasons: ReadonlyArray<{ reason: CacheInvalidationReason; count: number }>;
  readonly latency?: ModelRequestLatencySummary;
  /** Never `ready`: CACHE-10 requires verified real-Provider evidence. */
  readonly releaseGate: {
    readonly status: 'blocked' | 'unavailable';
    readonly reasons: readonly string[];
  };
}

export function buildCacheQualityReport(input: {
  readonly observations: readonly CacheObservation[];
  readonly latency?: ModelRequestLatencySummary;
}): CacheQualityReport {
  const providerPrompt = summarizeLedger(input.observations.map((observation) => observation.providerPrompt));
  const lsContext = summarizeLedger(input.observations.map((observation) => observation.lsContext));
  const memoryEmbedding = summarizeLedger(input.observations.map((observation) => observation.memoryEmbedding));
  const invalidationReasons = summarizeReasons(input.observations);

  return Object.freeze({
    version: 1 as const,
    requestCount: input.observations.length,
    partitions: summarizePartitions(input.observations),
    providerPrompt,
    lsContext,
    memoryEmbedding,
    invalidationReasons,
    ...(input.latency ? { latency: input.latency } : {}),
    releaseGate: buildReleaseGate({
      observations: input.observations,
      providerPrompt,
      lsContext,
      memoryEmbedding,
      latency: input.latency,
    }),
  });
}

function summarizeLedger(ledgers: readonly CacheLedgerObservation[]): CacheLedgerSummary {
  const statusCounts: Record<CacheObservationStatus, number> = {
    hit: 0,
    miss: 0,
    partial: 0,
    unavailable: 0,
    unknown: 0,
  };
  const reasonCounts = new Map<string, number>();
  let tokenCount = 0;
  let cachedTokenCount = 0;
  let tokensComplete = ledgers.length > 0;
  let cachedTokensComplete = ledgers.length > 0;

  for (const ledger of ledgers) {
    statusCounts[ledger.status] += 1;
    if (ledger.reason) reasonCounts.set(ledger.reason, (reasonCounts.get(ledger.reason) ?? 0) + 1);
    if (isNonNegativeInteger(ledger.tokenCount)) tokenCount += ledger.tokenCount;
    else tokensComplete = false;
    if (isNonNegativeInteger(ledger.cachedTokenCount)) cachedTokenCount += ledger.cachedTokenCount;
    else cachedTokensComplete = false;
  }

  const hitRatio = tokensComplete && cachedTokensComplete && tokenCount > 0
    ? cachedTokenCount / tokenCount
    : undefined;
  return Object.freeze({
    statusCounts: Object.freeze(statusCounts),
    ...(tokensComplete ? { tokenCount } : {}),
    ...(cachedTokensComplete ? { cachedTokenCount } : {}),
    ...(hitRatio === undefined ? {} : { hitRatio }),
    reasonCounts: Object.freeze([...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))),
  });
}

function summarizeReasons(
  observations: readonly CacheObservation[],
): ReadonlyArray<{ reason: CacheInvalidationReason; count: number }> {
  const counts = new Map<CacheInvalidationReason, number>();
  for (const observation of observations) {
    for (const reason of observation.invalidationReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Object.freeze([...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)));
}

function summarizePartitions(
  observations: readonly CacheObservation[],
): ReadonlyArray<{ provider: string; model: string; requestCount: number }> {
  const counts = new Map<string, { provider: string; model: string; requestCount: number }>();
  for (const observation of observations) {
    const key = `${observation.provider}\0${observation.model}`;
    const current = counts.get(key);
    if (current) current.requestCount += 1;
    else counts.set(key, { provider: observation.provider, model: observation.model, requestCount: 1 });
  }
  return Object.freeze([...counts.values()].sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
  )));
}

function buildReleaseGate(input: {
  observations: readonly CacheObservation[];
  providerPrompt: CacheLedgerSummary;
  lsContext: CacheLedgerSummary;
  memoryEmbedding: CacheLedgerSummary;
  latency?: ModelRequestLatencySummary;
}): CacheQualityReport['releaseGate'] {
  if (input.observations.length === 0) {
    return Object.freeze({ status: 'unavailable' as const, reasons: Object.freeze(['no_observations']) });
  }

  const reasons = new Set<string>();
  if (input.providerPrompt.tokenCount === undefined
    || input.providerPrompt.cachedTokenCount === undefined
    || input.observations.some((observation) => (
      observation.providerPrompt.status === 'unavailable'
      || observation.providerPrompt.status === 'unknown'
    ))) {
    reasons.add('provider_usage_incomplete');
  }
  if (input.observations.some((observation) => (
    observation.lsContext.status === 'unavailable' || observation.lsContext.status === 'unknown'
  ))) {
    reasons.add('context_cache_not_observed');
  }
  if (input.observations.some((observation) => (
    observation.memoryEmbedding.status === 'unavailable' || observation.memoryEmbedding.status === 'unknown'
  ))) {
    reasons.add('memory_cache_not_observed');
  }
  if (input.observations.some((observation) => observation.invalidationReasons.includes('unknown'))) {
    reasons.add('unexplained_cache_miss');
  }
  if (!input.latency || input.latency.completedCount === 0) {
    reasons.add('latency_unavailable');
  }
  reasons.add('real_provider_reconciliation_not_verified');

  return Object.freeze({
    status: 'blocked' as const,
    reasons: Object.freeze([...reasons].sort()),
  });
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! >= 0;
}
