// Adapts Memory v3 feedback into the shared continuous activation model.

import {
  computeAtomicActivation,
  decayAtomicActivationScore,
  projectAtomicActivationLevel,
  type AtomicActivationSnapshot,
  type AtomicActivationUiLevel,
} from '@littlesheep/types';
import type { MemoryAtom, MemoryCatalogEntry } from './contracts.js';

export function memoryAtomActivation(
  atom: MemoryAtom,
  now: string,
  protectedAtom = false,
): AtomicActivationSnapshot {
  return computeAtomicActivation({
    createdAt: atom.createdAt,
    useful: atom.routingFeedback?.useful ?? 0,
    notUseful: atom.routingFeedback?.notUseful ?? 0,
    conflicts: atom.routingFeedback?.conflicts ?? 0,
    stale: atom.routingFeedback?.stale ?? 0,
    verifiedUseful: atom.verifiedUsefulness.useful,
    verifiedNotUseful: atom.verifiedUsefulness.notUseful,
    verifiedConflicts: atom.verifiedUsefulness.conflicts,
    verifiedStale: atom.verifiedUsefulness.stale,
    effectiveScore: atom.routingFeedback?.effectiveRelevance,
    effectiveEvidenceWeight: atom.routingFeedback?.effectiveEvidenceWeight,
    lastObservedAt: atom.routingFeedback?.lastRoutedAt,
    lastUsefulAt: atom.lastUsefulAt,
  }, now, { protected: protectedAtom });
}

export function memoryCatalogActivationScore(entry: MemoryCatalogEntry, now: string): number {
  return decayAtomicActivationScore(entry.activationScore, entry.activationUpdatedAt, now);
}

export function memoryCatalogActivationLevel(
  entry: MemoryCatalogEntry,
  now: string,
  previous?: AtomicActivationUiLevel,
): AtomicActivationUiLevel {
  return projectAtomicActivationLevel(memoryCatalogActivationScore(entry, now), previous);
}
