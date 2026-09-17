// CACHE-09/10 redacted quality report. It aggregates the three independent
// ledgers and durable latency evidence without retaining prompt, tool, scope
// or provider payload content. A report never claims `ready`: real Provider
// reconciliation and the full CACHE-10 release gate remain explicit blockers.

import type {
  CacheInvalidationReason,
  CacheLedgerObservation,
  CacheObservation,
  CacheObservationStatus,
  DurableModelRequestProjection,
  DurableVerificationProjection,
} from '@littlesheep/types';
import {
  summarizeModelRequestLatency,
  type ModelRequestLatencySummary,
} from './model-latency-report.js';

export interface CacheLedgerSummary {
  readonly statusCounts: Readonly<Record<CacheObservationStatus, number>>;
  readonly tokenCount?: number;
  readonly cachedTokenCount?: number;
  readonly hitRatio?: number;
  readonly reasonCounts: ReadonlyArray<{ reason: string; count: number }>;
}

export interface CacheTokenUsageSummary {
  readonly requestCount: number;
  readonly completeRequestCount: number;
  readonly unavailableRequestCount: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
}

export interface CacheRequestOutcomeSummary {
  readonly requestCount: number;
  readonly receivedCount: number;
  readonly pendingCount: number;
  readonly abortedCount: number;
  readonly failureCount: number;
  readonly receivedRate?: number;
  readonly pendingRate?: number;
  readonly abortedRate?: number;
  readonly failureRate?: number;
}

export interface CacheVerificationSummary {
  readonly verificationCount: number;
  readonly passCount: number;
  readonly needsReplanCount: number;
  readonly failCount: number;
  readonly passRate?: number;
}

