// Request-bound prompt/cache observability for the durable driver.
// All persisted values are hashes, counts, versions and statuses. Raw prompt,
// user, tool-argument and credential-bearing values never leave this module.

import { createHmac, randomBytes } from 'node:crypto';
import type { ChatRequest, ChatResponse, ToolSpec } from '@littlesheep/llm';
import type {
  CacheComponentFingerprints,
  CacheFingerprint,
  CacheFingerprintKeySource,
  CacheInvalidationReason,
  CacheLedgerObservation,
  CacheObservation,
  CachePromptComponentFingerprints,
  CacheObservationStatus,
  CacheScopePartition,
  ContextReuseEvent,
  MemoryReuseCounts,
  PermissionPolicyId,
} from '@littlesheep/types';
import {
  CACHE_OBSERVATION_VERSION,
  CACHE_USAGE_SCHEMA_VERSION,
  DYNAMIC_SUFFIX_VERSION,
  NORMALIZED_REQUEST_VERSION,
  STABLE_PREFIX_VERSION,
} from '@littlesheep/types';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import { contextReuseLedger, memoryReuseLedger } from './cache-local-ledgers.js';
import { normalizeMessage, normalizeText, splitRequestForCache } from './cache-prefix-split.js';

const EPHEMERAL_KEY = randomBytes(32);
const INVALIDATION_ORDER: readonly CacheInvalidationReason[] = [
  'model_changed',
  'provider_changed',
  'adapter_changed',
  'prompt_version_changed',
  'system_policy_changed',
  'soul_changed',
  'user_profile_changed',
  'tool_schema_changed',
  'memory_revision_changed',
  'workspace_changed',
  'permission_changed',
  'session_reset',
  'summary_compacted',
  'locale_changed',
  'request_kind_changed',
  'manual_clear',
  'replayed',
  'unknown',
];

export interface CacheObservationInput {
  readonly request: ChatRequest;
  /** Provider adapter identity; defaults to the built-in llm-chat adapter. */
  readonly adapter?: string;
  readonly provider: string;
  readonly model: string;
  readonly requestKind: string;
  readonly requestIndex: number;
  readonly modelRequestId: string;
  readonly sessionId: string;
  readonly workspaceScope: string;
  readonly permissionPolicyId?: PermissionPolicyId;
  readonly previous?: CacheObservation;
  /** Raw component values are accepted only in memory and emitted as HMACs. */
  readonly promptComponents?: CachePromptComponentInput;
  /** Runtime fact: the local context cache was explicitly cleared before this request. */
  readonly manualClear?: boolean;
  /** Runtime fact: this request rebuilt a previously replayed or reconstructed prompt. */
  readonly replayed?: boolean;
  /** Runtime fact: the Context Engine reused a previous identical assembly. */
  readonly contextReuse?: ContextReuseEvent;
  /** Runtime fact: local embedding reuse/queue counts since the run started. */
  readonly memoryReuse?: MemoryReuseCounts;
  /** null explicitly disables hashing; undefined uses the process key. */
  readonly key?: string | null;
}

/** The non-content scope identity used before reading a cache entry. */
export interface CacheScopeInput {
  readonly sessionId: string;
  readonly workspaceScope: string;
  readonly permissionPolicyId?: PermissionPolicyId;
  /** null disables hashing and therefore cannot authorize a cache read. */
  readonly key?: string | null;
}

export type CacheScopeAccessDecision =
  | {
      readonly allowed: true;
      readonly reason: 'scope_match';
    }
  | {
      readonly allowed: false;
      readonly reason: 'key_unavailable' | 'scope_unavailable' | 'scope_mismatch' | 'key_source_mismatch';
    };

export type CachePromptComponentInput = Partial<Record<keyof CachePromptComponentFingerprints, string | number | null>>;

/**
 * Build the redacted cache partition without assembling or exposing a prompt.
 * This is deliberately a separate API so cache adapters can authorize a read
 * before looking up or returning an entry.
 */
export function buildCacheScopePartition(input: CacheScopeInput): CacheScopePartition {
  const key = resolveKey(input.key);
  return buildScopePartition(input, key);
}

