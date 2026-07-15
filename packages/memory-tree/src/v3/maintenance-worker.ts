// Runs bounded Memory v3 startup/background maintenance without long-lived polling timers.

import { randomUUID } from 'node:crypto';
import type { MemoryAtom, MemoryCatalogEntry, MemoryDueRecord, MemoryUpdateEvent } from './contracts.js';
import { MEMORY_EVENT_VERSION } from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { EmbeddingUnavailableError } from './embedding-engine.js';
import { MemoryEventJournal } from './event-journal.js';

const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
const DEFAULT_DUE_BATCH_SIZE = 100;

export interface MemoryV3MaintenanceWorkerOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  eventJournal: MemoryEventJournal;
  embeddingBatchSize?: number;
  dueBatchSize?: number;
  now?: () => Date;
  yieldControl?: () => Promise<void>;
}

export interface MemoryV3MaintenanceFailure {
  atomId: string;
  error: string;
}

export interface MemoryV3MaintenanceResult {
  due: {
    selected: number;
    captured: number;
    remaining: number;
    failures: MemoryV3MaintenanceFailure[];
  };
  embeddings: {
    selected: number;
    indexed: number;
    remaining: number;
    unavailable: boolean;
    failures: MemoryV3MaintenanceFailure[];
  };
}

export class MemoryV3MaintenanceWorker {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly eventJournal: MemoryEventJournal;
  private readonly embeddingBatchSize: number;
  private readonly dueBatchSize: number;
  private readonly now: () => Date;
  private readonly yieldControl: () => Promise<void>;
  private activeRun?: Promise<MemoryV3MaintenanceResult>;

  constructor(options: MemoryV3MaintenanceWorkerOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.eventJournal = options.eventJournal;
    this.embeddingBatchSize = boundedBatchSize(options.embeddingBatchSize, DEFAULT_EMBEDDING_BATCH_SIZE);
    this.dueBatchSize = boundedBatchSize(options.dueBatchSize, DEFAULT_DUE_BATCH_SIZE);
    this.now = options.now ?? (() => new Date());
    this.yieldControl = options.yieldControl ?? (() => Promise.resolve());
  }

  runStartupCompensation(signal?: AbortSignal): Promise<MemoryV3MaintenanceResult> {
    if (this.activeRun) return this.activeRun;
    const run = this.execute(signal).finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
    });
    this.activeRun = run;
    return run;
  }

  runAfterWrite(signal?: AbortSignal): Promise<MemoryV3MaintenanceResult> {
    const activeAtRequest = this.activeRun;
    if (!activeAtRequest) return this.runStartupCompensation(signal);

    // A write can land after the active batch selected its work. Wait for that
    // batch, then coalesce all concurrent write follow-ups into one more pass.
    return activeAtRequest
      .catch(() => undefined)
      .then(() => this.runStartupCompensation(signal));
  }

  private async execute(signal?: AbortSignal): Promise<MemoryV3MaintenanceResult> {
    throwIfAborted(signal);
    const now = this.now().toISOString();
    const dueResult = await this.captureDueEvents(now, signal);
    await this.yieldControl();
    throwIfAborted(signal);
    const embeddingResult = await this.rebuildEmbeddingBatch(signal);
    return {
      due: {
        ...dueResult,
        remaining: this.catalog.countDue(now),
      },
      embeddings: {
        ...embeddingResult,
        remaining: this.catalog.countEmbeddingWork(),
      },
    };
  }

  private async captureDueEvents(
    observedAt: string,
    signal?: AbortSignal,
  ): Promise<Omit<MemoryV3MaintenanceResult['due'], 'remaining'>> {
    const records = this.catalog.listDue(observedAt, this.dueBatchSize);
    const failures: MemoryV3MaintenanceFailure[] = [];
    let captured = 0;
    for (const due of records) {
      throwIfAborted(signal);
      try {
        const atom = await this.atomStore.read(due.atomId);
        if (!atom) throw new Error('The due atom is missing from the authoritative atom store.');
        const journalRecord = await this.eventJournal.capture(createDueEvent(atom, due, observedAt));
        this.catalog.projectEvent(journalRecord);
        this.catalog.acknowledgeDue(due);
        captured += 1;
      } catch (error) {
        failures.push({ atomId: due.atomId, error: errorMessage(error) });
      }
    }
    return { selected: records.length, captured, failures };
  }

  private async rebuildEmbeddingBatch(
    signal?: AbortSignal,
  ): Promise<Omit<MemoryV3MaintenanceResult['embeddings'], 'remaining'>> {
    const entries = this.catalog.listEmbeddingWork(this.embeddingBatchSize);
    const failures: MemoryV3MaintenanceFailure[] = [];
    const atoms: MemoryAtom[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      const atom = await this.atomStore.read(entry.atomId);
      if (atom) atoms.push(atom);
      else failures.push({ atomId: entry.atomId, error: 'The catalog entry has no authoritative atom file.' });
    }
    if (atoms.length === 0) {
      return { selected: entries.length, indexed: 0, unavailable: false, failures };
    }

    try {
      const indexed = await this.catalog.indexEmbeddings(atoms, signal);
      return { selected: entries.length, indexed: indexed.length, unavailable: false, failures };
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) {
        return { selected: entries.length, indexed: 0, unavailable: true, failures };
      }
      const fallback = await this.indexIndividually(atoms, signal);
      failures.push(...fallback.failures);
      return { selected: entries.length, indexed: fallback.indexed, unavailable: false, failures };
    }
  }

  private async indexIndividually(
    atoms: MemoryAtom[],
    signal?: AbortSignal,
  ): Promise<{ indexed: number; failures: MemoryV3MaintenanceFailure[] }> {
    const failures: MemoryV3MaintenanceFailure[] = [];
    let indexed = 0;
    for (const atom of atoms) {
      throwIfAborted(signal);
      try {
        await this.catalog.indexEmbedding(atom, signal);
        indexed += 1;
      } catch (error) {
        if (error instanceof EmbeddingUnavailableError) throw error;
        failures.push({ atomId: atom.id, error: errorMessage(error) });
      }
      await this.yieldControl();
    }
    return { indexed, failures };
  }
}

function createDueEvent(atom: MemoryAtom, due: MemoryDueRecord, observedAt: string): MemoryUpdateEvent {
  return {
    version: MEMORY_EVENT_VERSION,
    id: randomUUID(),
    idempotencyKey: `memory-time-due:${atom.id}:${due.kind}:${due.dueAt}`,
    kind: 'time-due',
    domain: atom.domain,
    scope: atom.scope,
    scopeKey: atom.scopeKey,
    atomId: atom.id,
    expectedAtomRevision: atom.revision,
    source: { kind: 'system', id: 'memory-v3-due-index', label: 'Memory v3 due index' },
    occurredAt: due.dueAt,
    observedAt,
    evidenceRefs: [`memory-atom:${atom.id}@${atom.revision}`],
    payload: {
      dueKind: due.kind,
      dueAt: due.dueAt,
      atomRevision: atom.revision,
    },
  };
}

function boundedBatchSize(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value! <= 0) return fallback;
  return Math.min(value!, 1_000);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Memory v3 maintenance was aborted.');
  error.name = 'AbortError';
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
