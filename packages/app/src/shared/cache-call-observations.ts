// Bounded, redacted per-call cache evidence for one run.
//
// A single blended hit ratio hides the real shape: the large model calls often
// hit 80-90% while the small stage calls (classify/decide/verify) are cold. This
// projection exposes each call plus the runtime-classified reasons a call could
// not reuse a cached prefix, so a low number explains itself.
import type { ExecutionLog } from '@littlesheep/runner'

export type CacheCallStatus = 'hit' | 'miss' | 'partial' | 'unavailable' | 'unknown'

export interface CacheCallObservation {
  requestIndex: number
  stage: string
  status: CacheCallStatus
  promptTokens?: number
  cachedPromptTokens?: number
  uncachedPromptTokens?: number
  hitRatio?: number
  /** Runtime-classified prefix-invalidation reasons for this call, bounded. */
  reasons: string[]
}

export interface RunCacheObservations {
  calls: CacheCallObservation[]
  /** Most frequent invalidation reasons across the run's observed calls. */
  topReasons: Array<{ reason: string; count: number }>
  callsTruncated: boolean
}

const MAX_CALLS = 12
const MAX_CALL_REASONS = 4
const MAX_TOP_REASONS = 5

export function projectRunCacheObservations(
  log: ExecutionLog | undefined,
): RunCacheObservations | undefined {
  const snapshots = log?.modelRequests ?? []
  const calls: CacheCallObservation[] = []
  const reasonCounts = new Map<string, number>()
  for (const snapshot of snapshots) {
    const observation = snapshot.cacheObservation
    if (!observation) continue
    const ledger = observation.providerPrompt
    const reasons = [...new Set(observation.invalidationReasons.map(String))]
      .slice(0, MAX_CALL_REASONS)
    for (const reason of observation.invalidationReasons) {
      const key = String(reason)
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1)
    }
    calls.push({
      requestIndex: snapshot.requestIndex,
      stage: String(snapshot.stage),
      status: ledger.status,
      ...(ledger.tokenCount === undefined ? {} : { promptTokens: ledger.tokenCount }),
      ...(ledger.cachedTokenCount === undefined ? {} : { cachedPromptTokens: ledger.cachedTokenCount }),
      ...(ledger.uncachedTokenCount === undefined ? {} : { uncachedPromptTokens: ledger.uncachedTokenCount }),
      ...(ledger.hitRatio === undefined ? {} : { hitRatio: ledger.hitRatio }),
      reasons,
    })
  }
  if (calls.length === 0) return undefined
  const topReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, MAX_TOP_REASONS)
  const callsTruncated = calls.length > MAX_CALLS
  return {
    calls: callsTruncated ? calls.slice(-MAX_CALLS) : calls,
    topReasons,
    callsTruncated,
  }
}
