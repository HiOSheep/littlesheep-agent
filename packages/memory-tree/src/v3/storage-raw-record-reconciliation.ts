// Rebuilds missing recovery projections without modifying append-only raw records.

import type { MemoryEventJournalRecord, MemoryRawRecord } from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryEventJournal } from './event-journal.js';
import { MemoryRawRecordStore } from './raw-record-store.js';
import { classifyMutationProjection, errorMessage } from './storage-mutation-runtime.js';

export const MEMORY_STORAGE_MUTATION_PAYLOAD_KEY = 'memoryStorageMutation';

export interface MemoryRawRecordReconciliationResult {
  queuedEventIds: string[];
  projectedEventIds: string[];
  failed: Array<{ eventId: string; error: string }>;
}

export async function reconcileRawRecords(options: {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  eventJournal: MemoryEventJournal;
  rawRecordStore: MemoryRawRecordStore;
  limit: number;
}): Promise<MemoryRawRecordReconciliationResult> {
  const queuedEventIds: string[] = [];
  const projectedEventIds: string[] = [];
  const failed: MemoryRawRecordReconciliationResult['failed'] = [];
  const limit = Math.max(0, Math.floor(options.limit));
  let examined = 0;

  for await (const records of options.rawRecordStore.batches()) {
    const rawRecordIds = records.map((record) => record.id);
    const catalogIds = options.catalog.knownEventIds(rawRecordIds);
    for (const record of records) {
      if (catalogIds.has(record.id)) continue;
      if (examined >= limit) return { queuedEventIds, projectedEventIds, failed };
      examined += 1;
      try {
        const journalRecord = await options.eventJournal.get(record.id);
        if (journalRecord) {
          options.catalog.projectEvent(journalRecord);
          projectedEventIds.push(record.id);
          continue;
        }
        const receipt = await options.rawRecordStore.getCommitReceipt(record.id);
        if (receipt) {
          options.catalog.projectEvent(committedRawRecordProjection(record));
          projectedEventIds.push(record.id);
          continue;
        }
        const state = await classifyMutationProjection(options.atomStore, record.mutation);
        if (state === 'pending') {
          await options.eventJournal.capture(eventWithMutation(record));
          queuedEventIds.push(record.id);
        } else {
          await options.rawRecordStore.markCommitted(record.id, `memory-operation:${record.id}`);
          options.catalog.projectEvent(committedRawRecordProjection(record));
          projectedEventIds.push(record.id);
        }
      } catch (error) {
        failed.push({ eventId: record.id, error: errorMessage(error) });
      }
    }
  }
  return { queuedEventIds, projectedEventIds, failed };
}

function eventWithMutation(record: MemoryRawRecord): MemoryRawRecord['event'] {
  return {
    ...structuredClone(record.event),
    payload: {
      ...structuredClone(record.event.payload),
      [MEMORY_STORAGE_MUTATION_PAYLOAD_KEY]: structuredClone(record.mutation),
    },
  };
}

function committedRawRecordProjection(record: MemoryRawRecord): MemoryEventJournalRecord {
  return {
    event: eventWithMutation(record),
    state: 'committed',
    attempts: 0,
    capturedAt: record.capturedAt,
    updatedAt: record.capturedAt,
  };
}
