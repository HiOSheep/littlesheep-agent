import { describe, expect, it } from 'vitest';
import { InjectionTier } from '../types.js';
import { scoreMemoryCandidate } from './priority.js';
import { makeStoredAtom } from './test-fixtures.js';
import { parseMemoryAtom, validateMemoryUseFeedback } from './validation.js';

describe('Memory v3 contracts and priority', () => {
  it('preserves statement and authority boundaries without promoting advice to fact', () => {
    const atom = parseMemoryAtom(makeStoredAtom({
      statementKind: 'suggestion',
      epistemicStatus: 'unverified',
      resolutionStatus: 'adopted',
      assertedBy: { kind: 'user', id: 'user' },
      authorityScope: { kind: 'user-self', scope: 'project', scopeKey: 'project-a', topics: ['preference'] },
    }));

    expect(atom.statementKind).toBe('suggestion');
    expect(atom.epistemicStatus).toBe('unverified');
    expect(atom.resolutionStatus).toBe('adopted');
  });

  it('requires verification evidence before positive feedback can strengthen memory', () => {
    expect(() => validateMemoryUseFeedback({
      id: 'feedback-1', atomId: 'atom-root', runId: 'run-1', outcome: 'useful',
      verified: false, evidenceRefs: [], reason: 'Repeated access only.', createdAt: '2026-07-15T04:00:00.000Z',
    })).toThrow(/verification evidence/i);

    expect(() => validateMemoryUseFeedback({
      id: 'feedback-2', atomId: 'atom-root', runId: 'run-1', outcome: 'useful',
      verified: true, evidenceRefs: ['verify:step-1'], reason: 'Verified success.', createdAt: '2026-07-15T04:00:00.000Z',
    })).not.toThrow();
  });

  it('decays optional usefulness without changing confidence or removing protected T0 memory', () => {
    const oldOptional = makeStoredAtom({
      updatedAt: '2025-01-01T00:00:00.000Z',
      lastUsefulAt: '2025-01-01T00:00:00.000Z',
      confidence: 0.83,
    });
    const optional = scoreMemoryCandidate({
      atom: oldOptional,
      now: '2026-07-15T04:00:00.000Z',
      scopeMatch: 1,
      taskRelevance: 0.8,
      authorityMatch: 0.8,
      verifiedUsefulness: 1,
      decayHalfLifeDays: 30,
      requiredByCurrentUser: false,
      safetyCritical: false,
    });
    const protectedAtom = makeStoredAtom({
      tier: InjectionTier.T0_CORE,
      updatedAt: '2025-01-01T00:00:00.000Z',
      lastUsefulAt: '2025-01-01T00:00:00.000Z',
    });
    const protectedScore = scoreMemoryCandidate({
      atom: protectedAtom,
      now: '2026-07-15T04:00:00.000Z',
      scopeMatch: 1,
      taskRelevance: 0.8,
      authorityMatch: 0.8,
      verifiedUsefulness: 1,
      decayHalfLifeDays: 30,
      requiredByCurrentUser: false,
      safetyCritical: false,
    });

    expect(optional.usefulnessDecay).toBeLessThan(0.01);
    expect(oldOptional.confidence).toBe(0.83);
    expect(protectedScore.protected).toBe(true);
    expect(protectedScore.usefulnessDecay).toBe(1);
    expect(protectedScore.eligible).toBe(true);
  });

  it('does not prioritize expired, superseded, or inactive optional memory', () => {
    for (const atom of [
      makeStoredAtom({ expiresAt: '2026-07-01T00:00:00.000Z' }),
      makeStoredAtom({ epistemicStatus: 'superseded' }),
      makeStoredAtom({ status: 'archived' }),
    ]) {
      const result = scoreMemoryCandidate({
        atom,
        now: '2026-07-15T04:00:00.000Z',
        scopeMatch: 1,
        taskRelevance: 1,
        authorityMatch: 1,
        verifiedUsefulness: 1,
        decayHalfLifeDays: 30,
        requiredByCurrentUser: false,
        safetyCritical: false,
      });
      expect(result.eligible).toBe(false);
      expect(result.score).toBe(0);
    }
  });
});
