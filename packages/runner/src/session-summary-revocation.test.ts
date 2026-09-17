import { describe, expect, it } from 'vitest';
import type { RunContext, StageResult } from '@littlesheep/types';
import { memoryRevokedDuringRun } from './session-summary-revocation.js';

function context(decisions: unknown[]): RunContext {
  return { memoryIntentDecisions: decisions } as unknown as RunContext;
}

function result(meta?: unknown): StageResult {
  return { stage: 'finalize', next: 'exit', ok: true, meta } as unknown as StageResult;
}

describe('memoryRevokedDuringRun', () => {
  it('detects a committed invalidate intent', () => {
    expect(memoryRevokedDuringRun(
      context([{ decision: 'committed', proposedIntent: 'invalidate' }]),
      result(),
    )).toBe(true);
    expect(memoryRevokedDuringRun(
      context([{ decision: 'rejected', proposedIntent: 'invalidate' }]),
      result(),
    )).toBe(false);
  });

  it('detects a committed correction result', () => {
    expect(memoryRevokedDuringRun(
      context([]),
      result({ memoryAtomCorrections: [{ status: 'committed' }] }),
    )).toBe(true);
    expect(memoryRevokedDuringRun(
      context([]),
      result({ memoryAtomCorrections: [{ status: 'noop' }] }),
    )).toBe(false);
  });

  it('reports no revocation without evidence', () => {
    expect(memoryRevokedDuringRun(context([]), result())).toBe(false);
  });
});
