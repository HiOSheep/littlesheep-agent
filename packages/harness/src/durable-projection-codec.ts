// Codec and bounded readers for durable event payloads.
// This module owns the untrusted payload boundary; the kernel owns transitions.
import type {
  CacheObservation,
  DurableCapabilityProbeProjection,
  DurableCapabilitySnapshotProjection,
  DurableEffectProjection,
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableInboxCommand,
  DurableModelRequestStatus,
  DurableModelTransportStatus,
  DurableProviderUsageProjection,
  DurableRunProjection,
} from '@littlesheep/types';
import {
  CACHE_USAGE_SCHEMA_VERSION,
  DYNAMIC_SUFFIX_VERSION,
  NORMALIZED_REQUEST_VERSION,
  STABLE_PREFIX_VERSION,
} from '@littlesheep/types';
import { DurableKernelError } from './durable-kernel-error.js';

export function validateEventInput(input: DurableHarnessEventAppendInput): void {
  if (typeof input.sessionId !== 'string' || typeof input.runId !== 'string' || typeof input.idempotencyKey !== 'string'
    || !input.sessionId.trim() || !input.runId.trim() || !input.idempotencyKey.trim()) {
    throw new DurableKernelError('event identity fields must be non-empty strings', 'invalid');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new DurableKernelError('event payload must be an object', 'invalid');
  }
}

export function validateSource(event: DurableHarnessEventAppendInput | DurableHarnessEvent): void {
  const expected: Partial<Record<DurableHarnessEvent['type'], readonly string[]>> = {
    run_accepted: ['runtime', 'app', 'channel'],
    user_input_appended: ['app', 'channel'],
    capability_snapshot_read: ['runtime'],
    capability_probe_settled: ['runtime'],
    route_decided: ['runtime'],
    stage_transition_recorded: ['runtime'],
    model_request_started: ['runtime'],
    model_response_received: ['model', 'runtime'],
    model_request_settled: ['runtime'],
    tool_call_proposed: ['model', 'runtime'],
    effect_intent_created: ['runtime'],
    effect_settled: ['tool', 'runtime'],
    verification_recorded: ['runtime'],
    checkpoint_written: ['runtime'],
    final_reply_proposed: ['model', 'runtime'],
    final_reply_settled: ['runtime'],
    runtime_status_settled: ['runtime'],
    run_failed: ['runtime'],
    run_interrupted: ['runtime'],
    run_completed: ['runtime'],
  };
  if (!expected[event.type]?.includes(event.source)) {
    throw new DurableKernelError(`invalid source ${event.source} for ${event.type}`, 'invalid');
  }
}

export function readEffectIntent(event: DurableHarnessEvent): DurableEffectProjection {
  const effectId = requiredString(event.payload.effectId, 'effect_intent_created.effectId');
  const idempotencyKey = requiredString(event.payload.idempotencyKey, 'effect_intent_created.idempotencyKey');
  const toolName = requiredString(event.payload.toolName, 'effect_intent_created.toolName');
  const effectKind = event.payload.effectKind;
  if (effectKind !== 'local_mutation' && effectKind !== 'external' && effectKind !== 'unknown') {
    throw new DurableKernelError('invalid effect kind', 'invalid');
  }
  return {
    effectId,
    idempotencyKey,
    toolName,
    effectKind,
    status: 'planned',
    intentEventId: event.eventId,
    ...(typeof event.payload.inputHash === 'string' ? { inputHash: event.payload.inputHash } : {}),
  };
}

