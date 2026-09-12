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

/** One selectable model of a provider, with every known number made explicit. */
export interface RuntimeProviderModel {
  id: string
  name: string
  /** True when the user declared metadata instead of a bare id. */
  declared: boolean
  contextWindow?: number
  maxOutputTokens?: number
  reasoningOptions: RuntimeReasoning[]
  vision?: boolean
}

export interface RuntimeProvider {
  id: string
  name: string
  baseURL: string
  api: 'openai-chat-completions'
  models: RuntimeProviderModel[]
  /** Header names only; values may carry gateway secrets and stay in config. */
  headerNames: string[]
  envVar: string | null
  requiresKey: boolean
  hasKey: boolean
  /** True for the built-in provider presets; those cannot be deleted. */
  builtin: boolean
}

/** A user-editable model entry as sent by the settings page. */
export interface ProviderModelDraft {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoningOptions?: RuntimeReasoning[]
  ultraEffort?: 'high' | 'xhigh' | 'max'
  vision?: boolean
  sourceUrl?: string
}

/** A provider draft sent by the settings page to create or update a provider. */
export interface ProviderDraft {
  id: string
  name?: string
  baseURL: string
  /** Either an env reference ("$MY_KEY") or a plaintext key stored in keychain. */
  apiKey?: string
  api?: 'openai-chat-completions'
  headers?: Record<string, string>
  timeoutSeconds?: number
  models?: Array<string | ProviderModelDraft>
}

export interface RuntimeState {
  model: string
  reasoning: RuntimeReasoning
  profile: AgentProfileId
  contextCompressionThresholdRatio: number
  durableHarnessMode: 'shadow' | 'next'
  durableHarnessSessionOverrides: Record<string, 'shadow' | 'next'>
  durableHarnessOriginOverrides: Record<string, 'shadow' | 'next'>
  durableHarnessProfileOverrides: Record<string, 'shadow' | 'next'>
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
  | 'model'
  | 'reasoning'
  | 'profile'
  | 'contextCompressionThresholdRatio'
  | 'durableHarnessMode'
  | 'durableHarnessSessionOverrides'
  | 'durableHarnessOriginOverrides'
  | 'durableHarnessProfileOverrides'
  | 'closePolicy'
  | 'workspace'
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
