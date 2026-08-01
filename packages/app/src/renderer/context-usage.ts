import type { ContextSnapshot, ModelRequestSnapshot } from '@littlesheep/types'
import {
  getContextWindowForModelRef,
  resolveModelTokenizerCapabilityForModelRef,
} from '../shared/model-capabilities'

export type LocalTokenizerState = 'exact' | 'not_counted' | 'unavailable' | 'unknown'

export interface ContextUsageSnapshot {
  modelRef: string
  provider?: {
    usedTokens: number
    reportedAt: string
    localDifferenceTokens?: number
    calibrationStatus?: 'exact_match' | 'within_tolerance' | 'drift'
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
  providerDifferenceTokens?: number
  providerCalibrationStatus?: 'exact_match' | 'within_tolerance' | 'drift'
  localUsedTokens?: number
  localCountedAt?: string
  localTokenizerId?: string
  localTokenizerState: LocalTokenizerState
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
  const tokenizerCapability = resolveModelTokenizerCapabilityForModelRef(modelRef)
  const localTokenizerState: LocalTokenizerState = localUsedTokens !== undefined
    ? 'exact'
    : hasFreshSnapshot && snapshot?.localUnavailableReason
      ? 'unavailable'
      : tokenizerCapability?.status === 'exact'
        ? 'not_counted'
        : tokenizerCapability?.status === 'unavailable'
          ? 'unavailable'
          : 'unknown'
  const usedTokens = localUsedTokens ?? providerUsedTokens ?? 0
  const maxTokens = getContextWindowForModelRef(modelRef)
  const percent = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0
  return {
    usedTokens,
    maxTokens,
    percent,
    available: hasFreshSnapshot && maxTokens > 0 && (providerUsedTokens !== undefined || localUsedTokens !== undefined),
    source: localUsedTokens !== undefined ? 'local' : providerUsedTokens !== undefined ? 'provider' : 'none',
    providerUsedTokens,
    providerReportedAt: hasFreshSnapshot ? snapshot?.provider?.reportedAt : undefined,
    providerDifferenceTokens: hasFreshSnapshot ? snapshot?.provider?.localDifferenceTokens : undefined,
    providerCalibrationStatus: hasFreshSnapshot ? snapshot?.provider?.calibrationStatus : undefined,
    localUsedTokens,
    localCountedAt: hasFreshSnapshot ? snapshot?.local?.countedAt : undefined,
    localTokenizerId: hasFreshSnapshot ? snapshot?.local?.tokenizerId : undefined,
    localTokenizerState,
    localUnavailableReason: hasFreshSnapshot
      ? snapshot?.localUnavailableReason
      : tokenizerCapability?.status === 'unavailable'
        ? tokenizerCapability.reason
        : undefined,
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
      && (item.stage === 'reply' || item.stage === 'execute' || item.stage === 'ask_user')
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
    ? {
        usedTokens: Math.max(0, providerUsage.promptTokens),
        reportedAt: providerUsage.reportedAt,
        localDifferenceTokens: providerUsage.localCalibration?.differenceTokens,
        calibrationStatus: providerUsage.localCalibration?.status,
      }
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