/**
 * Verify that a cache observation belongs to the current Runtime scope.
 * A matching prompt prefix alone is insufficient: session, workspace and
 * permission scope must all be proven first.
 */
export function authorizeCacheObservationScope(
  observation: CacheObservation,
  input: CacheScopeInput,
): CacheScopeAccessDecision {
  if (!input.sessionId.trim() || !input.workspaceScope.trim() || !input.permissionPolicyId) {
    return { allowed: false, reason: 'scope_unavailable' };
  }
  const expected = buildCacheScopePartition(input);
  if (!observation.scope.partitionDigest || !expected.partitionDigest) {
    return { allowed: false, reason: 'key_unavailable' };
  }
  if (observation.scope.permissionPolicyId === 'unknown' || expected.permissionPolicyId === 'unknown') {
    return { allowed: false, reason: 'scope_unavailable' };
  }
  if (observation.scope.keySource !== expected.keySource) {
    return { allowed: false, reason: 'key_source_mismatch' };
  }
  return observation.scope.partitionDigest === expected.partitionDigest
    ? { allowed: true, reason: 'scope_match' }
    : { allowed: false, reason: 'scope_mismatch' };
}

/** Fail-closed assertion for adapters that cannot continue after a mismatch. */
export function assertCacheObservationScope(
  observation: CacheObservation,
  input: CacheScopeInput,
): void {
  const decision = authorizeCacheObservationScope(observation, input);
  if (!decision.allowed) {
    throw new Error(`cache scope authorization denied: ${decision.reason}`);
  }
}

/**
 * Return a deterministic copy of a provider tool schema array. The secondary
 * canonical comparison handles the invalid-but-observable case of duplicate
 * tool names with different schemas without depending on insertion order.
 */
export function orderToolSpecs(tools: readonly ToolSpec[] | undefined): ToolSpec[] | undefined {
  if (!tools) return undefined;
  return [...tools].sort((left, right) => compareToolSpecs(left, right));
}

/** Build redacted stable-prefix, dynamic-suffix and complete-request evidence. */
export function buildCacheObservation(input: CacheObservationInput): CacheObservation {
  const key = resolveKey(input.key);
  const adapter = input.adapter ?? 'llm-chat';
  const scope = buildScopePartition(input, key);
  const scopeToken = scope.partitionDigest ?? 'unavailable';
  const normalized = normalizeRequest(input.request);
  const parts = splitRequestForCache(input.request);
  const stablePayload = {
    version: STABLE_PREFIX_VERSION,
    boundary: CACHE_BOUNDARY_MARKER,
    provider: input.provider,
    model: input.model,
    requestKind: input.requestKind,
    messages: parts.stableMessages,
    // Tool registration can arrive in a different order after a restart or
    // concurrent discovery. Canonicalize it before hashing so order alone
    // cannot invalidate the Provider's stable prefix.
    tools: normalizeTools(input.request.tools, true),
  };
  const dynamicPayload = {
    version: DYNAMIC_SUFFIX_VERSION,
    messages: parts.dynamicMessages,
    request: normalized.requestParameters,
  };
  const normalizedPayload = {
    version: NORMALIZED_REQUEST_VERSION,
    request: normalized.full,
  };
  const stableSerialized = canonicalSerialize(stablePayload);
  const dynamicSerialized = canonicalSerialize(dynamicPayload);
  const normalizedSerialized = canonicalSerialize(normalizedPayload);
  const components: CacheComponentFingerprints = Object.freeze({
    provider: componentFingerprint(key, scopeToken, 'provider', input.provider),
    model: componentFingerprint(key, scopeToken, 'model', input.model),
    requestKind: componentFingerprint(key, scopeToken, 'request-kind', input.requestKind),
    systemPrompt: componentFingerprint(key, scopeToken, 'system-prompt', parts.stableMessages),
    toolSchema: componentFingerprint(key, scopeToken, 'tool-schema', normalizeTools(input.request.tools, true)),
    scope: scope.partitionDigest ?? 'unavailable',
  });
  const promptComponents = fingerprintPromptComponents(key, scopeToken, input.promptComponents);
  const invalidationReasons = resolveInvalidationReasons(
    input,
    scope,
    components,
    promptComponents,
    fingerprint(key, scopeToken, 'stable-prefix', stableSerialized, keySourceOf(key), parts.stableMessages.length),
  );
  const keySource = keySourceOf(key);
  return Object.freeze({
    version: CACHE_OBSERVATION_VERSION,
    usageSchemaVersion: CACHE_USAGE_SCHEMA_VERSION,
    adapter,
    provider: input.provider,
    model: input.model,
    requestKind: input.requestKind,
    requestIndex: input.requestIndex,
    modelRequestId: input.modelRequestId,
    scope,
    stablePrefixVersion: STABLE_PREFIX_VERSION,
    dynamicSuffixVersion: DYNAMIC_SUFFIX_VERSION,
    normalizedRequestVersion: NORMALIZED_REQUEST_VERSION,
    boundaryMarker: CACHE_BOUNDARY_MARKER,
    stablePrefix: fingerprint(key, scopeToken, 'stable-prefix', stableSerialized, keySource, parts.stableMessages.length),
    dynamicSuffix: fingerprint(key, scopeToken, 'dynamic-suffix', dynamicSerialized, keySource, parts.dynamicMessages.length),
    normalizedRequest: fingerprint(key, scopeToken, 'normalized-request', normalizedSerialized, keySource, input.request.messages.length + (input.request.tools?.length ?? 0)),
    components,
    ...(promptComponents ? { promptComponents } : {}),
    invalidationReasons,
    ...(invalidationReasons[0] ? { primaryInvalidationReason: invalidationReasons[0] } : {}),
    providerPrompt: pendingProviderCache(),
    lsContext: contextReuseLedger(input.contextReuse),
    memoryEmbedding: memoryReuseLedger(input.memoryReuse),
  });
}