export interface CacheQualityReport {
  readonly version: 1;
  readonly requestCount: number;
  /** Store-level entries excluded because they could not be read or authorized. */
  readonly unreadableEntryCount: number;
  readonly partitions: ReadonlyArray<{ provider: string; model: string; requestCount: number }>;
  readonly providerPrompt: CacheLedgerSummary;
  readonly lsContext: CacheLedgerSummary;
  readonly memoryEmbedding: CacheLedgerSummary;
  readonly providerTokens: CacheTokenUsageSummary;
  readonly outcomes: CacheRequestOutcomeSummary;
  readonly verification: CacheVerificationSummary;
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
  readonly modelRequests?: readonly DurableModelRequestProjection[];
  readonly verifications?: readonly DurableVerificationProjection[];
  readonly latency?: ModelRequestLatencySummary;
  readonly unreadableEntryCount?: number;
}): CacheQualityReport {
  const unreadableEntryCount = normalizeCount(input.unreadableEntryCount);
  const latency = input.modelRequests
    ? summarizeModelRequestLatency(input.modelRequests)
    : input.latency;
  const providerPrompt = summarizeLedger(input.observations.map((observation) => observation.providerPrompt));
  const lsContext = summarizeLedger(input.observations.map((observation) => observation.lsContext));
  const memoryEmbedding = summarizeLedger(input.observations.map((observation) => observation.memoryEmbedding));
  const providerTokens = summarizeProviderTokens(input.modelRequests);
  const outcomes = summarizeOutcomes(latency);
  const verification = summarizeVerifications(input.verifications);
  const invalidationReasons = summarizeReasons(input.observations);

  return Object.freeze({
    version: 1 as const,
    requestCount: input.observations.length,
    unreadableEntryCount,
    partitions: summarizePartitions(input.observations),
    providerPrompt,
    lsContext,
    memoryEmbedding,
    providerTokens,
    outcomes,
    verification,
    invalidationReasons,
    ...(latency ? { latency } : {}),
    releaseGate: buildReleaseGate({
      observations: input.observations,
      providerPrompt,
      lsContext,
      memoryEmbedding,
      providerTokens,
      verification,
      latency,
      unreadableEntryCount,
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
  let uncachedTokenCount = 0;
  let tokensComplete = ledgers.length > 0;
  let cachedTokensComplete = ledgers.length > 0;
  let uncachedTokensComplete = ledgers.length > 0;

  for (const ledger of ledgers) {
    statusCounts[ledger.status] += 1;
    if (ledger.reason) reasonCounts.set(ledger.reason, (reasonCounts.get(ledger.reason) ?? 0) + 1);
    if (isNonNegativeInteger(ledger.tokenCount)) tokenCount += ledger.tokenCount;
    else tokensComplete = false;
    if (isNonNegativeInteger(ledger.cachedTokenCount)) cachedTokenCount += ledger.cachedTokenCount;
    else cachedTokensComplete = false;
    if (isNonNegativeInteger(ledger.uncachedTokenCount)) uncachedTokenCount += ledger.uncachedTokenCount;
    else uncachedTokensComplete = false;
  }

  const hitRatio = tokensComplete && cachedTokensComplete && tokenCount > 0
    ? cachedTokenCount / tokenCount
    : undefined;
  return Object.freeze({
    statusCounts: Object.freeze(statusCounts),
    ...(tokensComplete ? { tokenCount } : {}),
    ...(cachedTokensComplete ? { cachedTokenCount } : {}),
    ...(uncachedTokensComplete ? { uncachedTokenCount } : {}),
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

function summarizeProviderTokens(
  requests: readonly DurableModelRequestProjection[] | undefined,
): CacheTokenUsageSummary {
  if (!requests || requests.length === 0) {
    return Object.freeze({
      requestCount: 0,
      completeRequestCount: 0,
      unavailableRequestCount: 0,
    });
  }
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let cachedPromptTokens = 0;
  let completeRequestCount = 0;
  let unavailableRequestCount = 0;
  let promptComplete = true;
  let completionComplete = true;
  let reasoningComplete = true;
  let totalComplete = true;
  let cachedComplete = true;
  for (const request of requests) {
    const usage = request.providerUsage;
    if (!usage) {
      unavailableRequestCount += 1;
      promptComplete = false;
      completionComplete = false;
      reasoningComplete = false;
      totalComplete = false;
      cachedComplete = false;
      continue;
    }
    completeRequestCount += 1;
    if (isNonNegativeInteger(usage.promptTokens)) promptTokens += usage.promptTokens;
    else promptComplete = false;
    if (isNonNegativeInteger(usage.completionTokens)) completionTokens += usage.completionTokens;
    else completionComplete = false;
    if (isNonNegativeInteger(usage.reasoningTokens)) reasoningTokens += usage.reasoningTokens;
    else reasoningComplete = false;
    if (isNonNegativeInteger(usage.totalTokens)) totalTokens += usage.totalTokens;
    else totalComplete = false;
    if (isNonNegativeInteger(usage.cachedPromptTokens)) cachedPromptTokens += usage.cachedPromptTokens;
    else cachedComplete = false;
  }
  return Object.freeze({
    requestCount: requests.length,
    completeRequestCount,
    unavailableRequestCount,
    ...(promptComplete ? { promptTokens } : {}),
    ...(completionComplete ? { completionTokens } : {}),
    ...(reasoningComplete ? { reasoningTokens } : {}),
    ...(totalComplete ? { totalTokens } : {}),
    ...(cachedComplete ? { cachedPromptTokens } : {}),
  });
}

function summarizeOutcomes(latency: ModelRequestLatencySummary | undefined): CacheRequestOutcomeSummary {
  if (!latency || latency.requestCount === 0) {
    return Object.freeze({
      requestCount: 0,
      receivedCount: 0,
      pendingCount: 0,
      abortedCount: 0,
      failureCount: 0,
    });
  }
  const total = latency.requestCount;
  return Object.freeze({
    requestCount: total,
    receivedCount: latency.receivedCount,
    pendingCount: latency.pendingCount,
    abortedCount: latency.abortedCount,
    failureCount: latency.failureCount,
    receivedRate: latency.receivedCount / total,
    pendingRate: latency.pendingCount / total,
    abortedRate: latency.abortedCount / total,
    failureRate: latency.failureCount / total,
  });
}

function summarizeVerifications(
  verifications: readonly DurableVerificationProjection[] | undefined,
): CacheVerificationSummary {
  if (!verifications || verifications.length === 0) {
    return Object.freeze({
      verificationCount: 0,
      passCount: 0,
      needsReplanCount: 0,
      failCount: 0,
    });
  }
  let passCount = 0;
  let needsReplanCount = 0;
  let failCount = 0;
  for (const verification of verifications) {
    if (verification.verdict === 'pass') passCount += 1;
    else if (verification.verdict === 'needs_replan') needsReplanCount += 1;
    else failCount += 1;
  }
  return Object.freeze({
    verificationCount: verifications.length,
    passCount,
    needsReplanCount,
    failCount,
    passRate: passCount / verifications.length,
  });
}

function buildReleaseGate(input: {
  observations: readonly CacheObservation[];
  providerPrompt: CacheLedgerSummary;
  lsContext: CacheLedgerSummary;
  memoryEmbedding: CacheLedgerSummary;
  providerTokens: CacheTokenUsageSummary;
  verification: CacheVerificationSummary;
  latency?: ModelRequestLatencySummary;
  unreadableEntryCount: number;
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
  if (input.unreadableEntryCount > 0) {
    reasons.add('cache_entries_unreadable');
  }
  if (input.providerTokens.unavailableRequestCount > 0
    || input.providerTokens.promptTokens === undefined
    || input.providerTokens.completionTokens === undefined) {
    reasons.add('provider_token_totals_incomplete');
  }
  if (input.verification.verificationCount === 0) {
    reasons.add('quality_continuity_not_observed');
  }
  if (input.verification.failCount > 0) {
    reasons.add('verification_failures_present');
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

function normalizeCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : 0;
}
