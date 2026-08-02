import { describe, expect, it } from 'vitest';
import { textMessage } from '@littlesheep/types';
import { buildMemoryRunFeedbackInput } from './memory-feedback-evidence.js';

describe('buildMemoryRunFeedbackInput', () => {
  it('keeps VERIFY and answer-level Atom evidence in separate channels', () => {
    const ctx = {
      runId: 'run-1',
      produced: [textMessage('assistant', '')],
      memoryKnownState: {
        references: [{ atomId: 'atom-answer', decision: 'adopted', reason: 'selected' }],
      },
      memoryContextWorkingSet: {
        activeAtomIds: ['atom-answer'],
        releasedAtomIds: [],
      },
      memoryContinuityAssessment: {
        status: 'supported',
        matchedAtomIds: ['atom-answer'],
      },
    } as never;
    const feedback = buildMemoryRunFeedbackInput({
      ctx,
      status: 'ok',
      verification: {
        attempt: 1,
        verdict: 'pass',
        reason: 'verified',
        source: 'structural',
        verifiedAt: '2026-08-02T12:00:00.000Z',
        usedMemoryAtomIds: ['atom-verify'],
      },
      successfulToolCallIds: ['call-1'],
      recordedAt: '2026-08-02T12:00:00.000Z',
    });

    expect(feedback.usedAtomIds).toEqual(['atom-verify']);
    expect(feedback.answerUsedAtomIds).toEqual(['atom-answer']);
  });

  it('does not emit answer evidence for an uncertain assessment', () => {
    const ctx = {
      runId: 'run-2',
      produced: [],
      memoryContinuityAssessment: {
        status: 'uncertain',
        matchedAtomIds: ['atom-uncertain'],
      },
    } as never;
    const feedback = buildMemoryRunFeedbackInput({
      ctx,
      status: 'ok',
      successfulToolCallIds: [],
      recordedAt: '2026-08-02T12:00:00.000Z',
    });

    expect(feedback.answerUsedAtomIds).toEqual([]);
  });
});
