// Validates provider token, cache, timing, and local-calibration durable payloads.
import type { DurableProviderUsageProjection } from '@littlesheep/types';
import { DurableKernelError } from './durable-kernel-error.js';

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
  const cacheWriteTokens = optionalNonNegativeInteger(payload.cacheWriteTokens, 'cacheWriteTokens');
  const timing = readProviderTransportTiming(payload);
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
  const localCalibration = readLocalTokenCalibration(payload.localCalibration, promptTokenCount, reconciliation);
  return {
    promptTokens: promptTokenCount,
    completionTokens: completionTokenCount,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...timing,
    cacheStatus,
    reconciliation,
    ...(localCalibration ? { localCalibration } : {}),
  };
}

export function readProviderTransportTiming(
  payload: Record<string, unknown>,
): Pick<DurableProviderUsageProjection,
  'durationMs' | 'requestElapsedMs' | 'transportAttempt' | 'observedAttemptCount'
  | 'ttftMs' | 'contentTtftMs' | 'reasoningTtftMs' | 'toolArgumentsTtftMs'> {
  const optionalTime = (key: string) => optionalFiniteNonNegativeNumber(payload[key], key);
  const durationMs = optionalTime('durationMs');
  const requestElapsedMs = optionalTime('requestElapsedMs');
  const transportAttempt = optionalPositiveInteger(payload.transportAttempt, 'transportAttempt');
  const observedAttemptCount = optionalPositiveInteger(payload.observedAttemptCount, 'observedAttemptCount');
  const ttftMs = optionalTime('ttftMs');
  const contentTtftMs = optionalTime('contentTtftMs');
  const reasoningTtftMs = optionalTime('reasoningTtftMs');
  const toolArgumentsTtftMs = optionalTime('toolArgumentsTtftMs');
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(requestElapsedMs === undefined ? {} : { requestElapsedMs }),
    ...(transportAttempt === undefined ? {} : { transportAttempt }),
    ...(observedAttemptCount === undefined ? {} : { observedAttemptCount }),
    ...(ttftMs === undefined ? {} : { ttftMs }),
    ...(contentTtftMs === undefined ? {} : { contentTtftMs }),
    ...(reasoningTtftMs === undefined ? {} : { reasoningTtftMs }),
    ...(toolArgumentsTtftMs === undefined ? {} : { toolArgumentsTtftMs }),
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
  assertAllowedKeys(record, ['version', 'tokenizerId', 'localPromptTokens', 'differenceTokens', 'relativeDifference', 'status'], 'providerUsage.localCalibration');
  if (record.version !== 1) throw new DurableKernelError('provider usage local calibration version is unsupported', 'invalid');
  const tokenizerId = boundedProjectionString(record.tokenizerId, 'providerUsage.localCalibration.tokenizerId', 128);
  const localPromptTokens = requiredNonNegativeInteger(record.localPromptTokens, 'providerUsage.localCalibration.localPromptTokens');
  const differenceTokens = requiredSafeInteger(record.differenceTokens, 'providerUsage.localCalibration.differenceTokens');
  const relativeDifference = requiredFiniteNonNegativeNumber(record.relativeDifference, 'providerUsage.localCalibration.relativeDifference');
  const status = record.status;
  if (status !== 'exact_match' && status !== 'within_tolerance' && status !== 'drift') {
    throw new DurableKernelError('provider usage local calibration status is invalid', 'invalid');
  }
  if (differenceTokens !== providerPromptTokens - localPromptTokens) {
    throw new DurableKernelError('provider usage local calibration difference does not match prompt tokens', 'invalid');
  }
  const expectedRelativeDifference = providerPromptTokens === 0
    ? (differenceTokens === 0 ? 0 : 1)
    : Math.abs(differenceTokens) / providerPromptTokens;
  if (Math.abs(relativeDifference - expectedRelativeDifference) > 1e-9) {
    throw new DurableKernelError('provider usage local calibration relative difference is inconsistent', 'invalid');
  }
  const expectedReconciliation = status === 'drift' ? 'mismatch' : status;
  if (reconciliation !== expectedReconciliation) {
    throw new DurableKernelError('provider usage reconciliation does not match local calibration', 'invalid');
  }
  return { version: 1, tokenizerId, localPromptTokens, differenceTokens, relativeDifference, status };
}

function assertAllowedKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw new DurableKernelError(`${label}.${unexpected} is not allowed in a redacted projection`, 'invalid');
}

function boundedProjectionString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new DurableKernelError(`${label} must be a bounded string`, 'invalid');
  }
  return value.trim();
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DurableKernelError(`${label} must be a non-negative integer`, 'invalid');
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requiredNonNegativeInteger(value, label);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const result = optionalNonNegativeInteger(value, label);
  if (result === 0) throw new DurableKernelError(`${label} must be a positive integer`, 'invalid');
  return result;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new DurableKernelError(`${label} must be a safe integer`, 'invalid');
  return value as number;
}

function requiredFiniteNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DurableKernelError(`${label} must be a finite non-negative number`, 'invalid');
  }
  return value;
}

function optionalFiniteNonNegativeNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requiredFiniteNonNegativeNumber(value, label);
}
