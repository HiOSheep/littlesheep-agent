// Shared projection contract for automatic session-compaction operation history.
//
// The Runtime owns these records; Renderer/Main only read the bounded, redacted
// projection. Usage tokens stay absent when the Provider did not report them.

export type CompactionOperationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'deferred'
export type CompactionOperationUsageStatus = 'reported' | 'partial' | 'unavailable'

export interface CompactionOperationUsage {
  requestCount: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  usageStatus: CompactionOperationUsageStatus
}

export interface CompactionOperationRecord {
  id: string
  sessionId: string
  force: boolean
  createdAt: string
  startedAt?: string
  settledAt?: string
  status: CompactionOperationStatus
  result?: 'compacted' | 'no-new-range'
  error?: string
  coalescedRequests: number
  usage?: CompactionOperationUsage
}
