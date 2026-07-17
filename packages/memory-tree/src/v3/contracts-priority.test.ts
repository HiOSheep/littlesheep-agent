import { describe, expect, it } from 'vitest';
import { InjectionTier } from '../types.js';
import { memoryRoutingRelevance, scoreMemoryCandidate } from './priority.js';
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

  it('requires traceable use evidence while keeping unverified routing separate from factual strength', () => {
    expect(() => validateMemoryUseFeedback({
      id: 'feedback-1', atomId: 'atom-root', runId: 'run-1', outcome: 'useful',
      verified: false, evidenceRefs: [], reason: 'Repeated access only.', createdAt: '2026-07-15T04:00:00.000Z',
    })).toThrow(/traceable use evidence/i);

    expect(() => validateMemoryUseFeedback({
      id: 'feedback-routing', atomId: 'atom-root', runId: 'run-1', outcome: 'useful',
      verified: false, evidenceRefs: ['run:run-1:verification:1:pass'],
      reason: 'Explicitly used by the verified response, without independent factual evidence.',
      createdAt: '2026-07-15T04:00:00.000Z',
    })).not.toThrow();

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
      routingRelevance: 0.5,
      relationshipRelevance: 0.5,
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
      routingRelevance: 0.1,
      relationshipRelevance: 0.1,
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
        routingRelevance: 0.5,
        relationshipRelevance: 0.5,
        decayHalfLifeDays: 30,
        requiredByCurrentUser: false,
        safetyCritical: false,
      });
      expect(result.eligible).toBe(false);
      expect(result.score).toBe(0);
    }
  });

  it('lowers optional routing priority after releases without changing confidence and allows recovery', () => {
    const neutral = makeStoredAtom({ confidence: 0.83, routingFeedback: undefined });
    const released = makeStoredAtom({
      confidence: 0.83,
      routingFeedback: {
        useful: 0,
        notUseful: 4,
        conflicts: 0,
        stale: 0,
        lastOutcome: 'not-useful',
        lastRoutedAt: '2026-07-15T04:00:00.000Z',
      },
    });
    const recovered = makeStoredAtom({
      confidence: 0.83,
      routingFeedback: {
        useful: 6,
        notUseful: 4,
        conflicts: 0,
        stale: 0,
        lastOutcome: 'useful',
        lastRoutedAt: '2026-07-15T04:00:00.000Z',
      },
    });

    const neutralRouting = memoryRoutingRelevance(neutral, '2026-07-15T04:00:00.000Z');
    const releasedRouting = memoryRoutingRelevance(released, '2026-07-15T04:00:00.000Z');
    const recoveredRouting = memoryRoutingRelevance(recovered, '2026-07-15T04:00:00.000Z');

    expect(releasedRouting).toBeLessThan(neutralRouting);
    expect(recoveredRouting).toBeGreaterThan(releasedRouting);
    expect(released.confidence).toBe(0.83);
  });

  it('decays derived routing evidence toward neutral instead of reviving old negative counts', () => {
    const atom = makeStoredAtom({
      routingFeedback: {
        useful: 0,
        notUseful: 32,
        conflicts: 0,
        stale: 0,
        effectiveRelevance: 1 / 34,
        effectiveEvidenceWeight: 32,
        lastOutcome: 'not-useful',
        lastRoutedAt: '2025-07-15T04:00:00.000Z',
      },
    });

    const immediate = memoryRoutingRelevance(atom, '2025-07-15T04:00:00.000Z');
    const decayed = memoryRoutingRelevance(atom, '2026-07-15T04:00:00.000Z');

    expect(immediate).toBeLessThan(0.05);
    expect(decayed).toBeGreaterThan(immediate);
    expect(decayed).toBeLessThan(0.5);
  });

  it('keeps unrelated graph strength neutral until the current task matches the atom', () => {
    const atom = makeStoredAtom();
    const unrelated = scoreMemoryCandidate({
      atom,
      now: '2026-07-15T04:00:00.000Z',
      scopeMatch: 1,
      taskRelevance: 0,
      authorityMatch: 1,
      verifiedUsefulness: 1,
      routingRelevance: 0.5,
      relationshipRelevance: 1,
      decayHalfLifeDays: 30,
      requiredByCurrentUser: false,
      safetyCritical: false,
    });
    const related = scoreMemoryCandidate({
      atom,
      now: '2026-07-15T04:00:00.000Z',
      scopeMatch: 1,
      taskRelevance: 1,
      authorityMatch: 1,
      verifiedUsefulness: 1,
      routingRelevance: 0.5,
      relationshipRelevance: 1,
      decayHalfLifeDays: 30,
      requiredByCurrentUser: false,
      safetyCritical: false,
    });

    expect(unrelated.taskRelevance).toBe(0);
    expect(unrelated.relationshipRelevance).toBe(0.5);
    expect(unrelated.relationshipMultiplier).toBe(1);
    expect(related.relationshipRelevance).toBe(1);
    expect(related.relationshipMultiplier).toBeGreaterThan(unrelated.relationshipMultiplier);
  });

  it('keeps task relevance ahead of activation when a frequently useful Atom is unrelated', () => {
    const hotUnrelated = makeStoredAtom({
      id: 'hot-unrelated',
      routingFeedback: {
        useful: 64,
        notUseful: 0,
        conflicts: 0,
        stale: 0,
        effectiveRelevance: 0.98,
        effectiveEvidenceWeight: 64,
        lastOutcome: 'useful',
        lastRoutedAt: '2026-07-17T00:00:00.000Z',
      },
      verifiedUsefulness: { useful: 64, notUseful: 0, conflicts: 0, stale: 0 },
      lastUsefulAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    const coldRelevant = makeStoredAtom({
      id: 'cold-relevant',
      routingFeedback: undefined,
      verifiedUsefulness: { useful: 0, notUseful: 0, conflicts: 0, stale: 0 },
      lastUsefulAt: undefined,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const common = {
      now: '2026-07-17T01:00:00.000Z',
      scopeMatch: 1,
      authorityMatch: 1,
      verifiedUsefulness: 0.5,
      relationshipRelevance: 0.5,
      decayHalfLifeDays: 45,
      requiredByCurrentUser: false,
      safetyCritical: false,
    } as const;
    const unrelated = scoreMemoryCandidate({
      ...common,
      atom: hotUnrelated,
      taskRelevance: 0,
      routingRelevance: 1,
    });
    const relevant = scoreMemoryCandidate({
      ...common,
      atom: coldRelevant,
      taskRelevance: 1,
      routingRelevance: 0.5,
    });

    expect(unrelated.activation.score).toBeGreaterThan(relevant.activation.score);
    expect(relevant.score).toBeGreaterThan(unrelated.score);
  });
});
