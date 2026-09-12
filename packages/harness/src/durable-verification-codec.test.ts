// The durable log must fail closed on a malformed verification payload: a
// partially-valid record would silently corrupt the CACHE-09 quality report
// and the VERIFY verdict used by recovery.
import { describe, expect, it } from 'vitest';
import { readVerificationRecordedPayload } from './durable-verification-codec.js';
import { DurableKernelError } from './durable-kernel-error.js';

const digest = 'a'.repeat(64);

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempt: 1,
    verdict: 'pass',
    source: 'structural',
    reasonHash: digest,
    reasonLength: 7,
    failedStepIds: ['step-1'],
    ...overrides,
  };
}

describe('durable verification codec', () => {
  it('reads a bounded redacted verification record', () => {
    expect(readVerificationRecordedPayload(payload())).toEqual({
      attempt: 1,
      verdict: 'pass',
      source: 'structural',
      reasonHash: digest,
      reasonLength: 7,
      failedStepIds: ['step-1'],
    });
  });

  it('defaults an omitted failedStepIds list to empty', () => {
    expect(readVerificationRecordedPayload(payload({ failedStepIds: undefined })).failedStepIds)
      .toEqual([]);
  });

  it.each([
    ['attempt', 0],
    ['attempt', -1],
    ['attempt', 1.5],
    ['attempt', '1'],
    ['reasonLength', -1],
    ['reasonLength', 2.5],
    ['verdict', 'maybe'],
    ['source', 'runtime'],
    ['reasonHash', 'A'.repeat(64)],
    ['reasonHash', 'abc'],
  ])('rejects an invalid %s', (field, value) => {
    expect(() => readVerificationRecordedPayload(payload({ [field]: value })))
      .toThrow(DurableKernelError);
  });

  it('rejects an unbounded or non-string failedStepIds list', () => {
    expect(() => readVerificationRecordedPayload(payload({ failedStepIds: 'step-1' })))
      .toThrow(/failedStepIds/);
    expect(() => readVerificationRecordedPayload(payload({ failedStepIds: ['ok', 7] })))
      .toThrow(/failedStepIds\[1\]/);
    expect(() => readVerificationRecordedPayload(payload({
      failedStepIds: Array.from({ length: 65 }, (_value, index) => `step-${index}`),
    }))).toThrow(/failedStepIds/);
  });
});
