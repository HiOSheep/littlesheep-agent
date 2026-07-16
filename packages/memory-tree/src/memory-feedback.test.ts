import { describe, expect, it } from 'vitest';
import { memoryUseFeedbackFromRun } from './memory-feedback.js';

describe('memoryUseFeedbackFromRun', () => {
  it('requires verified execution evidence before recording positive usefulness', () => {
    const common = {
      runId: 'run-1',
      status: 'ok' as const,
      references: [{ atomId: 'atom-1', decision: 'adopted' as const, reason: 'selected' }],
      activeAtomIds: ['atom-1'],
      releasedAtomIds: [],
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
    })).toEqual([]);

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

  it('records explicit release as unverified routing feedback without calling it false', () => {
    const [feedback] = memoryUseFeedbackFromRun({
      runId: 'run-2',
      status: 'ok',
      references: [{ atomId: 'atom-2', decision: 'excluded', reason: 'released' }],
      activeAtomIds: [],
      releasedAtomIds: ['atom-2'],
      successfulToolCallIds: [],
      recordedAt: '2026-07-16T06:00:00.000Z',
    });

    expect(feedback).toMatchObject({ atomId: 'atom-2', outcome: 'not-useful', verified: false });
    expect(feedback?.reason).toContain('not evidence that the atom is false');
  });
});
