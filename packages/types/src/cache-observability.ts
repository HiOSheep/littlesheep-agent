// @littlesheep/types - redacted prompt/cache observation contracts.
// These records describe cache evidence without retaining prompt or tool data.

import type { PermissionPolicyId } from './runtime-contracts.js';

export const CACHE_OBSERVATION_VERSION = 1 as const;
export const CACHE_USAGE_SCHEMA_VERSION = 'llm-chat-usage.v1' as const;
export const STABLE_PREFIX_VERSION = 'StablePrefixV1' as const;
export const DYNAMIC_SUFFIX_VERSION = 'DynamicSuffixV1' as const;
export const NORMALIZED_REQUEST_VERSION = 'NormalizedRequestV1' as const;

export type CacheObservationStatus = 'hit' | 'miss' | 'partial' | 'unavailable' | 'unknown';

/** Reasons are emitted by Runtime comparisons, never by the model. */
export type CacheInvalidationReason =
  | 'model_changed'
  | 'provider_changed'
  | 'adapter_changed'
  | 'prompt_version_changed'
  | 'system_policy_changed'
  | 'soul_changed'
  | 'user_profile_changed'
  | 'tool_schema_changed'
  | 'memory_revision_changed'
  | 'workspace_changed'
  | 'permission_changed'
  | 'session_reset'
  | 'summary_compacted'
  | 'locale_changed'
  | 'request_kind_changed'
  | 'manual_clear'
  | 'replayed'
  | 'unknown';

export type CacheFingerprintKeySource = 'provided' | 'ephemeral' | 'unavailable';

export interface CacheFingerprint {
  readonly version: 1;
  readonly algorithm: 'hmac-sha256';
  readonly keySource: CacheFingerprintKeySource;
  /** Full hexadecimal HMAC; absent when no local key was available. */
  readonly fingerprint?: string;
  readonly byteLength: number;
  readonly itemCount: number;
}

/** Scope is represented by non-reversible digests, never by paths or content. */
export interface CacheScopePartition {
  readonly version: 1;
  readonly sessionDigest?: string;
  readonly workspaceDigest?: string;
  readonly permissionPolicyId: PermissionPolicyId | 'unknown';
  readonly partitionDigest?: string;
  readonly keySource: CacheFingerprintKeySource;
}

export interface CacheLedgerObservation {
  readonly kind: 'provider_prompt' | 'ls_context' | 'memory_embedding';
  readonly status: CacheObservationStatus;
  readonly reason?: string;
  readonly requestCount: 1;
  readonly tokenCount?: number;
  readonly cachedTokenCount?: number;
  readonly hitRatio?: number;
}

export interface CacheComponentFingerprints {
  readonly provider: string;
  readonly model: string;
  readonly requestKind: string;
  readonly systemPrompt: string;
  readonly toolSchema: string;
  readonly scope: string;
}

/** HMAC-only fingerprints for prompt sources whose changes explain misses. */
export interface CachePromptComponentFingerprints {
  readonly promptVersion?: string;
  readonly systemPolicy?: string;
  readonly soul?: string;
  readonly userProfile?: string;
  readonly memoryRevision?: string;
  readonly summary?: string;
  readonly locale?: string;
}

/**
 * Redacted, request-bound cache evidence. No field contains prompt text,
 * user content, URLs, credentials, tool arguments, or provider raw JSON.
 */
export interface CacheObservation {
  readonly version: typeof CACHE_OBSERVATION_VERSION;
  readonly usageSchemaVersion: typeof CACHE_USAGE_SCHEMA_VERSION;
  readonly adapter: string;
  readonly provider: string;
  readonly model: string;
  readonly requestKind: string;
  readonly requestIndex: number;
  readonly modelRequestId: string;
  readonly scope: CacheScopePartition;
  readonly stablePrefixVersion: typeof STABLE_PREFIX_VERSION;
  readonly dynamicSuffixVersion: typeof DYNAMIC_SUFFIX_VERSION;
  readonly normalizedRequestVersion: typeof NORMALIZED_REQUEST_VERSION;
  readonly boundaryMarker: string;
  readonly stablePrefix: CacheFingerprint;
  readonly dynamicSuffix: CacheFingerprint;
  readonly normalizedRequest: CacheFingerprint;
  readonly components: CacheComponentFingerprints;
  readonly promptComponents?: CachePromptComponentFingerprints;
  readonly invalidationReasons: readonly CacheInvalidationReason[];
  readonly primaryInvalidationReason?: CacheInvalidationReason;
  readonly providerPrompt: CacheLedgerObservation;
  readonly lsContext: CacheLedgerObservation;
  readonly memoryEmbedding: CacheLedgerObservation;
}
