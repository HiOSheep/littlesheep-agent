import type { ContextSnapshot, RunUsage } from '@littlesheep/types'

/** Aggregate every Provider request in a run; the legacy footer only showed the last one. */
export function aggregateRunUsage(
  snapshots: readonly Pick<ContextSnapshot, 'id' | 'providerUsage'>[] | undefined,
  fallback?: RunUsage,
): RunUsage | undefined {
  const ledgers = [...new Map(
    (snapshots ?? []).filter((item) => item.providerUsage).map((item) => [item.id, item.providerUsage!]),
  ).values()]
  if (ledgers.length === 0) return fallback

  const sum = (select: (ledger: (typeof ledgers)[number]) => number | undefined) =>
    ledgers.reduce((total, ledger) => total + (select(ledger) ?? 0), 0)
  const allReport = (select: (ledger: (typeof ledgers)[number]) => number | undefined) =>
    ledgers.every((ledger) => select(ledger) !== undefined)

  const promptTokens = sum((ledger) => ledger.promptTokens)
  const completionTokens = sum((ledger) => ledger.completionTokens)
  return {
    source: 'provider',
    promptTokens,
    completionTokens,
    totalTokens: sum((ledger) => ledger.totalTokens ?? ledger.promptTokens + ledger.completionTokens),
    ...(allReport((ledger) => ledger.cachedPromptTokens)
      ? { cachedPromptTokens: sum((ledger) => ledger.cachedPromptTokens) }
      : {}),
    ...(allReport((ledger) => ledger.cacheWriteTokens)
      ? { cacheWriteTokens: sum((ledger) => ledger.cacheWriteTokens) }
      : {}),
    ...(allReport((ledger) => ledger.reasoningTokens)
      ? { reasoningTokens: sum((ledger) => ledger.reasoningTokens) }
      : {}),
    ...(ledgers.some((ledger) => ledger.durationMs !== undefined)
      ? { providerDurationMs: sum((ledger) => ledger.durationMs) }
      : {}),
    requestCount: ledgers.length,
  }
}
