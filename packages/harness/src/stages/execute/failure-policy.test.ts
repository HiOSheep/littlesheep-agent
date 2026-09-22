// Failure classification: a declared reason wins over text matching.
import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@littlesheep/types';
import { classifyStepFailure } from './failure-policy.js';

function failure(error: string, errorKind?: string): ToolResult {
  return {
    callId: 'call-1',
    ok: false,
    error,
    ...(errorKind ? { meta: { errorKind } } : {}),
  };
}

describe('classifyStepFailure', () => {
  it('treats a refused stale observation as a tool error, not a permission problem', () => {
    const results = [
      failure('notes.md changed after it was read; the write was refused', 'observation_stale'),
    ];

    // The wording contains "refused"; without the declared kind the permission
    // regex would claim it, and the model would be told to ask for access.
    expect(classifyStepFailure(undefined, results)).toBe('tool_error');
  });

  it('treats a missing observation and a present target the same way', () => {
    expect(classifyStepFailure(undefined, [failure('read it first', 'observation_missing')]))
      .toBe('tool_error');
    expect(classifyStepFailure(undefined, [failure('already exists', 'target_exists')]))
      .toBe('tool_error');
  });

  it('still classifies ordinary failures from their wording', () => {
    expect(classifyStepFailure(undefined, [failure('Approval denied by the user')]))
      .toBe('permission_denied');
    expect(classifyStepFailure(undefined, [failure('ENOENT: no such file')]))
      .toBe('not_found');
    expect(classifyStepFailure(undefined, [failure('command aborted')]))
      .toBe('aborted');
  });

  it('ignores a declared kind that is not an observation kind', () => {
    expect(classifyStepFailure(undefined, [failure('Approval denied', 'some_other_kind')]))
      .toBe('permission_denied');
  });
});
