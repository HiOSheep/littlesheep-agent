import { describe, expect, it } from 'vitest';
import { applyFragmentEvidence } from './memory-tree-evidence.js';
import { InjectionTier, type MemoryFragment } from './types.js';
import type { MemoryEvidenceEnvelope, MemoryKnownState } from './v3/contracts.js';

describe('MemoryTree evidence transitions', () => {
  it('keeps an active adopted Atom adopted when a later retrieval only deduplicates it', () => {
    const envelope = evidence();
    const state: MemoryKnownState = {
      version: 1,
      runId: 'run-1',
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [{
        atomId: envelope.atomId,
        atomRevision: envelope.atomRevision,
        sourceRefs: [...envelope.sourceRefs],
        evidenceRefs: [...envelope.evidenceRefs],
        decision: 'adopted',
        reason: 'The Atom entered Context.',
        envelope,
        stages: ['expand'],
        firstSeenAt: '2026-07-17T08:00:00.000Z',
        updatedAt: '2026-07-17T08:00:00.000Z',
        reactivatedCount: 0,
      }],
    };
    const fragment: MemoryFragment = {
      id: envelope.atomId,
      branchId: 'project',
      tier: InjectionTier.T2_RELEVANT,
      priority: 0.9,
      content: 'Use the indexed project policy.',
      tokenEstimate: 8,
      truncatable: true,
      dedupKey: `project:${envelope.atomId}`,
      matchReason: envelope.matchReason,
      evidence: envelope,
      metadata: { source: 'test', kind: 'memory-v3', generatedAt: envelope.updatedAt },
    };

    const delta = applyFragmentEvidence(state, {
      fragments: [],
      excluded: [{ fragment, reason: 'Duplicate evidence was already adopted earlier in this run.' }],
    }, 'expand');

    expect(delta).toEqual([]);
    expect(state.references[0]?.decision).toBe('adopted');
    expect(state.revision).toBe(1);
  });
});

function evidence(): MemoryEvidenceEnvelope {
  return {
    atomId: 'atom-active',
    atomRevision: 1,
    branch: 'project',
    scope: 'global',
    tier: 2,
    disclosureLevel: 'D2',
    statementKind: 'instruction',
    epistemicStatus: 'reported',
    authorityScope: { kind: 'user-self', scope: 'global', topics: ['project-policy'] },
    assertedBy: { kind: 'user', id: 'local-user' },
    sourceRefs: ['conversation-source:run-1:user-message:1'],
    evidenceRefs: [],
    confidence: 0.9,
    importance: 0.8,
    verifiedUsefulness: { useful: 0, notUseful: 0, conflicts: 0, stale: 0 },
    taskRelevance: 0.9,
    routingRelevance: 0.5,
    relationshipRelevance: 0.5,
    activation: {
      version: 1,
      score: 0.5,
      quality: 0.5,
      frequency: 0.5,
      recency: 1,
      evidenceWeight: 1,
      protected: false,
      computedAt: '2026-07-17T08:00:00.000Z',
    },
    updatedAt: '2026-07-17T08:00:00.000Z',
    retrievalPath: 'fts',
    matchReason: 'TaskBook goal matched the project policy.',
    conflict: false,
    expired: false,
    truncated: false,
  };
}
