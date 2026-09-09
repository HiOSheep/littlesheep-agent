// Redacted verification payload codec for durable projection.
import type { DurableVerificationProjection } from '@littlesheep/types';
import { DurableKernelError } from './durable-kernel-error.js';
import { requiredString } from './durable-projection-codec.js';

export function readVerificationRecordedPayload(
  payload: Record<string, unknown>,
): DurableVerificationProjection {
  return {
    attempt: requiredPositiveInteger(payload.attempt, 'verification_recorded.attempt'),
    verdict: requiredVerdict(payload.verdict),
    source: requiredSource(payload.source),
    reasonHash: requiredDigest(payload.reasonHash, 'verification_recorded.reasonHash'),
    reasonLength: requiredNonNegativeInteger(
      payload.reasonLength,
      'verification_recorded.reasonLength',
    ),
    failedStepIds: optionalStringArray(
      payload.failedStepIds,
      'verification_recorded.failedStepIds',
      64,
    ),
  };
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DurableKernelError(`${label} must be a positive integer`, 'invalid');
  }
  return value as number;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DurableKernelError(`${label} must be a non-negative integer`, 'invalid');
  }
  return value as number;
}

function requiredVerdict(value: unknown): DurableVerificationProjection['verdict'] {
  if (value !== 'pass' && value !== 'needs_replan' && value !== 'fail') {
    throw new DurableKernelError('verification verdict is invalid', 'invalid');
  }
  return value;
}

function requiredSource(value: unknown): DurableVerificationProjection['source'] {
  if (value !== 'model' && value !== 'structural' && value !== 'degraded') {
    throw new DurableKernelError('verification source is invalid', 'invalid');
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new DurableKernelError(`${label} must be a digest`, 'invalid');
  }
  return digest;
}

function optionalStringArray(value: unknown, label: string, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DurableKernelError(`${label} must be a bounded string array`, 'invalid');
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}