/** Classify provider usage without turning local estimates into cache facts. */
export function classifyProviderCacheUsage(
  usage: ChatResponse['usage'] | undefined,
): { ledger: CacheLedgerObservation; validUsage?: ValidProviderUsage; reason?: string } {
  if (!usage) {
    return { ledger: unavailableProviderCache('provider_usage_missing'), reason: 'provider_usage_missing' };
  }
  const invalid = validateProviderUsage(usage);
  if (invalid) {
    return {
      ledger: {
        kind: 'provider_prompt',
        status: 'unknown',
        reason: invalid,
        requestCount: 1,
      },
      reason: invalid,
    };
  }
  const { promptTokens, completionTokens, totalTokens, cachedPromptTokens, uncachedPromptTokens, reasoningTokens } = usage;
  if (cachedPromptTokens === undefined) {
    return {
      ledger: {
        kind: 'provider_prompt',
        status: 'unavailable',
        reason: 'cached_prompt_tokens_missing',
        requestCount: 1,
        tokenCount: promptTokens,
      },
      validUsage: { promptTokens, completionTokens, totalTokens, cachedPromptTokens, uncachedPromptTokens, reasoningTokens },
    };
  }
  if (promptTokens === 0) {
    return {
      ledger: {
        kind: 'provider_prompt',
        status: 'unknown',
        reason: 'prompt_tokens_zero',
        requestCount: 1,
        tokenCount: promptTokens,
        cachedTokenCount: cachedPromptTokens,
        ...(uncachedPromptTokens === undefined ? {} : { uncachedTokenCount: uncachedPromptTokens }),
      },
      validUsage: { promptTokens, completionTokens, totalTokens, cachedPromptTokens, uncachedPromptTokens, reasoningTokens },
    };
  }
  const status: CacheObservationStatus = cachedPromptTokens === 0
    ? 'miss'
    : cachedPromptTokens === promptTokens
      ? 'hit'
      : 'partial';
  return {
    ledger: {
      kind: 'provider_prompt',
      status,
      requestCount: 1,
      tokenCount: promptTokens,
      cachedTokenCount: cachedPromptTokens,
      ...(uncachedPromptTokens === undefined ? {} : { uncachedTokenCount: uncachedPromptTokens }),
      hitRatio: cachedPromptTokens / promptTokens,
    },
    validUsage: { promptTokens, completionTokens, totalTokens, cachedPromptTokens, uncachedPromptTokens, reasoningTokens },
  };
}

