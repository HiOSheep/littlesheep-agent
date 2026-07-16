// Rebuilds missing recovery projections from immutable facts without changing facts.

import type { MemoryEventJournalRecord, MemoryImmutableFact } from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryEventJournal } from './event-journal.js';
import { MemoryImmutableFactStore } from './immutable-fact-store.js';
import { classifyMutationProjection, errorMessage } from './storage-mutation-runtime.js';

export const MEMORY_STORAGE_MUTATION_PAYLOAD_KEY = 'memoryStorageMutation';

export interface MemoryFactReconciliationResult {
  queuedEventIds: string[];
  projectedEventIds: string[];
  failed: Array<{ eventId: string; error: string }>;
}

export async function reconcileImmutableFacts(options: {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  eventJournal: MemoryEventJournal;
  factStore: MemoryImmutableFactStore;
  limit: number;
}): Promise<MemoryFactReconciliationResult> {
  const queuedEventIds: string[] = [];
  const projectedEventIds: string[] = [];
  const failed: MemoryFactReconciliationResult['failed'] = [];
  const limit = Math.max(0, Math.floor(options.limit));
  let examined = 0;

  for await (const facts of options.factStore.batches()) {
    const factIds = facts.map((fact) => fact.id);
    const journalIds = await options.eventJournal.knownEventIds(factIds);
    const unresolved = facts.filter((fact) => !journalIds.has(fact.id));
    const catalogIds = options.catalog.knownEventIds(unresolved.map((fact) => fact.id));
    for (const fact of unresolved) {
      if (catalogIds.has(fact.id)) continue;
      if (examined >= limit) return { queuedEventIds, projectedEventIds, failed };
      examined += 1;
      try {
        const state = await classifyMutationProjection(options.atomStore, fact.mutation);
        if (state === 'pending') {
          await options.eventJournal.capture(eventWithMutation(fact));
          queuedEventIds.push(fact.id);
        } else {
          options.catalog.projectEvent(committedFactProjection(fact));
          projectedEventIds.push(fact.id);
        }
      } catch (error) {
        failed.push({ eventId: fact.id, error: errorMessage(error) });
      }
    }
  }
  return { queuedEventIds, projectedEventIds, failed };
}

function eventWithMutation(fact: MemoryImmutableFact): MemoryImmutableFact['event'] {
  return {
    ...structuredClone(fact.event),
    payload: {
      ...structuredClone(fact.event.payload),
      [MEMORY_STORAGE_MUTATION_PAYLOAD_KEY]: structuredClone(fact.mutation),
    },
  };
}

function committedFactProjection(fact: MemoryImmutableFact): MemoryEventJournalRecord {
  return {
    event: eventWithMutation(fact),
    state: 'committed',
    attempts: 0,
    capturedAt: fact.capturedAt,
    updatedAt: fact.capturedAt,
  };
}