export function readCapabilitySnapshot(
  event: { payload: Record<string, unknown> },
): DurableCapabilitySnapshotProjection {
  const snapshot = event.payload.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new DurableKernelError('capability_snapshot_read.snapshot must be an object', 'invalid');
  }
  const record = snapshot as Record<string, unknown>;
  const capabilityEpoch = requiredString(record.capabilityEpoch, 'capability_snapshot_read.capabilityEpoch');
  const permissionPolicyId = requiredString(record.permissionPolicyId, 'capability_snapshot_read.permissionPolicyId');
  const workspace = record.workspace;
  if (workspace !== 'available' && workspace !== 'approval_required' && workspace !== 'denied' && workspace !== 'unavailable') {
    throw new DurableKernelError('invalid capability workspace status', 'invalid');
  }
  if (!Array.isArray(record.tools)) {
    throw new DurableKernelError('capability_snapshot_read.tools must be an array', 'invalid');
  }
  const tools = record.tools.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new DurableKernelError(`invalid capability tool at ${index}`, 'invalid');
    }
    const tool = item as Record<string, unknown>;
    const name = requiredString(tool.name, `capability_snapshot_read.tools[${index}].name`);
    const status = tool.status;
    if (status !== 'available' && status !== 'approval_required') {
      throw new DurableKernelError(`invalid capability tool status at ${index}`, 'invalid');
    }
    const source = tool.source;
    if (source !== 'builtin' && source !== 'external') {
      throw new DurableKernelError(`invalid capability tool source at ${index}`, 'invalid');
    }
    return { name, status, source } as const;
  });
  const network = record.network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) {
    throw new DurableKernelError('invalid capability network state', 'invalid');
  }
  const networkRecord = network as Record<string, unknown>;
  if (typeof networkRecord.enabled !== 'boolean') {
    throw new DurableKernelError('capability network enabled must be boolean', 'invalid');
  }
  const networkStatus = requiredString(networkRecord.status, 'capability_snapshot_read.network.status');
  const providerId = typeof networkRecord.providerId === 'string' && networkRecord.providerId.trim()
    ? networkRecord.providerId.trim()
    : undefined;
  return {
    capabilityEpoch,
    permissionPolicyId,
    workspace,
    tools,
    network: { enabled: networkRecord.enabled, status: networkStatus, ...(providerId ? { providerId } : {}) },
  };
}

export function readCapabilityProbe(
  event: { payload: Record<string, unknown> },
): DurableCapabilityProbeProjection {
  const probeId = requiredString(event.payload.probeId, 'capability_probe_settled.probeId');
  const status = event.payload.status;
  if (status !== 'observed' && status !== 'unavailable') {
    throw new DurableKernelError('invalid capability probe status', 'invalid');
  }
  const capabilityEpoch = requiredString(event.payload.capabilityEpoch, 'capability_probe_settled.capabilityEpoch');
  if (event.payload.evidence !== 'runtime_snapshot') {
    throw new DurableKernelError('invalid capability probe evidence', 'invalid');
  }
  const permissionDecision = event.payload.permissionDecision;
  if (permissionDecision !== 'allow' && permissionDecision !== 'approval_required'
    && permissionDecision !== 'deny' && permissionDecision !== 'unavailable') {
    throw new DurableKernelError('invalid capability probe permission decision', 'invalid');
  }
  return { probeId, status, capabilityEpoch, evidence: 'runtime_snapshot', permissionDecision };
}

export function isModelTransportStatus(value: unknown): value is DurableModelTransportStatus {
  return value === 'not_started' || value === 'streaming' || value === 'completed'
    || value === 'aborted' || value === 'timeout' || value === 'rate_limit'
    || value === 'connection_reset' || value === 'failed' || value === 'unknown';
}

export function isProviderReachStatus(value: unknown): value is 'reached' | 'not_reached' | 'unknown' {
  return value === 'reached' || value === 'not_reached' || value === 'unknown';
}

