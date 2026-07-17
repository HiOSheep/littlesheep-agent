import { describe, expect, it } from 'vitest';
import {
  applyAtomicActivationObservation,
  atomicActivationSignalsFromEvidence,
  computeAtomicActivation,
  createAtomicActivationEvidence,
  decayAtomicActivationScore,
  projectAtomicActivationLevel,
} from './activation.js';

const START = '2026-01-01T00:00:00.000Z';

describe('atomic activation', () => {
  it('promotes repeated useful evidence and demotes it through lazy time decay', () => {
    let evidence = createAtomicActivationEvidence();
    for (let index = 0; index < 16; index += 1) {
      evidence = applyAtomicActivationObservation(evidence, {
        id: `useful-${index}`,
        outcome: 'useful',
        verified: index % 2 === 0,
        observedAt: new Date(Date.parse(START) + index * 60_000).toISOString(),
      });
    }
    const hot = computeAtomicActivation(
      atomicActivationSignalsFromEvidence(evidence, START),
      '2026-01-01T01:00:00.000Z',
    );
    const cold = computeAtomicActivation(
      atomicActivationSignalsFromEvidence(evidence, START),
      '2027-01-01T01:00:00.000Z',
    );

    expect(hot.score).toBeGreaterThan(0.66);
    expect(projectAtomicActivationLevel(hot.score)).toBe('high');
    expect(cold.score).toBeLessThan(0.33);
    expect(projectAtomicActivationLevel(cold.score)).toBe('low');
  });

  it('does not heat an atom merely because no verified use evidence exists', () => {
    const snapshot = computeAtomicActivation({
      createdAt: START,
      useful: 0,
      notUseful: 0,
      conflicts: 0,
      stale: 0,
      verifiedUseful: 0,
      verifiedNotUseful: 0,
      verifiedConflicts: 0,
      verifiedStale: 0,
    }, START);

    expect(snapshot.score).toBeCloseTo(0.25, 8);
    expect(projectAtomicActivationLevel(snapshot.score)).toBe('low');
  });

  it('deduplicates observations and bounds counters and event ids', () => {
    let evidence = createAtomicActivationEvidence();
    for (let index = 0; index < 160; index += 1) {
      evidence = applyAtomicActivationObservation(evidence, {
        id: `event-${index}`,
        outcome: 'useful',
        verified: true,
        observedAt: new Date(Date.parse(START) + index * 1_000).toISOString(),
      });
    }
    const before = structuredClone(evidence);
    evidence = applyAtomicActivationObservation(evidence, {
      id: 'event-159',
      outcome: 'useful',
      verified: true,
      observedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(evidence).toEqual(before);
    expect(evidence.recentEventIds).toHaveLength(64);
    expect(evidence.useful).toBeLessThanOrEqual(64);
    expect(evidence.verifiedUseful).toBeLessThanOrEqual(64);
  });

  it('uses hysteresis so the three-level UI projection does not chatter', () => {
    expect(projectAtomicActivationLevel(0.64, 'high')).toBe('high');
    expect(projectAtomicActivationLevel(0.64, 'medium')).toBe('medium');
    expect(projectAtomicActivationLevel(0.35, 'low')).toBe('low');
    expect(projectAtomicActivationLevel(0.39, 'low')).toBe('medium');
  });

  it('decays persisted activation scores without changing protected atoms', () => {
    expect(decayAtomicActivationScore(0.9, START, '2026-07-01T00:00:00.000Z')).toBeLessThan(0.2);
    expect(decayAtomicActivationScore(1, START, '2030-01-01T00:00:00.000Z')).toBe(1);
  });
});
