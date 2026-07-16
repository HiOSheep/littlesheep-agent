// Coordinates immutable fact capture, journals, atom files and catalog commits.
import type {
  MemoryAtom,
  MemoryEventJournalRecord,
  MemoryOperationRecord,
  MemoryStorageMutation,
  MemoryUpdateEvent,
} from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';
import { MemoryImmutableFactStore } from './immutable-fact-store.js';
import {
  MEMORY_STORAGE_MUTATION_PAYLOAD_KEY,
  reconcileImmutableFacts,
} from './storage-fact-reconciliation.js';
import {
  assertUpdateCanResume,
  errorMessage,
  matchesDefinedFields,
  mutationAtomIds,
  mutationExpectedRevisions,
  parseStorageMutation,
  requiredRelativePath,
} from './storage-mutation-runtime.js';

export type MemoryStorageCheckpoint =
  | 'fact-captured'
  | 'event-captured'
  | 'operation-started'
  | 'merge-target-written'
  | 'merge-source-written'
  | 'atom-written'
  | 'catalog-updated'
  | 'operation-committed'
  | 'event-committed';

export interface MemoryV3StorageCoordinatorOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  eventJournal: MemoryEventJournal;
  operationJournal: MemoryOperationJournal;
  factStore: MemoryImmutableFactStore;
  onCheckpoint?: (
    checkpoint: MemoryStorageCheckpoint,
    context: { eventId: string; operationId?: string; atomId?: string },
  ) => void | Promise<void>;
}

export interface MemoryV3RecoveryResult {
  recoveredEventIds: string[];
  failed: Array<{ eventId: string; error: string }>;
  rebuiltCatalog: boolean;
}

interface AppliedMemoryMutation {
  primary: MemoryAtom;
  affected: MemoryAtom[];
}