export function readProviderUsage(payload: Record<string, unknown>): DurableProviderUsageProjection | undefined {
  const promptTokens = payload.promptTokens;
  const completionTokens = payload.completionTokens;
  if (!Number.isSafeInteger(promptTokens) || (promptTokens as number) < 0
    || !Number.isSafeInteger(completionTokens) || (completionTokens as number) < 0) {
    if (payload.usageStatus === 'available') {
      throw new DurableKernelError('provider usage requires non-negative integer prompt/completion tokens', 'invalid');
    }
    return undefined;
  }
  const totalTokens = optionalNonNegativeInteger(payload.totalTokens, 'totalTokens');
  const cachedPromptTokens = optionalNonNegativeInteger(payload.cachedPromptTokens, 'cachedPromptTokens');
  const reasoningTokens = optionalNonNegativeInteger(payload.reasoningTokens, 'reasoningTokens');
  const cacheStatus = payload.cacheStatus;
  if (cacheStatus !== 'hit' && cacheStatus !== 'miss' && cacheStatus !== 'partial'
    && cacheStatus !== 'unavailable' && cacheStatus !== 'unknown') {
    throw new DurableKernelError('provider usage requires a cache status', 'invalid');
  }
  const reconciliation = payload.reconciliation;
  if (reconciliation !== 'exact_match' && reconciliation !== 'within_tolerance'
    && reconciliation !== 'mismatch' && reconciliation !== 'unavailable') {
    throw new DurableKernelError('provider usage requires a local reconciliation status', 'invalid');
  }
  const promptTokenCount = promptTokens as number;
  const completionTokenCount = completionTokens as number;
  if (cachedPromptTokens !== undefined && cachedPromptTokens > promptTokenCount) {
    throw new DurableKernelError('cached prompt tokens cannot exceed prompt tokens', 'invalid');
  }
  if (totalTokens !== undefined && totalTokens < promptTokenCount + completionTokenCount) {
    throw new DurableKernelError('total tokens cannot be below prompt plus completion tokens', 'invalid');
  }
  const localCalibration = readLocalTokenCalibration(
    payload.localCalibration,
    promptTokenCount,
    reconciliation,
  );
  return {
    promptTokens: promptTokenCount,
    completionTokens: completionTokenCount,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    cacheStatus,
    reconciliation,
    ...(localCalibration ? { localCalibration } : {}),
  };
}

function readLocalTokenCalibration(
  value: unknown,
  providerPromptTokens: number,
  reconciliation: DurableProviderUsageProjection['reconciliation'],
): NonNullable<DurableProviderUsageProjection['localCalibration']> | undefined {
  if (value === undefined) {
    if (reconciliation !== 'unavailable') {
      throw new DurableKernelError('provider usage reconciliation requires local calibration evidence', 'invalid');
    }
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError('provider usage local calibration must be an object', 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, [
    'version',
    'tokenizerId',
    'localPromptTokens',
    'differenceTokens',
    'relativeDifference',
    'status',
  ], 'providerUsage.localCalibration');
  if (record.version !== 1) {
    throw new DurableKernelError('provider usage local calibration version is unsupported', 'invalid');
  }
  const tokenizerId = boundedProjectionString(
    record.tokenizerId,
    'providerUsage.localCalibration.tokenizerId',
    128,
  );
  const localPromptTokens = requiredNonNegativeInteger(
    record.localPromptTokens,
    'providerUsage.localCalibration.localPromptTokens',
  );
  const differenceTokens = requiredSafeInteger(
    record.differenceTokens,
    'providerUsage.localCalibration.differenceTokens',
  );
  const relativeDifference = requiredFiniteNonNegativeNumber(
    record.relativeDifference,
    'providerUsage.localCalibration.relativeDifference',
  );
  const status = record.status;
  if (status !== 'exact_match' && status !== 'within_tolerance' && status !== 'drift') {
    throw new DurableKernelError('provider usage local calibration status is invalid', 'invalid');
  }
  if (differenceTokens !== providerPromptTokens - localPromptTokens) {
    throw new DurableKernelError(
      'provider usage local calibration difference does not match prompt tokens',
      'invalid',
    );
  }
  const expectedRelativeDifference = providerPromptTokens === 0
    ? (differenceTokens === 0 ? 0 : 1)
    : Math.abs(differenceTokens) / providerPromptTokens;
  if (Math.abs(relativeDifference - expectedRelativeDifference) > 1e-9) {
    throw new DurableKernelError(
      'provider usage local calibration relative difference is inconsistent',
      'invalid',
    );
  }
  const expectedReconciliation = status === 'drift' ? 'mismatch' : status;
  if (reconciliation !== expectedReconciliation) {
    throw new DurableKernelError(
      'provider usage reconciliation does not match local calibration',
      'invalid',
    );
  }
  return {
    version: 1,
    tokenizerId,
    localPromptTokens,
    differenceTokens,
    relativeDifference,
    status,
  };
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DurableKernelError(`${label} must be a safe integer`, 'invalid');
  }
  return value as number;
}

function requiredFiniteNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DurableKernelError(`${label} must be a finite non-negative number`, 'invalid');
  }
  return value;
}

/** Validate redacted cache evidence before it enters a durable projection. */
export function readCacheObservation(value: unknown, expectedRequestId?: string): CacheObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError('model cache observation must be an object', 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, [
    'version', 'usageSchemaVersion', 'adapter', 'provider', 'model', 'requestKind', 'requestIndex', 'modelRequestId',
    'scope', 'stablePrefixVersion', 'dynamicSuffixVersion', 'normalizedRequestVersion', 'boundaryMarker',
    'stablePrefix', 'dynamicSuffix', 'normalizedRequest', 'components', 'promptComponents', 'invalidationReasons',
    'primaryInvalidationReason', 'providerPrompt', 'lsContext', 'memoryEmbedding',
  ], 'cache');
  if (record.version !== 1 || record.usageSchemaVersion !== CACHE_USAGE_SCHEMA_VERSION) {
    throw new DurableKernelError('unsupported model cache observation version', 'invalid');
  }
  const provider = boundedProjectionString(record.provider, 'cache.provider', 128);
  const model = boundedProjectionString(record.model, 'cache.model', 256);
  const requestKind = boundedProjectionString(record.requestKind, 'cache.requestKind', 128);
  const modelRequestId = boundedProjectionString(record.modelRequestId, 'cache.modelRequestId', 256);
  if (expectedRequestId !== undefined && modelRequestId !== expectedRequestId) {
    throw new DurableKernelError('cache observation request id does not match model request', 'invalid');
  }
  const requestIndex = requiredNonNegativeInteger(record.requestIndex, 'cache.requestIndex');
  const stablePrefixVersion = boundedProjectionString(record.stablePrefixVersion, 'cache.stablePrefixVersion', 64);
  const dynamicSuffixVersion = boundedProjectionString(record.dynamicSuffixVersion, 'cache.dynamicSuffixVersion', 64);
  const normalizedRequestVersion = boundedProjectionString(record.normalizedRequestVersion, 'cache.normalizedRequestVersion', 64);
  const boundaryMarker = boundedProjectionString(record.boundaryMarker, 'cache.boundaryMarker', 256);
  const scope = readCacheScope(record.scope);
  const stablePrefix = readCacheFingerprint(record.stablePrefix, 'cache.stablePrefix');
  const dynamicSuffix = readCacheFingerprint(record.dynamicSuffix, 'cache.dynamicSuffix');
  const normalizedRequest = readCacheFingerprint(record.normalizedRequest, 'cache.normalizedRequest');
  const components = readCacheComponents(record.components);
  const invalidationReasons = readCacheReasons(record.invalidationReasons);
  const primaryInvalidationReason = record.primaryInvalidationReason === undefined
    ? undefined
    : readCacheReason(record.primaryInvalidationReason, 'cache.primaryInvalidationReason');
  const providerPrompt = readCacheLedger(record.providerPrompt, 'cache.providerPrompt');
  const lsContext = readCacheLedger(record.lsContext, 'cache.lsContext');
  const memoryEmbedding = readCacheLedger(record.memoryEmbedding, 'cache.memoryEmbedding');
  return Object.freeze({
    version: 1,
    usageSchemaVersion: CACHE_USAGE_SCHEMA_VERSION,
    adapter: boundedProjectionString(record.adapter, 'cache.adapter', 128),
    provider,
    model,
    requestKind,
    requestIndex,
    modelRequestId,
    scope,
    stablePrefixVersion: stablePrefixVersion as typeof STABLE_PREFIX_VERSION,
    dynamicSuffixVersion: dynamicSuffixVersion as typeof DYNAMIC_SUFFIX_VERSION,
    normalizedRequestVersion: normalizedRequestVersion as typeof NORMALIZED_REQUEST_VERSION,
    boundaryMarker,
    stablePrefix,
    dynamicSuffix,
    normalizedRequest,
    components,
    ...(record.promptComponents === undefined ? {} : { promptComponents: readCachePromptComponents(record.promptComponents) }),
    invalidationReasons,
    ...(primaryInvalidationReason === undefined ? {} : { primaryInvalidationReason }),
    providerPrompt,
    lsContext,
    memoryEmbedding,
  });
}

