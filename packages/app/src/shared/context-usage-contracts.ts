import type {
  ContextSnapshot,
  ModelRequestSnapshot,
  RunUsage,
} from '@littlesheep/types'

/**
 * The part of a durable context snapshot that is needed to rebuild the
 * composer counter. Context items themselves are intentionally omitted from
 * the session history response.
 */
export type PersistedContextUsageSnapshot = Pick<
  ContextSnapshot,
  'id' | 'provider' | 'model' | 'providerUsage' | 'localTokenLedger'
>

/** The request fields needed to select the reply-bearing context snapshot. */
export type PersistedContextUsageModelRequest = Pick<
  ModelRequestSnapshot,
  'stage' | 'contextSnapshotId'
> & Partial<Pick<ModelRequestSnapshot, 'provider' | 'model'>>

/** Durable, session-scoped context usage returned with a history page. */
export interface SessionContextUsageRecord {
  modelRef: string
  usage?: RunUsage
  contextSnapshots?: PersistedContextUsageSnapshot[]
  modelRequests?: PersistedContextUsageModelRequest[]
  /**
   * The session's own cumulative cache reuse summed over every run of the session.
   *
   * It uses the provider numbers the ledger judges (`cachedPromptTokens` over
   * `promptTokens`, cold start included) so the display and the acceptance gate
   * cannot disagree, and `requestsWithoutUsage` keeps a partial reading labelled
   * instead of presenting it as complete.
   */
  sessionCache?: SessionCumulativeCacheUsage
}

/** Session-cumulative cache reuse over the main conversation. */
export interface SessionCumulativeCacheUsage {
  inputTokens: number
  cachedTokens: number
  uncachedTokens: number
  measuredRequests: number
  requestsWithoutUsage: number
  /** Exact value; the display rounds, the judgement never does. */
  hitPercent?: number
}
