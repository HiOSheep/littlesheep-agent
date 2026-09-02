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
}