function readCacheScope(value: unknown): CacheObservation['scope'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError('cache scope must be an object', 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, ['version', 'sessionDigest', 'workspaceDigest', 'permissionPolicyId', 'partitionDigest', 'keySource'], 'cache.scope');
  if (record.version !== 1) throw new DurableKernelError('unsupported cache scope version', 'invalid');
  const keySource = record.keySource;
  if (keySource !== 'provided' && keySource !== 'ephemeral' && keySource !== 'unavailable') {
    throw new DurableKernelError('invalid cache scope key source', 'invalid');
  }
  const permissionPolicyId = record.permissionPolicyId;
  if (permissionPolicyId !== 'full' && permissionPolicyId !== 'research'
    && permissionPolicyId !== 'restricted' && permissionPolicyId !== 'unknown') {
    throw new DurableKernelError('invalid cache scope permission', 'invalid');
  }
  return Object.freeze({
    version: 1,
    ...(record.sessionDigest === undefined ? {} : { sessionDigest: boundedDigest(record.sessionDigest, 'cache.sessionDigest') }),
    ...(record.workspaceDigest === undefined ? {} : { workspaceDigest: boundedDigest(record.workspaceDigest, 'cache.workspaceDigest') }),
    permissionPolicyId,
    ...(record.partitionDigest === undefined ? {} : { partitionDigest: boundedDigest(record.partitionDigest, 'cache.partitionDigest') }),
    keySource,
  });
}

function readCacheFingerprint(value: unknown, label: string): CacheObservation['stablePrefix'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError(`${label} must be an object`, 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, ['version', 'algorithm', 'keySource', 'fingerprint', 'byteLength', 'itemCount'], label);
  if (record.version !== 1 || record.algorithm !== 'hmac-sha256') {
    throw new DurableKernelError(`${label} has invalid algorithm/version`, 'invalid');
  }
  const keySource = record.keySource;
  if (keySource !== 'provided' && keySource !== 'ephemeral' && keySource !== 'unavailable') {
    throw new DurableKernelError(`${label} has invalid key source`, 'invalid');
  }
  const byteLength = requiredNonNegativeInteger(record.byteLength, `${label}.byteLength`);
  const itemCount = requiredNonNegativeInteger(record.itemCount, `${label}.itemCount`);
  const fingerprint = record.fingerprint === undefined ? undefined : boundedDigest(record.fingerprint, `${label}.fingerprint`);
  return Object.freeze({ version: 1, algorithm: 'hmac-sha256', keySource, ...(fingerprint ? { fingerprint } : {}), byteLength, itemCount });
}

function readCacheComponents(value: unknown): CacheObservation['components'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError('cache components must be an object', 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, ['provider', 'model', 'requestKind', 'systemPrompt', 'toolSchema', 'scope'], 'cache.components');
  return Object.freeze({
    provider: boundedProjectionString(record.provider, 'cache.components.provider', 128),
    model: boundedProjectionString(record.model, 'cache.components.model', 128),
    requestKind: boundedProjectionString(record.requestKind, 'cache.components.requestKind', 128),
    systemPrompt: boundedProjectionString(record.systemPrompt, 'cache.components.systemPrompt', 128),
    toolSchema: boundedProjectionString(record.toolSchema, 'cache.components.toolSchema', 128),
    scope: boundedProjectionString(record.scope, 'cache.components.scope', 128),
  });
}