export interface ValidProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly uncachedPromptTokens?: number;
  readonly reasoningTokens?: number;
}

/** Stable JSON-like serialization used before hashing cache observations. */
export function canonicalSerialize(value: unknown): string {
  return canonicalValue(value, new WeakSet<object>(), false);
}

function canonicalValue(value: unknown, seen: WeakSet<object>, inArray: boolean): string {
  if (value === null) return 'null';
  if (value === undefined) return inArray ? 'null' : '';
  if (typeof value === 'string') return JSON.stringify(normalizeText(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return Object.is(value, -0) ? '0' : 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) return JSON.stringify('[Circular]');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => canonicalValue(entry, seen, true)).join(',')}]`;
  } else if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, entry]) => [canonicalValue(key, seen, false), canonicalValue(entry, seen, false)] as const)
      .sort((left, right) => compareCodePoints(left[0], right[0]));
    result = `{"$map":[${entries.map(([key, entry]) => `[${key},${entry}]`).join(',')}]}`;
  } else if (value instanceof Set) {
    const entries = [...value.values()]
      .map((entry) => canonicalValue(entry, seen, false))
      .sort(compareCodePoints);
    result = `{"$set":[${entries.join(',')}]}`;
  } else if (value instanceof Date) {
    result = JSON.stringify(normalizeText(value.toISOString()));
  } else {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .map((key) => [normalizeText(key), key] as const)
      .sort((left, right) => compareCodePoints(left[0], right[0]) || compareCodePoints(left[1], right[1]));
    result = `{${entries.flatMap(([normalizedKey, sourceKey]) => {
      const encoded = canonicalValue(record[sourceKey], seen, false);
      return encoded === '' ? [] : [`${JSON.stringify(normalizedKey)}:${encoded}`];
    }).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function resolveInvalidationReasons(
  input: CacheObservationInput,
  scope: CacheScopePartition,
  components: CacheComponentFingerprints,
  promptComponents: CachePromptComponentFingerprints | undefined,
  currentStablePrefix: CacheFingerprint,
): readonly CacheInvalidationReason[] {
  const reasons = new Set<CacheInvalidationReason>();
  if (input.manualClear) reasons.add('manual_clear');
  if (input.replayed) reasons.add('replayed');
  const finalize = () => Object.freeze(
    [...reasons].sort((left, right) => INVALIDATION_ORDER.indexOf(left) - INVALIDATION_ORDER.indexOf(right)),
  );
  const previous = input.previous;
  if (!previous) return finalize();
  const sameScope = previous.scope.partitionDigest !== undefined
    && previous.scope.partitionDigest === scope.partitionDigest;
  if (previous.adapter !== (input.adapter ?? 'llm-chat')) reasons.add('adapter_changed');
  if (previous.provider !== input.provider) reasons.add('provider_changed');
  if (previous.model !== input.model) reasons.add('model_changed');
  if (previous.requestKind !== input.requestKind) reasons.add('request_kind_changed');
  if (previous.scope.permissionPolicyId !== scope.permissionPolicyId) reasons.add('permission_changed');
  if (previous.scope.sessionDigest !== scope.sessionDigest) reasons.add('session_reset');
  if (previous.scope.workspaceDigest !== scope.workspaceDigest) reasons.add('workspace_changed');
  if (sameScope) {
    comparePromptComponent(previous, promptComponents, 'promptVersion', 'prompt_version_changed', reasons);
    comparePromptComponent(previous, promptComponents, 'systemPolicy', 'system_policy_changed', reasons);
    comparePromptComponent(previous, promptComponents, 'soul', 'soul_changed', reasons);
    comparePromptComponent(previous, promptComponents, 'userProfile', 'user_profile_changed', reasons);
    comparePromptComponent(previous, promptComponents, 'memoryRevision', 'memory_revision_changed', reasons);
    comparePromptComponent(previous, promptComponents, 'summary', 'summary_compacted', reasons);
    comparePromptComponent(previous, promptComponents, 'locale', 'locale_changed', reasons);
  }
  if (sameScope && previous.components.toolSchema !== components.toolSchema) reasons.add('tool_schema_changed');
  if (sameScope
    && previous.components.systemPrompt !== components.systemPrompt
    && ![
      'prompt_version_changed',
      'system_policy_changed',
      'soul_changed',
      'user_profile_changed',
    ].some((reason) => reasons.has(reason as CacheInvalidationReason))) {
    reasons.add('prompt_version_changed');
  }
  if (previous.stablePrefixVersion !== STABLE_PREFIX_VERSION || previous.boundaryMarker !== CACHE_BOUNDARY_MARKER) {
    reasons.add('prompt_version_changed');
  }
  if (sameScope && previous.stablePrefix.fingerprint !== currentStablePrefix.fingerprint) {
    // A stable prefix changed without a component-level explanation. Keep the
    // reason explicit instead of attributing the miss to Context or Provider.
    if (reasons.size === 0) reasons.add('unknown');
  }
  return finalize();
}

function comparePromptComponent(
  previous: CacheObservation,
  current: CachePromptComponentFingerprints | undefined,
  key: keyof CachePromptComponentFingerprints,
  reason: CacheInvalidationReason,
  reasons: Set<CacheInvalidationReason>,
): void {
  const currentValue = current?.[key];
  const previousValue = previous.promptComponents?.[key];
  if (currentValue === undefined && previousValue === undefined) return;
  if (currentValue !== previousValue) reasons.add(reason);
}

function fingerprintPromptComponents(
  key: ResolvedKey,
  scopeToken: string,
  components: CachePromptComponentInput | undefined,
): CachePromptComponentFingerprints | undefined {
  if (!components) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(components)) {
    if (value === undefined || value === null) continue;
    result[name] = componentFingerprint(
      key,
      scopeToken,
      `prompt-component:${name}`,
      value,
    );
  }
  return Object.keys(result).length > 0 ? Object.freeze(result as CachePromptComponentFingerprints) : undefined;
}

function buildScopePartition(
  input: Pick<CacheObservationInput, 'sessionId' | 'workspaceScope' | 'permissionPolicyId'>,
  key: ResolvedKey,
): CacheScopePartition {
  const session = normalizeText(input.sessionId);
  const workspace = normalizeWorkspaceScope(input.workspaceScope);
  const permission = input.permissionPolicyId ?? 'unknown';
  return Object.freeze({
    version: 1,
    sessionDigest: digestValue(key, 'scope-session', session),
    workspaceDigest: digestValue(key, 'scope-workspace', workspace),
    permissionPolicyId: permission,
    partitionDigest: digestValue(key, 'scope-partition', `${session}\0${workspace}\0${permission}`),
    keySource: keySourceOf(key),
  });
}

function normalizeRequest(request: ChatRequest): {
  full: Record<string, unknown>;
  requestParameters: Record<string, unknown>;
} {
  const { signal: _signal, timeoutMs: _timeoutMs, ...providerRequest } = request;
  const requestParameters = { ...providerRequest } as Record<string, unknown>;
  delete requestParameters.model;
  delete requestParameters.messages;
  delete requestParameters.tools;
  const full = {
    ...providerRequest,
    messages: request.messages.map(normalizeMessage),
    tools: normalizeTools(request.tools, true),
  };
  return { full, requestParameters };
}

function normalizeTools(tools: ToolSpec[] | undefined, sortByName = true): unknown[] {
  const normalized = [...(tools ?? [])]
    .map((tool) => ({
      type: tool.type,
      function: {
        name: normalizeText(tool.function.name),
        description: normalizeText(tool.function.description),
        parameters: tool.function.parameters,
      },
    }));
  return sortByName
    ? normalized.sort((left, right) => (
        compareCodePoints(left.function.name, right.function.name)
        || compareCodePoints(canonicalSerialize(left), canonicalSerialize(right))
      ))
    : normalized;
}

function compareToolSpecs(left: ToolSpec, right: ToolSpec): number {
  const nameOrder = compareCodePoints(normalizeText(left.function.name), normalizeText(right.function.name));
  if (nameOrder !== 0) return nameOrder;
  return compareCodePoints(
    canonicalSerialize({
      type: left.type,
      function: {
        name: normalizeText(left.function.name),
        description: normalizeText(left.function.description),
        parameters: left.function.parameters,
      },
    }),
    canonicalSerialize({
      type: right.type,
      function: {
        name: normalizeText(right.function.name),
        description: normalizeText(right.function.description),
        parameters: right.function.parameters,
      },
    }),
  );
}

function pendingProviderCache(): CacheLedgerObservation {
  return {
    kind: 'provider_prompt',
    status: 'unavailable',
    reason: 'provider_usage_pending',
    requestCount: 1,
  };
}

function unavailableProviderCache(reason: string): CacheLedgerObservation {
  return {
    kind: 'provider_prompt',
    status: 'unavailable',
    reason,
    requestCount: 1,
  };
}

type ResolvedKey = { readonly bytes: Uint8Array; readonly source: CacheFingerprintKeySource } | undefined;

function resolveKey(key: string | null | undefined): ResolvedKey {
  if (key === null) return undefined;
  if (key !== undefined && key.length > 0) return { bytes: Buffer.from(key, 'utf8'), source: 'provided' };
  return { bytes: EPHEMERAL_KEY, source: 'ephemeral' };
}

function keySourceOf(key: ResolvedKey): CacheFingerprintKeySource {
  return key?.source ?? 'unavailable';
}

function fingerprint(
  key: ResolvedKey,
  scopeToken: string,
  domain: string,
  serialized: string,
  keySource: CacheFingerprintKeySource,
  itemCount: number,
): CacheFingerprint {
  return Object.freeze({
    version: 1,
    algorithm: 'hmac-sha256',
    keySource,
    ...(key ? { fingerprint: hmac(key.bytes, `${domain}\0${scopeToken}\0${serialized}`) } : {}),
    byteLength: Buffer.byteLength(serialized, 'utf8'),
    itemCount,
  });
}

function componentFingerprint(key: ResolvedKey, scopeToken: string, domain: string, value: unknown): string {
  return key ? hmac(key.bytes, `${domain}\0${scopeToken}\0${canonicalSerialize(value)}`) : 'unavailable';
}

function digestValue(key: ResolvedKey, domain: string, value: string): string | undefined {
  return key ? hmac(key.bytes, `${domain}\0${value}`) : undefined;
}

function hmac(key: Uint8Array, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function validateProviderUsage(usage: NonNullable<ChatResponse['usage']>): string | undefined {
  if (!isCounter(usage.promptTokens)) return 'prompt_tokens_invalid';
  if (!isCounter(usage.completionTokens)) return 'completion_tokens_invalid';
  if (usage.totalTokens !== undefined && (!isCounter(usage.totalTokens) || usage.totalTokens < usage.promptTokens + usage.completionTokens)) {
    return 'total_tokens_invalid';
  }
  if (usage.cachedPromptTokens !== undefined && !isCounter(usage.cachedPromptTokens)) return 'cached_prompt_tokens_invalid';
  if (usage.cachedPromptTokens !== undefined && usage.cachedPromptTokens > usage.promptTokens) return 'cached_prompt_tokens_exceed_prompt';
  // The split must stay disjoint: uncached + cached may not exceed the prompt.
  if (usage.uncachedPromptTokens !== undefined && !isCounter(usage.uncachedPromptTokens)) return 'uncached_prompt_tokens_invalid';
  if (usage.uncachedPromptTokens !== undefined
    && usage.cachedPromptTokens !== undefined
    && usage.cachedPromptTokens + usage.uncachedPromptTokens > usage.promptTokens) {
    return 'cache_split_exceeds_prompt';
  }
  if (usage.reasoningTokens !== undefined && !isCounter(usage.reasoningTokens)) return 'reasoning_tokens_invalid';
  return undefined;
}

function isCounter(value: number): value is number {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeWorkspaceScope(value: string): string {
  const normalized = normalizeText(value).replaceAll('\\', '/');
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
