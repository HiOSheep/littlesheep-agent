// Stable runtime, provider and data-root payloads for Local App API.

import type {
  CompletedDataRootMigration,
  PendingDataRootMigration,
  PendingDataRootRollback,
} from '@littlesheep/branding'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { DesktopClosePolicy } from '@littlesheep/config'
import type {
  BrowserFallbackMode,
  NetworkDnsResolver,
  NetworkReadMode,
  SensitiveQueryPolicy,
  WebErrorKind,
  WebProviderRuntimeStatus,
} from '@littlesheep/types'
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
  web: RuntimeWebState
}

export interface RuntimeWebState {
  enabled: boolean
  status: WebProviderRuntimeStatus
  providerId?: string
  providerConfigured: boolean
  readMode: NetworkReadMode
  dnsResolver: NetworkDnsResolver
  strictReadApproval: boolean
  allowDomains: string[]
  blockDomains: string[]
  cacheEnabled: boolean
  cacheTtlSeconds: number
  cacheMaxBytes: number
  browserFallback: BrowserFallbackMode
  sensitiveQueryPolicy: SensitiveQueryPolicy
  providerCheck?: RuntimeWebProviderCheck
  egress: readonly [
    'query_to_search_provider',
    'url_to_target_site',
    'evidence_to_current_llm_provider',
  ]
}

export interface RuntimeWebProviderCheck {
  providerId: string
  status: 'healthy' | 'degraded' | 'unavailable'
  checkedAt: string
  resultCount?: number
  errorKind?: WebErrorKind
}

export interface RuntimeWebPatch {
  enabled?: boolean
  readMode?: NetworkReadMode
  dnsResolver?: NetworkDnsResolver
  strictReadApproval?: boolean
  allowDomains?: string[]
  blockDomains?: string[]
  cacheEnabled?: boolean
  cacheTtlSeconds?: number
  cacheMaxBytes?: number
  browserFallback?: BrowserFallbackMode
  sensitiveQueryPolicy?: SensitiveQueryPolicy
}

export type RuntimePatch = Partial<Pick<
  RuntimeState,
  'model' | 'reasoning' | 'profile' | 'contextCompressionThresholdRatio' | 'closePolicy' | 'workspace'
>> & { web?: RuntimeWebPatch }

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