function readCachePromptComponents(value: unknown): CacheObservation['promptComponents'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError('cache prompt components must be an object', 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, ['promptVersion', 'systemPolicy', 'soul', 'userProfile', 'memoryRevision', 'summary', 'locale'], 'cache.promptComponents');
  const result: Record<string, string> = {};
  for (const name of ['promptVersion', 'systemPolicy', 'soul', 'userProfile', 'memoryRevision', 'summary', 'locale']) {
    if (record[name] !== undefined) {
      result[name] = boundedDigest(record[name], `cache.promptComponents.${name}`);
    }
  }
  return Object.keys(result).length > 0 ? Object.freeze(result as CacheObservation['promptComponents']) : undefined;
}

function readCacheReasons(value: unknown): CacheObservation['invalidationReasons'] {
  if (!Array.isArray(value)) throw new DurableKernelError('cache invalidation reasons must be an array', 'invalid');
  return Object.freeze(value.map((item, index) => readCacheReason(item, `cache.invalidationReasons[${index}]`)));
}

function readCacheReason(value: unknown, label: string): CacheObservation['invalidationReasons'][number] {
  const allowed = ['model_changed', 'provider_changed', 'adapter_changed', 'prompt_version_changed', 'system_policy_changed',
    'soul_changed', 'user_profile_changed', 'tool_schema_changed', 'memory_revision_changed', 'workspace_changed',
    'permission_changed', 'session_reset', 'summary_compacted', 'locale_changed', 'request_kind_changed', 'manual_clear',
    'replayed', 'unknown'] as const;
  if (!allowed.includes(value as typeof allowed[number])) {
    throw new DurableKernelError(`${label} is invalid`, 'invalid');
  }
  return value as typeof allowed[number];
}

function readCacheLedger(value: unknown, label: string): CacheObservation['providerPrompt'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableKernelError(`${label} must be an object`, 'invalid');
  }
  const record = value as Record<string, unknown>;
  assertAllowedKeys(record, ['kind', 'status', 'reason', 'requestCount', 'tokenCount', 'cachedTokenCount', 'hitRatio'], label);
  const kind = record.kind;
  if (kind !== 'provider_prompt' && kind !== 'ls_context' && kind !== 'memory_embedding') {
    throw new DurableKernelError(`${label}.kind is invalid`, 'invalid');
  }
  const status = record.status;
  if (status !== 'hit' && status !== 'miss' && status !== 'partial' && status !== 'unavailable' && status !== 'unknown') {
    throw new DurableKernelError(`${label}.status is invalid`, 'invalid');
  }
  if (record.requestCount !== 1) throw new DurableKernelError(`${label}.requestCount must be 1`, 'invalid');
  const tokenCount = optionalNonNegativeInteger(record.tokenCount, `${label}.tokenCount`);
  const cachedTokenCount = optionalNonNegativeInteger(record.cachedTokenCount, `${label}.cachedTokenCount`);
  if (tokenCount !== undefined && cachedTokenCount !== undefined && cachedTokenCount > tokenCount) {
    throw new DurableKernelError(`${label}.cachedTokenCount exceeds tokenCount`, 'invalid');
  }
  const hitRatio = record.hitRatio;
  if (hitRatio !== undefined && (typeof hitRatio !== 'number' || !Number.isFinite(hitRatio) || hitRatio < 0 || hitRatio > 1)) {
    throw new DurableKernelError(`${label}.hitRatio is invalid`, 'invalid');
  }
  return Object.freeze({
    kind,
    status,
    ...(record.reason === undefined ? {} : { reason: boundedProjectionString(record.reason, `${label}.reason`, 128) }),
    requestCount: 1,
    ...(tokenCount === undefined ? {} : { tokenCount }),
    ...(cachedTokenCount === undefined ? {} : { cachedTokenCount }),
    ...(hitRatio === undefined ? {} : { hitRatio }),
  });
}

