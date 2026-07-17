import { describe, expect, it } from 'vitest';
import { memoryUseFeedbackFromRun } from './memory-feedback.js';

describe('memoryUseFeedbackFromRun', () => {
  it('separates explicit routing usefulness from independently verified usefulness', () => {
    const common = {
      runId: 'run-1',
      status: 'ok' as const,
      references: [{ atomId: 'atom-1', decision: 'adopted' as const, reason: 'selected' }],
      activeAtomIds: ['atom-1'],
      releasedAtomIds: [],
      usedAtomIds: ['atom-1'],
      successfulToolCallIds: [],
      recordedAt: '2026-07-16T06:00:00.000Z',
    };

    expect(memoryUseFeedbackFromRun({
      ...common,
      verification: {
        attempt: 1,
        verdict: 'pass',
        source: 'model',
        verifiedAt: common.recordedAt,
      },
    })[0]).toMatchObject({ atomId: 'atom-1', outcome: 'useful', verified: false });

    expect(memoryUseFeedbackFromRun({
      ...common,
      verification: {
        attempt: 1,
        verdict: 'pass',
        source: 'structural',
        verifiedAt: common.recordedAt,
      },
    })[0]).toMatchObject({ atomId: 'atom-1', outcome: 'useful', verified: true });
  });

  it('does not reward an atom merely because it remained visible in a successful run', () => {
    const feedback = memoryUseFeedbackFromRun({
      runId: 'run-visible-only',
      status: 'ok',
      references: [{ atomId: 'atom-visible', decision: 'adopted', reason: 'initial injection' }],
      activeAtomIds: ['atom-visible'],
      releasedAtomIds: [],
      usedAtomIds: [],
      verification: {
        attempt: 1,
        verdict: 'pass',
        source: 'structural',
        verifiedAt: '2026-07-16T06:00:00.000Z',
      },
      successfulToolCallIds: [],
      recordedAt: '2026-07-16T06:00:00.000Z',
    });

    expect(feedback).toEqual([]);
  });

  it('records explicit release as unverified routing feedback without calling it false', () => {
    const [feedback] = memoryUseFeedbackFromRun({
      runId: 'run-2',
      status: 'ok',
      references: [{ atomId: 'atom-2', decision: 'excluded', reason: 'released' }],
      activeAtomIds: [],
      releasedAtomIds: ['atom-2'],
      usedAtomIds: [],
      successfulToolCallIds: [],
      recordedAt: '2026-07-16T06:00:00.000Z',
    });

    expect(feedback).toMatchObject({ atomId: 'atom-2', outcome: 'not-useful', verified: false });
    expect(feedback?.reason).toContain('not evidence that the atom is false');
  });

  it('does not create conflict feedback for an atom that never entered the active Context', () => {
    const feedback = memoryUseFeedbackFromRun({
      runId: 'run-unseen-conflict',
      status: 'ok',
      references: [{ atomId: 'atom-conflict', decision: 'conflicted', reason: 'outside bounded Context' }],
      activeAtomIds: [],
      releasedAtomIds: [],
      usedAtomIds: [],
      successfulToolCallIds: [],
      recordedAt: '2026-07-16T06:00:00.000Z',
    });

    expect(feedback).toEqual([]);
  });

  it('records conflict routing feedback only when VERIFY explicitly used the active atom', () => {
    const [feedback] = memoryUseFeedbackFromRun({
      runId: 'run-used-conflict',
      status: 'ok',
      references: [{ atomId: 'atom-conflict', decision: 'conflicted', reason: 'explicit unresolved conflict' }],
      activeAtomIds: ['atom-conflict'],
      releasedAtomIds: [],
      usedAtomIds: ['atom-conflict'],
      successfulToolCallIds: [],
      recordedAt: '2026-07-16T06:00:00.000Z',
    });

    expect(feedback).toMatchObject({ atomId: 'atom-conflict', outcome: 'conflict', verified: false });
  });
});
