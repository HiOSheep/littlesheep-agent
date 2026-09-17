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

/**
 * The user-facing conversation calls. DSH-style session cache numbers count the
 * conversation's own turns, while auxiliary stages (classify/decide/verify/...)
 * each carry a different prompt and drag a blended ratio down.
 */
const MAIN_CONVERSATION_STAGES = new Set(['reply', 'execute', 'finalize', 'recover'])

export interface CacheCallGroupSummary {
  calls: number
  promptTokens: number
  cachedPromptTokens: number
  /** Token-weighted hit ratio; undefined when no call reported token counts. */
  hitRatio?: number
}

export interface CacheCallGroupSummaryPair {
  mainConversation: CacheCallGroupSummary
  auxiliary: CacheCallGroupSummary
}

/** Split observed calls into the main conversation and its auxiliary stages. */
export function summarizeCacheCallGroups(
  calls: readonly CacheCallObservation[] | undefined,
): CacheCallGroupSummaryPair | undefined {
  if (!calls || calls.length === 0) return undefined
  const empty = (): CacheCallGroupSummary => ({ calls: 0, promptTokens: 0, cachedPromptTokens: 0 })
  const groups = { mainConversation: empty(), auxiliary: empty() }
  for (const call of calls) {
    const group = MAIN_CONVERSATION_STAGES.has(call.stage) ? groups.mainConversation : groups.auxiliary
    group.calls += 1
    group.promptTokens += call.promptTokens ?? 0
    group.cachedPromptTokens += call.cachedPromptTokens ?? 0
  }
  for (const group of [groups.mainConversation, groups.auxiliary]) {
    if (group.promptTokens > 0) group.hitRatio = group.cachedPromptTokens / group.promptTokens
  }
  return groups
}

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