function boundedProjectionString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new DurableKernelError(`${label} must be a bounded string`, 'invalid');
  }
  return value.trim();
}

function assertAllowedKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new DurableKernelError(`${label}.${unexpected} is not allowed in a redacted projection`, 'invalid');
  }
}

function boundedDigest(value: unknown, label: string): string {
  const digest = boundedProjectionString(value, label, 128);
  if (digest !== 'unavailable' && !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new DurableKernelError(`${label} must be a digest`, 'invalid');
  }
  return digest;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DurableKernelError(`${label} must be a non-negative integer`, 'invalid');
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredNonNegativeInteger(value, label);
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DurableKernelError(`${label} must be non-empty`, 'invalid');
  }
  return value.trim();
}

export function requiredRoute(value: unknown): NonNullable<DurableRunProjection['route']> {
  if (value !== 'respond' && value !== 'execute' && value !== 'clarify') {
    throw new DurableKernelError('invalid route', 'invalid');
  }
  return value;
}

export function requiredEffectStatus(value: unknown): DurableEffectProjection['status'] {
  if (value !== 'succeeded' && value !== 'failed' && value !== 'cancelled' && value !== 'unknown') {
    throw new DurableKernelError('invalid effect settlement status', 'invalid');
  }
  return value;
}

export function requiredModelRequestStatus(value: unknown): DurableModelRequestStatus {
  if (!isDurableModelRequestStatus(value)) {
    throw new DurableKernelError('invalid model request settlement status', 'invalid');
  }
  return value;
}

export function requiredRuntimeStatus(value: unknown): DurableRunProjection['status'] {
  if (value !== 'waiting_user' && value !== 'failed' && value !== 'interrupted') {
    throw new DurableKernelError('invalid runtime status settlement', 'invalid');
  }
  return value;
}

export function sourceForInboxCommand(command: DurableInboxCommand): DurableHarnessEvent['source'] {
  return sourceForInboxType(command.type);
}

export function sourceForInboxType(type: DurableHarnessEvent['type']): DurableHarnessEvent['source'] {
  if (type === 'user_input_appended') return 'app';
  if (type === 'model_response_received' || type === 'final_reply_proposed') return 'model';
  if (type === 'effect_settled') return 'tool';
  return 'runtime';
}

export type MutableDurableRunProjection = {
  -readonly [Key in keyof DurableRunProjection]: DurableRunProjection[Key] extends readonly (infer Item)[] ? Item[] : DurableRunProjection[Key];
};

export function freezeDurableRunProjection(projection: MutableDurableRunProjection): DurableRunProjection {
  return {
    ...projection,
    effects: projection.effects.map((effect) => Object.freeze({ ...effect })),
    pendingEffectIds: [...projection.pendingEffectIds],
    unknownEffectIds: [...projection.unknownEffectIds],
    finalReply: Object.freeze({ ...projection.finalReply }),
    modelRequests: projection.modelRequests.map((request) => Object.freeze({
      ...request,
      ...(request.cacheObservation ? { cacheObservation: cloneCacheObservation(request.cacheObservation) } : {}),
      ...(request.providerUsage ? { providerUsage: Object.freeze({ ...request.providerUsage }) } : {}),
    })),
    pendingModelRequestIds: [...projection.pendingModelRequestIds],
    stageTransitions: projection.stageTransitions.map((transition) => Object.freeze({ ...transition })),
  };
}

function cloneCacheObservation(observation: CacheObservation): CacheObservation {
  return Object.freeze(JSON.parse(JSON.stringify(observation)) as CacheObservation);
}

export function isDurableModelRequestStatus(value: unknown): value is DurableModelRequestStatus {
  return value === 'received' || value === 'missing' || value === 'aborted' || value === 'timeout'
    || value === 'rate_limit' || value === 'connection_reset' || value === 'failed';
}
