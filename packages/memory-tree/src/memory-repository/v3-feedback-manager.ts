// Applies verified run feedback to atom usefulness and existing relation relevance.

import type {
  MemoryAtom,
  MemoryAtomPatch,
  MemoryRelation,
  MemoryUpdateEvent,
  MemoryUseFeedback,
} from '../v3/contracts.js';
import { MEMORY_EVENT_VERSION } from '../v3/contracts.js';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import type { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import { validateMemoryUseFeedback } from '../v3/validation.js';

export const MEMORY_USE_FEEDBACK_PAYLOAD_KEY = 'memoryUseFeedback';

export class MemoryV3FeedbackManager {
  constructor(
    private readonly atomStore: MemoryAtomStore,
    private readonly catalog: MemoryCatalog,
    private readonly coordinator: MemoryV3StorageCoordinator,
    private readonly graphStore: MemoryV3GraphStore,
  ) {}

  async recordMany(feedbacks: MemoryUseFeedback[]): Promise<MemoryAtom[]> {
    const updated: MemoryAtom[] = [];
    for (const feedback of feedbacks) {
      const atom = await this.record(feedback);
      if (atom) updated.push(atom);
    }
    return updated;
  }

  async record(feedbackValue: MemoryUseFeedback): Promise<MemoryAtom | undefined> {
    const feedback = structuredClone(feedbackValue);
    validateMemoryUseFeedback(feedback);
    let atom = await this.atomStore.read(feedback.atomId);
    if (!atom) return undefined;

    if (!this.catalog.hasFeedback(feedback.id)) {
      if (feedback.verified) {
        atom = await this.coordinator.apply(
          feedbackEvent(atom, feedback),
          {
            kind: 'update',
            atomId: atom.id,
            expectedRevision: atom.revision,
            patch: feedbackPatch(atom, feedback),
          },
        );
      } else {
        this.catalog.recordFeedback(feedback);
      }
    }

    if (feedback.verified) await this.updateRelationRelevance(atom, feedback);
    return atom;
  }

  private async updateRelationRelevance(atom: MemoryAtom, feedback: MemoryUseFeedback): Promise<void> {
    for (const relationId of atom.relationRefs) {
      const relation = await this.graphStore.getRelation(relationId);
      if (!relation || relation.status !== 'active' || relation.recentFeedbackIds?.includes(feedback.id)) continue;
      await this.graphStore.upsertRelation({
        ...relation,
        relevance: nextRelationRelevance(relation, feedback.outcome),
        feedbackRevision: (relation.feedbackRevision ?? 0) + 1,
        recentFeedbackIds: [...new Set([...(relation.recentFeedbackIds ?? []), feedback.id])].slice(-256),
        revision: relation.revision + 1,
        updatedAt: feedback.createdAt,
      });
    }
  }
}

function feedbackPatch(atom: MemoryAtom, feedback: MemoryUseFeedback): MemoryAtomPatch {
  const verifiedUsefulness = { ...atom.verifiedUsefulness, lastOutcome: feedback.outcome };
  if (feedback.outcome === 'useful') verifiedUsefulness.useful += 1;
  else if (feedback.outcome === 'not-useful') verifiedUsefulness.notUseful += 1;
  else if (feedback.outcome === 'conflict') verifiedUsefulness.conflicts += 1;
  else verifiedUsefulness.stale += 1;
  return {
    verifiedUsefulness,
    feedbackRevision: atom.feedbackRevision + 1,
    lastUsefulAt: feedback.outcome === 'useful' ? feedback.createdAt : atom.lastUsefulAt,
    lastVerifiedAt: feedback.createdAt,
  };
}

function feedbackEvent(atom: MemoryAtom, feedback: MemoryUseFeedback): MemoryUpdateEvent {
  return {
    version: MEMORY_EVENT_VERSION,
    id: feedback.id,
    idempotencyKey: `memory-use-feedback:${feedback.id}`,
    kind: 'verify-result',
    domain: atom.domain,
    scope: atom.scope,
    scopeKey: atom.scopeKey,
    atomId: atom.id,
    expectedAtomRevision: atom.revision,
    source: { kind: 'system', id: 'memory-v3-feedback-manager' },
    occurredAt: feedback.createdAt,
    observedAt: feedback.createdAt,
    sourceRefs: [],
    evidenceRefs: [...feedback.evidenceRefs],
    payload: { [MEMORY_USE_FEEDBACK_PAYLOAD_KEY]: feedback },
  };
}

function nextRelationRelevance(
  relation: MemoryRelation,
  outcome: MemoryUseFeedback['outcome'],
): number {
  const current = Math.max(0, Math.min(1, relation.relevance));
  if (outcome === 'useful') return Math.min(1, current + (1 - current) * 0.08);
  const retention = outcome === 'conflict' ? 0.85 : outcome === 'stale' ? 0.8 : 0.93;
  return Math.max(0, current * retention);
}
