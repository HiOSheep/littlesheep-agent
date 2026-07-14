import type { ContextSnapshot, ModelRequestSnapshot } from '@littlesheep/types'
import { getContextWindowForModelRef } from '../shared/model-capabilities'

export interface ContextUsageSnapshot {
  modelRef: string
  provider?: {
    usedTokens: number
    reportedAt: string
  }
  local?: {
    usedTokens: number
    countedAt: string
    tokenizerId: string
  }
  localUnavailableReason?: string
}

export interface ContextUsage {
  usedTokens: number
  maxTokens: number
  percent: number
  available: boolean
  source: 'provider' | 'local' | 'none'
  providerUsedTokens?: number
  providerReportedAt?: string
  localUsedTokens?: number
  localCountedAt?: string
  localTokenizerId?: string
  localUnavailableReason?: string
}

export interface ProviderRunUsage {
  promptTokens: number
  completionTokens: number
  totalTokens?: number
  source?: 'provider'
}

export function buildContextUsage(
  modelRef: string | undefined,
  snapshot: ContextUsageSnapshot | null,
): ContextUsage {
  const modelKey = modelRef ?? ''
  const hasFreshSnapshot = snapshot?.modelRef === modelKey
  const providerUsedTokens = hasFreshSnapshot ? snapshot?.provider?.usedTokens : undefined
  const localUsedTokens = hasFreshSnapshot ? snapshot?.local?.usedTokens : undefined
  const usedTokens = providerUsedTokens ?? localUsedTokens ?? 0
  const maxTokens = getContextWindowForModelRef(modelRef)
  const percent = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0
  return {
    usedTokens,
    maxTokens,
    percent,
    available: hasFreshSnapshot && maxTokens > 0 && (providerUsedTokens !== undefined || localUsedTokens !== undefined),
    source: providerUsedTokens !== undefined ? 'provider' : localUsedTokens !== undefined ? 'local' : 'none',
    providerUsedTokens,
    providerReportedAt: hasFreshSnapshot ? snapshot?.provider?.reportedAt : undefined,
    localUsedTokens,
    localCountedAt: hasFreshSnapshot ? snapshot?.local?.countedAt : undefined,
    localTokenizerId: hasFreshSnapshot ? snapshot?.local?.tokenizerId : undefined,
    localUnavailableReason: hasFreshSnapshot ? snapshot?.localUnavailableReason : undefined,
  }
}

export function buildContextUsageSnapshot(
  modelRef: string | undefined,
  usage: ProviderRunUsage | undefined,
  contextSnapshots: ContextSnapshot[] | undefined,
  modelRequests: ModelRequestSnapshot[] | undefined = undefined,
  now: () => string = () => new Date().toISOString(),
): ContextUsageSnapshot | null {
  const modelKey = modelRef ?? ''
  const snapshots = contextSnapshots ?? []
  const snapshotsById = new Map(snapshots.map((item) => [item.id, item]))
  const replyRequest = [...(modelRequests ?? [])]
    .reverse()
    .find((item) =>
      `${item.provider}/${item.model}` === modelKey
      && (item.stage === 'reply' || item.stage === 'execute')
      && snapshotsById.has(item.contextSnapshotId ?? ''),
    )
  const snapshot = (replyRequest?.contextSnapshotId
    ? snapshotsById.get(replyRequest.contextSnapshotId)
    : undefined)
    ?? [...snapshots]
      .reverse()
      .find((item) =>
        `${item.provider}/${item.model}` === modelKey
        && (usage?.source !== 'provider' || item.providerUsage?.promptTokens === usage.promptTokens),
      )
  const providerUsage = snapshot?.providerUsage
  const provider = providerUsage
    ? { usedTokens: Math.max(0, providerUsage.promptTokens), reportedAt: providerUsage.reportedAt }
    : usage?.source === 'provider'
      ? { usedTokens: Math.max(0, usage.promptTokens), reportedAt: now() }
      : undefined
  const localLedger = snapshot?.localTokenLedger
  const local = localLedger?.accuracy === 'exact'
    ? {
        usedTokens: Math.max(0, localLedger.promptTokens),
        countedAt: localLedger.countedAt,
        tokenizerId: localLedger.tokenizerId,
      }
    : undefined
  if (!provider && !local && !localLedger) return null
  return {
    modelRef: modelKey,
    provider,
    local,
    localUnavailableReason: localLedger?.accuracy === 'unavailable' ? localLedger.reason : undefined,
  }
}
