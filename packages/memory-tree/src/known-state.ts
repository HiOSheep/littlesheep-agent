import type {
  KnownStateMemoryDecision,
  KnownStateMemoryReference,
  MemoryEvidenceEnvelope,
  MemoryKnownState,
} from './v3/contracts.js';

const MAX_KNOWN_STATE_REFERENCES = 128;

export interface KnownStateUpdate {
  envelope: MemoryEvidenceEnvelope;
  decision: KnownStateMemoryDecision;
  reason: string;
  stage: string;
}

export function createMemoryKnownState(runId: string, at: string): MemoryKnownState {
  return { version: 1, runId, revision: 0, updatedAt: at, references: [] };
}

export function cloneMemoryKnownState(state: MemoryKnownState): MemoryKnownState {
  return structuredClone(state);
}

export function updateMemoryKnownState(
  state: MemoryKnownState,
  updates: KnownStateUpdate[],
  at: string,
): KnownStateMemoryReference[] {
  if (updates.length === 0) return [];
  const byAtom = new Map(state.references.map((reference) => [reference.atomId, reference]));
  const delta: KnownStateMemoryReference[] = [];
  for (const update of updates) {
    const existing = byAtom.get(update.envelope.atomId);
    const reactivated = Boolean(existing && existing.decision !== 'adopted' && update.decision === 'adopted');
    const reference: KnownStateMemoryReference = {
      atomId: update.envelope.atomId,
      atomRevision: update.envelope.atomRevision,
      evidenceRefs: [...update.envelope.evidenceRefs],
      decision: update.decision,
      reason: update.reason,
      envelope: structuredClone(update.envelope),
      stages: [...new Set([...(existing?.stages ?? []), update.stage])],
      firstSeenAt: existing?.firstSeenAt ?? at,
      updatedAt: at,
      reactivatedCount: (existing?.reactivatedCount ?? 0) + (reactivated ? 1 : 0),
    };
    byAtom.set(reference.atomId, reference);
    delta.push(structuredClone(reference));
  }
  const retained = [...byAtom.values()]
    .sort((left, right) => knownStateRank(right) - knownStateRank(left)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.atomId.localeCompare(right.atomId))
    .slice(0, MAX_KNOWN_STATE_REFERENCES);
  state.references = retained;
  state.revision += 1;
  state.updatedAt = at;
  return delta;
}

function knownStateRank(reference: KnownStateMemoryReference): number {
  const decision = reference.decision === 'conflicted' ? 3 : reference.decision === 'adopted' ? 2 : 1;
  const tier = 4 - reference.envelope.tier;
  return decision * 10 + tier + reference.envelope.importance + reference.envelope.confidence;
}
