// Request-bound prompt/cache observability for the legacy Harness adapter.
// All persisted values are hashes, counts, versions and statuses. Raw prompt,
// user, tool-argument and credential-bearing values never leave this module.

import { createHmac, randomBytes } from 'node:crypto';
import type { ChatMessage, ChatRequest, ChatResponse, ToolSpec } from '@littlesheep/llm';
import type {
  CacheComponentFingerprints,
  CacheFingerprint,
  CacheFingerprintKeySource,
  CacheInvalidationReason,
  CacheLedgerObservation,
  CacheObservation,
  CacheObservationStatus,
  CacheScopePartition,
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
  readonly provider: string;
  readonly model: string;
  readonly requestKind: string;
  readonly requestIndex: number;
  readonly modelRequestId: string;
  readonly sessionId: string;
  readonly workspaceScope: string;
  readonly permissionPolicyId?: PermissionPolicyId;
  readonly previous?: CacheObservation;
  /** null explicitly disables hashing; undefined uses the process key. */
  readonly key?: string | null;
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
  const invalidationReasons = resolveInvalidationReasons(
    input,
    scope,
    components,
    fingerprint(key, scopeToken, 'stable-prefix', stableSerialized, keySourceOf(key), parts.stableMessages.length),
  );
  const keySource = keySourceOf(key);
  return Object.freeze({
    version: CACHE_OBSERVATION_VERSION,
    usageSchemaVersion: CACHE_USAGE_SCHEMA_VERSION,
    adapter: 'llm-chat',
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
    invalidationReasons,
    ...(invalidationReasons[0] ? { primaryInvalidationReason: invalidationReasons[0] } : {}),
    providerPrompt: pendingProviderCache(),
    lsContext: {
      kind: 'ls_context' as const,
      status: 'miss' as const,
      reason: 'context_request_assembled',
      requestCount: 1 as const,
    },
    memoryEmbedding: {
      kind: 'memory_embedding' as const,
      status: 'unavailable' as const,
      reason: 'memory_cache_event_not_observed',
      requestCount: 1 as const,
    },
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
  const { promptTokens, completionTokens, totalTokens, cachedPromptTokens, reasoningTokens } = usage;
  if (cachedPromptTokens === undefined) {
    return {
      ledger: {
        kind: 'provider_prompt',
        status: 'unavailable',
        reason: 'cached_prompt_tokens_missing',
        requestCount: 1,
        tokenCount: promptTokens,
      },
      validUsage: { promptTokens, completionTokens, totalTokens, cachedPromptTokens, reasoningTokens },
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
      },
      validUsage: { promptTokens, completionTokens, totalTokens, cachedPromptTokens, reasoningTokens },
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
      hitRatio: cachedPromptTokens / promptTokens,
    },
    validUsage: { promptTokens, completionTokens, totalTokens, cachedPromptTokens, reasoningTokens },
  };
}

export interface ValidProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
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
  currentStablePrefix: CacheFingerprint,
): readonly CacheInvalidationReason[] {
  const previous = input.previous;
  if (!previous) return Object.freeze([]);
  const reasons = new Set<CacheInvalidationReason>();
  if (previous.adapter !== 'llm-chat') reasons.add('adapter_changed');
  if (previous.provider !== input.provider) reasons.add('provider_changed');
  if (previous.model !== input.model) reasons.add('model_changed');
  if (previous.requestKind !== input.requestKind) reasons.add('request_kind_changed');
  if (previous.scope.permissionPolicyId !== scope.permissionPolicyId) reasons.add('permission_changed');
  if (previous.scope.sessionDigest !== scope.sessionDigest) reasons.add('session_reset');
  if (previous.scope.workspaceDigest !== scope.workspaceDigest) reasons.add('workspace_changed');
  const sameScope = previous.scope.partitionDigest !== undefined
    && previous.scope.partitionDigest === scope.partitionDigest;
  if (sameScope && previous.components.toolSchema !== components.toolSchema) reasons.add('tool_schema_changed');
  if (sameScope && previous.components.systemPrompt !== components.systemPrompt) reasons.add('prompt_version_changed');
  if (previous.stablePrefixVersion !== STABLE_PREFIX_VERSION || previous.boundaryMarker !== CACHE_BOUNDARY_MARKER) {
    reasons.add('prompt_version_changed');
  }
  if (sameScope && previous.stablePrefix.fingerprint !== currentStablePrefix.fingerprint) {
    // A stable prefix changed without a component-level explanation. Keep the
    // reason explicit instead of attributing the miss to Context or Provider.
    if (!reasons.has('tool_schema_changed') && !reasons.has('prompt_version_changed')) reasons.add('unknown');
  }
  return Object.freeze([...reasons].sort((left, right) => INVALIDATION_ORDER.indexOf(left) - INVALIDATION_ORDER.indexOf(right)));
}

function buildScopePartition(
  input: CacheObservationInput,
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

function splitRequestForCache(request: ChatRequest): {
  stableMessages: unknown[];
  dynamicMessages: unknown[];
} {
  const stableMessages: unknown[] = [];
  const dynamicMessages: unknown[] = [];
  request.messages.forEach((message, index) => {
    const normalized = normalizeMessage(message);
    if (message.role !== 'system') {
      dynamicMessages.push({ index, message: normalized });
      return;
    }
    if (typeof message.content !== 'string') {
      stableMessages.push({ index, message: normalized });
      return;
    }
    const content = normalizeText(message.content);
    const markerIndex = content.indexOf(CACHE_BOUNDARY_MARKER);
    if (markerIndex < 0) {
      stableMessages.push({ index, message: normalized });
      return;
    }
    const stableContent = content.slice(0, markerIndex).trimEnd();
    const dynamicContent = content.slice(markerIndex + CACHE_BOUNDARY_MARKER.length).trimStart();
    if (stableContent) stableMessages.push({ index, role: message.role, content: stableContent });
    if (dynamicContent) dynamicMessages.push({ index, role: message.role, content: dynamicContent });
  });
  return { stableMessages, dynamicMessages };
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

function normalizeMessage(message: ChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: typeof message.content === 'string'
      ? normalizeText(message.content)
      : message.content.map((part) => part.type === 'text'
        ? { type: 'text', text: normalizeText(part.text) }
        : { type: 'image_url', image_url: {
            url: normalizeText(part.image_url.url),
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
          } }),
    ...(message.reasoning_content ? { reasoning_content: normalizeText(message.reasoning_content) } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((call) => ({
        id: normalizeText(call.id),
        type: call.type,
        function: { name: normalizeText(call.function.name), arguments: normalizeText(call.function.arguments) },
      })),
    } : {}),
    ...(message.tool_call_id ? { tool_call_id: normalizeText(message.tool_call_id) } : {}),
    ...(message.name ? { name: normalizeText(message.name) } : {}),
  };
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

function normalizeText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC');
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