export class MemoryV3StorageCoordinator {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly eventJournal: MemoryEventJournal;
  private readonly operationJournal: MemoryOperationJournal;
  private readonly factStore: MemoryImmutableFactStore;
  private readonly onCheckpoint?: MemoryV3StorageCoordinatorOptions['onCheckpoint'];
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3StorageCoordinatorOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.eventJournal = options.eventJournal;
    this.operationJournal = options.operationJournal;
    this.factStore = options.factStore;
    this.onCheckpoint = options.onCheckpoint;
  }

  async initialize(recoveryLimit = 1_000): Promise<MemoryV3RecoveryResult> {
    const scan = await this.atomStore.initialize();
    await this.factStore.initialize();
    await this.eventJournal.initialize();
    await this.operationJournal.initialize();
    let rebuiltCatalog = false;
    if (this.catalog.countAtoms() !== scan.entries.length) {
      await this.catalog.rebuildFrom(this.catalogItems());
      rebuiltCatalog = true;
    }
    const facts = await reconcileImmutableFacts({
      atomStore: this.atomStore,
      catalog: this.catalog,
      eventJournal: this.eventJournal,
      factStore: this.factStore,
      limit: recoveryLimit,
    });
    const result = await this.recover(recoveryLimit);
    return { ...result, failed: [...facts.failed, ...result.failed], rebuiltCatalog };
  }

  private async *catalogItems() {
    for await (const atom of this.atomStore.iterateAtoms()) {
      yield { atom, filePath: requiredRelativePath(this.atomStore, atom.id) };
    }
  }

  async apply(event: MemoryUpdateEvent, mutation: MemoryStorageMutation): Promise<MemoryAtom> {
    return this.exclusive(async () => {
      const fact = await this.factStore.capture(event, mutation);
      await this.checkpoint('fact-captured', fact.id);
      const captured = await this.eventJournal.capture({
        ...structuredClone(event),
        payload: {
          ...structuredClone(event.payload),
          [MEMORY_STORAGE_MUTATION_PAYLOAD_KEY]: structuredClone(mutation),
        },
      });
      await this.checkpoint('event-captured', captured.event.id);
      const persistedMutation = parseStorageMutation(
        captured.event.payload[MEMORY_STORAGE_MUTATION_PAYLOAD_KEY],
      );
      return this.resume(captured, persistedMutation);
    });
  }

  async recover(limit = 1_000): Promise<Omit<MemoryV3RecoveryResult, 'rebuiltCatalog'>> {
    const recoveredEventIds: string[] = [];
    const failed: MemoryV3RecoveryResult['failed'] = [];
    for (const record of await this.eventJournal.listOutstanding(limit)) {
      const storedMutation = record.event.payload[MEMORY_STORAGE_MUTATION_PAYLOAD_KEY];
      if (storedMutation === undefined) continue;
      try {
        const mutation = parseStorageMutation(storedMutation);
        await this.exclusive(() => this.resume(record, mutation));
        recoveredEventIds.push(record.event.id);
      } catch (error) {
        failed.push({ eventId: record.event.id, error: errorMessage(error) });
      }
    }
    return { recoveredEventIds, failed };
  }

  private async resume(record: MemoryEventJournalRecord, mutation: MemoryStorageMutation): Promise<MemoryAtom> {
    const operationId = `memory-operation:${record.event.id}`;
    let operation = await this.operationJournal.get(operationId);
    try {
      operation ??= await this.operationJournal.start({
        id: operationId,
        idempotencyKey: `memory-event:${record.event.idempotencyKey}`,
        kind: mutation.kind,
        atomIds: mutationAtomIds(mutation),
        eventIds: [record.event.id],
        expectedRevisions: mutationExpectedRevisions(mutation),
      });
      this.catalog.projectEvent(record);
      this.catalog.projectOperation(operation);
      await this.checkpoint('operation-started', record.event.id, operation.id);

      const applied = await this.applyMutationIdempotently(mutation, record.event.id, operation.id);
      await this.checkpoint('atom-written', record.event.id, operation.id, applied.primary.id);
      for (const atom of applied.affected) {
        this.catalog.upsertAtom(atom, requiredRelativePath(this.atomStore, atom.id));
        this.catalog.audit(mutation.kind, {
          eventId: record.event.id,
          revision: atom.revision,
          affectedAtomIds: applied.affected.map((candidate) => candidate.id),
        }, atom.id, operation.id);
      }
      await this.checkpoint('catalog-updated', record.event.id, operation.id, applied.primary.id);

      if (operation.state !== 'committed') {
        operation = await this.operationJournal.markCommitted(operation.id);
        this.catalog.projectOperation(operation);
      }
      await this.checkpoint('operation-committed', record.event.id, operation.id, applied.primary.id);
      const committedEvent = await this.eventJournal.markCommitted(record.event.id, operation.id);
      this.catalog.projectEvent(committedEvent);
      await this.checkpoint('event-committed', record.event.id, operation.id, applied.primary.id);
      return applied.primary;
    } catch (error) {
      await this.markRecovery(record, operation, error);
      throw error;
    }
  }

  private async applyMutationIdempotently(
    mutation: MemoryStorageMutation,
    eventId: string,
    operationId: string,
  ): Promise<AppliedMemoryMutation> {
    if (mutation.kind === 'create') {
      const existing = await this.atomStore.read(mutation.atom.id);
      if (!existing) {
        const atom = await this.atomStore.create(mutation.atom);
        return { primary: atom, affected: [atom] };
      }
      if (!matchesDefinedFields(existing, mutation.atom)) {
        throw new Error(`Existing atom ${existing.id} does not match the captured create mutation.`);
      }
      return { primary: existing, affected: [existing] };
    }
    if (mutation.kind === 'merge') {
      const [targetBefore, sourceBefore] = await Promise.all([
        this.atomStore.read(mutation.targetAtomId),
        this.atomStore.read(mutation.sourceAtomId),
      ]);
      assertUpdateCanResume(targetBefore, mutation.targetAtomId, mutation.targetExpectedRevision, mutation.targetPatch, 'merge target');
      assertUpdateCanResume(sourceBefore, mutation.sourceAtomId, mutation.sourceExpectedRevision, mutation.sourcePatch, 'merge source');
      const target = await this.applyUpdateIdempotently(
        mutation.targetAtomId,
        mutation.targetExpectedRevision,
        mutation.targetPatch,
        'merge target',
      );
      await this.checkpoint('merge-target-written', eventId, operationId, target.id);
      const source = await this.applyUpdateIdempotently(
        mutation.sourceAtomId,
        mutation.sourceExpectedRevision,
        mutation.sourcePatch,
        'merge source',
      );
      await this.checkpoint('merge-source-written', eventId, operationId, source.id);
      return { primary: target, affected: [target, source] };
    }

    const existing = await this.atomStore.read(mutation.atomId);
    if (!existing) throw new Error(`Memory atom not found during recovery: ${mutation.atomId}`);
    if (mutation.kind === 'update') {
      const atom = await this.applyUpdateIdempotently(
        mutation.atomId,
        mutation.expectedRevision,
        mutation.patch,
        'update',
      );
      return { primary: atom, affected: [atom] };
    }
    const targetStatus = mutation.kind === 'archive' ? 'archived' : 'active';
    if (existing.revision === mutation.expectedRevision) {
      const atom = await (mutation.kind === 'archive'
        ? this.atomStore.archive(existing.id, mutation.expectedRevision)
        : this.atomStore.restore(existing.id, mutation.expectedRevision));
      return { primary: atom, affected: [atom] };
    }
    if (existing.revision === mutation.expectedRevision + 1 && existing.status === targetStatus) {
      return { primary: existing, affected: [existing] };
    }
    throw new Error(`Memory atom ${existing.id} changed after the captured ${mutation.kind} mutation.`);
  }

  private async applyUpdateIdempotently(
    atomId: string,
    expectedRevision: number,
    patch: Extract<MemoryStorageMutation, { kind: 'update' }>['patch'],
    label: string,
  ): Promise<MemoryAtom> {
    const existing = await this.atomStore.read(atomId);
    if (!existing) throw new Error(`Memory atom not found during ${label}: ${atomId}`);
    if (existing.revision === expectedRevision) {
      return this.atomStore.update(existing.id, expectedRevision, patch);
    }
    if (existing.revision === expectedRevision + 1 && matchesDefinedFields(existing, patch)) {
      return existing;
    }
    throw new Error(`Memory atom ${existing.id} changed after the captured ${label} mutation.`);
  }

  private async markRecovery(
    event: MemoryEventJournalRecord,
    operation: MemoryOperationRecord | undefined,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);
    if (operation && operation.state !== 'committed') {
      const recoveryOperation = await this.operationJournal.markRecovery(operation.id, message).catch(() => undefined);
      if (recoveryOperation) this.catalog.projectOperation(recoveryOperation);
    }
    const recoveryEvent = await this.eventJournal.markRecovery(event.event.id, message, operation?.id).catch(() => undefined);
    if (recoveryEvent) this.catalog.projectEvent(recoveryEvent);
  }

  private checkpoint(
    checkpoint: MemoryStorageCheckpoint,
    eventId: string,
    operationId?: string,
    atomId?: string,
  ): Promise<void> {
    return Promise.resolve(this.onCheckpoint?.(checkpoint, { eventId, operationId, atomId }));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
