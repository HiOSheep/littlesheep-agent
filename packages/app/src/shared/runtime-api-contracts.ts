// Stable runtime, provider and data-root payloads for Local App API.

import type {
  CompletedDataRootMigration,
  PendingDataRootMigration,
  PendingDataRootRollback,
} from '@littlesheep/branding'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { DesktopClosePolicy } from '@littlesheep/config'
import type { RuntimeReasoning } from './model-capabilities'

export interface ProviderInfo {
  id: string
  name?: string
  baseURL: string
  envVar: string | null
  hasKey: boolean
  source: 'env' | 'literal' | 'none'
}

export interface RuntimeProvider {
  id: string
  name: string
  baseURL: string
  models: string[]
  envVar: string | null
  requiresKey: boolean
  hasKey: boolean
}

export interface RuntimeState {
  model: string
  reasoning: RuntimeReasoning
  profile: AgentProfileId
  contextCompressionThresholdRatio: number
  closePolicy: DesktopClosePolicy
  workspace: string
  workplace: string
  providers: RuntimeProvider[]
}

export type RuntimePatch = Partial<Pick<
  RuntimeState,
  'model' | 'reasoning' | 'profile' | 'contextCompressionThresholdRatio' | 'closePolicy' | 'workspace'
>>

export interface DataRootStatus {
  managed: boolean
  currentDataDir: string
  defaultDataDir: string
  locatorPath: string
  environmentOverride?: string
  previousDataDir?: string
  pendingMigration?: PendingDataRootMigration
  pendingRollback?: PendingDataRootRollback
  lastMigration?: CompletedDataRootMigration
  requiresRestart: boolean
  canRollback: boolean
}

export type DataRootMigrationState = PendingDataRootMigration
export type DataRootRollbackState = PendingDataRootRollback

export type {
  CompletedDataRootMigration,
  PendingDataRootMigration,
  PendingDataRootRollback,
}
