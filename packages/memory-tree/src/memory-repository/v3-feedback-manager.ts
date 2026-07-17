// Applies verified run feedback to atom usefulness and existing relation relevance.

import type {
  MemoryAtom,
  MemoryAtomPatch,
  MemoryRelation,
  MemoryRoutingFeedback,
  MemoryUpdateEvent,
  MemoryUseFeedback,
} from '../v3/contracts.js';
import { MEMORY_EVENT_VERSION } from '../v3/contracts.js';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import type { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import {
  memoryRoutingEvidenceWeight,
  memoryRoutingFeedbackRelevance,
} from '../v3/priority.js';
import { validateMemoryUseFeedback } from '../v3/validation.js';

export const MEMORY_USE_FEEDBACK_PAYLOAD_KEY = 'memoryUseFeedback';
const MAX_ROUTING_FEEDBACK_EVIDENCE = 64;
const MAX_RECENT_FEEDBACK_IDS = 64;

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

    const alreadyApplied = atom.routingFeedback?.recentFeedbackIds?.includes(feedback.id) ?? false;
    if (!this.catalog.hasFeedback(feedback.id)) {
      if (!alreadyApplied) {
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

    await this.updateRelationRelevance(atom, feedback);
    return atom;
  }

  private async updateRelationRelevance(atom: MemoryAtom, feedback: MemoryUseFeedback): Promise<void> {
    for (const relationId of atom.relationRefs) {
      const relation = await this.graphStore.getRelation(relationId);
      if (!relation || relation.status !== 'active' || relation.recentFeedbackIds?.includes(feedback.id)) continue;
      await this.graphStore.upsertRelation({
        ...relation,
        relevance: nextRelationRelevance(relation, feedback.outcome, feedback.verified),
        feedbackRevision: (relation.feedbackRevision ?? 0) + 1,
        recentFeedbackIds: [...new Set([...(relation.recentFeedbackIds ?? []), feedback.id])].slice(-256),
        revision: relation.revision + 1,
        updatedAt: feedback.createdAt,
      });
    }
  }
}

function feedbackPatch(atom: MemoryAtom, feedback: MemoryUseFeedback): MemoryAtomPatch {
  const patch: MemoryAtomPatch = {
    routingFeedback: nextRoutingFeedback(atom.routingFeedback, feedback),
    feedbackRevision: atom.feedbackRevision + 1,
  };
  if (!feedback.verified) return patch;
  const verifiedUsefulness = { ...atom.verifiedUsefulness, lastOutcome: feedback.outcome };
  if (feedback.outcome === 'useful') verifiedUsefulness.useful += 1;
  else if (feedback.outcome === 'not-useful') verifiedUsefulness.notUseful += 1;
  else if (feedback.outcome === 'conflict') verifiedUsefulness.conflicts += 1;
  else verifiedUsefulness.stale += 1;
  patch.verifiedUsefulness = verifiedUsefulness;
  patch.lastUsefulAt = feedback.outcome === 'useful' ? feedback.createdAt : atom.lastUsefulAt;
  patch.lastVerifiedAt = feedback.createdAt;
  return patch;
}

function nextRoutingFeedback(
  currentValue: MemoryRoutingFeedback | undefined,
  feedback: MemoryUseFeedback,
): MemoryRoutingFeedback {
  const current = currentValue ?? { useful: 0, notUseful: 0, conflicts: 0, stale: 0 };
  if (current.recentFeedbackIds?.includes(feedback.id)) return structuredClone(current);
  const currentRelevance = memoryRoutingFeedbackRelevance(current, feedback.createdAt);
  const currentWeight = memoryRoutingEvidenceWeight(current, feedback.createdAt);
  const observation = routingObservation(feedback.outcome);
  const priorWeight = 2;
  const effectiveRelevance = (
    currentRelevance * (currentWeight + priorWeight)
    + observation.value * observation.weight
  ) / (currentWeight + priorWeight + observation.weight);
  const next: MemoryRoutingFeedback = {
    ...structuredClone(current),
    effectiveRelevance: clamp01(effectiveRelevance),
    effectiveEvidenceWeight: Math.min(
      MAX_ROUTING_FEEDBACK_EVIDENCE,
      currentWeight + observation.weight,
    ),
    lastOutcome: feedback.outcome,
    lastRoutedAt: feedback.createdAt,
    recentFeedbackIds: [...new Set([...(current.recentFeedbackIds ?? []), feedback.id])]
      .slice(-MAX_RECENT_FEEDBACK_IDS),
  };
  const counter = outcomeCounter(feedback.outcome);
  next[counter] += 1;
  if (routingEvidenceCount(next) > MAX_ROUTING_FEEDBACK_EVIDENCE) {
    next.useful = Math.floor(next.useful / 2);
    next.notUseful = Math.floor(next.notUseful / 2);
    next.conflicts = Math.floor(next.conflicts / 2);
    next.stale = Math.floor(next.stale / 2);
    next[counter] = Math.max(1, next[counter]);
  }
  return next;
}

function routingObservation(outcome: MemoryUseFeedback['outcome']): { value: number; weight: number } {
  if (outcome === 'useful') return { value: 1, weight: 1 };
  if (outcome === 'conflict') return { value: 0, weight: 1.5 };
  if (outcome === 'stale') return { value: 0, weight: 1.25 };
  return { value: 0, weight: 1 };
}

function outcomeCounter(outcome: MemoryUseFeedback['outcome']): keyof Pick<
  MemoryRoutingFeedback,
  'useful' | 'notUseful' | 'conflicts' | 'stale'
> {
  if (outcome === 'useful') return 'useful';
  if (outcome === 'not-useful') return 'notUseful';
  if (outcome === 'conflict') return 'conflicts';
  return 'stale';
}

function routingEvidenceCount(feedback: MemoryRoutingFeedback): number {
  return feedback.useful + feedback.notUseful + feedback.conflicts + feedback.stale;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function feedbackEvent(atom: MemoryAtom, feedback: MemoryUseFeedback): MemoryUpdateEvent {
  return {
    version: MEMORY_EVENT_VERSION,
    id: feedback.id,
    idempotencyKey: `memory-use-feedback:${feedback.id}`,
    kind: feedback.verified ? 'verify-result' : 'task-state',
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
  verified: boolean,
): number {
  const current = Math.max(0, Math.min(1, relation.relevance));
  if (outcome === 'useful') {
    return Math.min(1, current + (1 - current) * (verified ? 0.08 : 0.02));
  }
  const retention = verified
    ? outcome === 'conflict' ? 0.85 : outcome === 'stale' ? 0.8 : 0.93
    : outcome === 'conflict' ? 0.97 : outcome === 'stale' ? 0.96 : 0.985;
  return Math.max(0, current * retention);
}
