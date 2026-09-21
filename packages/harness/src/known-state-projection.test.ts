// SP-04: the duplicated state content the model never needs.
//
// Two separate wastes were measured in the Run Memory KnownState entry:
//
//   1. A 659-byte "KnownState rules" block repeated inside every entry. It is
//      policy, identical in every entry and every run, and the entry is re-sent
//      whenever a reference changes — so that block was paid again on every
//      memory tool round.
//   2. Audit and ranking bookkeeping (revision counters, timestamps,
//      first-seen, reactivation counts, usefulness counters, and the derived
//      task/routing/relationship/activation scores). It changed on rounds where
//      nothing the model reads had changed, and any change re-sends the entry.
//
// Measured projection, one synthetic reference: 1,295 -> 1,080 characters.
// Twelve references: 6,634 -> 5,020, i.e. 503 -> 368 characters per reference,
// a 27% reduction, before counting the rounds that no longer re-send at all.
// A revision bump alone now produces byte-identical text.
import { describe, expect, it } from 'vitest';
import type { RuntimeMemoryKnownState } from '@littlesheep/types';
import { knownStateRulesSection, renderKnownStateText } from './memory-known-state.js';

function reference(
  atomId: string,
  overrides: Partial<RuntimeMemoryKnownState['references'][number]> = {},
): RuntimeMemoryKnownState['references'][number] {
  return {
    atomId,
    atomRevision: 3,
    decision: 'adopted',
    reason: 'matched the active project scope for this request',
    stages: ['execute'],
    firstSeenAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    reactivatedCount: 2,
    sourceRefs: [],
    evidenceRefs: ['evidence:1'],
    envelope: {
      atomId,
      atomRevision: 3,
      branch: 'projects',
      scope: 'project',
      scopeKey: 'littlesheep',
      tier: 2,
      disclosureLevel: 'D2',
      statementKind: 'fact',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'project', scope: 'project', topics: ['cache'] },
      assertedBy: { kind: 'user' },
      sourceRefs: ['source:1'],
      evidenceRefs: ['evidence:1'],
      confidence: 0.9,
      importance: 0.8,
      verifiedUsefulness: { useful: 2, notUseful: 0, conflicts: 0, stale: 1, lastOutcome: 'useful' },
      taskRelevance: 0.7,
      routingRelevance: 0.5,
      relationshipRelevance: 0.5,
      updatedAt: '2026-09-21T00:00:00.000Z',
      retrievalPath: 'hierarchy',
      matchReason: 'branch matched the request terms',
      conflict: false,
      expired: false,
      truncated: false,
    },
    ...overrides,
  };
}

function state(revision: number, atoms: string[]): RuntimeMemoryKnownState {
  return {
    version: 1,
    runId: 'run-1',
    revision,
    updatedAt: `2026-09-21T00:0${revision}:00.000Z`,
    references: atoms.map((atomId) => reference(atomId)),
  };
}

describe('KnownState projection', () => {
  it('carries the reading rules once, not inside every entry', () => {
    const withRules = renderKnownStateText(state(1, ['atom-a']));
    const withoutRules = renderKnownStateText(state(1, ['atom-a']), { includeRules: false });

    expect(withRules).toContain('KnownState rules:');
    expect(withoutRules).not.toContain('KnownState rules:');
    // The rules are 659 bytes of policy; repeating them per entry is the waste.
    expect(withRules.length - withoutRules.length).toBeGreaterThan(600);
    // Single-request paths carry them inline; the main loop's interval slot is
    // the only copy there.
    expect(knownStateRulesSection()).toContain('adoption never verifies it as fact');
  });

  it('does not resend an entry when only Runtime bookkeeping changed', () => {
    const before = renderKnownStateText(state(4, ['atom-a']));
    const afterRevisionBump = renderKnownStateText(state(9, ['atom-a']));
    const afterTimestampMove = renderKnownStateText({
      ...state(9, ['atom-a']),
      references: [reference('atom-a', {
        reactivatedCount: 7,
        firstSeenAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-21T09:09:09.000Z',
        stages: ['execute', 'verify'],
      })],
    });

    expect(afterRevisionBump).toBe(before);
    expect(afterTimestampMove).toBe(before);
  });

  it('still resends the entry when a judgement input changed', () => {
    const before = renderKnownStateText(state(1, ['atom-a']), { includeRules: false });
    const decisionChanged = renderKnownStateText({
      ...state(2, ['atom-a']),
      references: [reference('atom-a', { decision: 'excluded', reason: 'superseded by a later decision' })],
    }, { includeRules: false });
    const evidenceChanged = renderKnownStateText({
      ...state(2, ['atom-a']),
      references: [{
        ...reference('atom-a'),
        evidenceRefs: ['evidence:2'],
        envelope: { ...reference('atom-a').envelope, evidenceRefs: ['evidence:2'] },
      }],
    }, { includeRules: false });

    expect(decisionChanged).not.toBe(before);
    expect(decisionChanged).toContain('decision=excluded');
    expect(decisionChanged).toContain('superseded by a later decision');
    expect(evidenceChanged).not.toBe(before);
    expect(evidenceChanged).toContain('evidence=evidence:2');
  });

  it('keeps the evidence a decision needs and drops only the bookkeeping', () => {
    const text = renderKnownStateText(state(1, ['atom-a']), { includeRules: false });

    for (const kept of [
      'decision=adopted',
      'disclosure=D2',
      'branch=projects',
      'scope=project:littlesheep',
      'tier=T2',
      'statement=fact',
      'epistemic=verified',
      'authority=project/project',
      'confidence=0.90',
      'importance=0.80',
      'path=hierarchy',
      'match=branch matched the request terms',
      'decision_reason=matched the active project scope for this request',
      'sources=source:1',
      'evidence=evidence:1',
    ]) {
      expect(text, `kept: ${kept}`).toContain(kept);
    }
    for (const dropped of [
      'usefulness=',
      'task=',
      'routing=',
      'relation=',
      'activation=',
      'reactivated=',
      'stages=',
      'revision:',
      'updated_at',
      'firstSeen',
    ]) {
      expect(text, `dropped: ${dropped}`).not.toContain(dropped);
    }
    // A conflict or expiry is a judgement input, so it is stated rather than
    // left as an omitted field.
    const conflicted = renderKnownStateText({
      ...state(1, ['atom-a']),
      references: [reference('atom-a', {
        decision: 'conflicted',
        envelope: { ...reference('atom-a').envelope, conflict: true, expired: true },
      })],
    });
    expect(conflicted).toContain('conflict=true');
    expect(conflicted).toContain('expired=true');
  });
});
