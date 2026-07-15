import type {
  MemoryAtom,
  MemoryEventJournalRecord,
  MemoryOperationRecord,
  MemoryStorageMutation,
  MemoryUpdateEvent,
} from './contracts.js';
import { canonicalJson } from './durable-json.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';

const MUTATION_PAYLOAD_KEY = 'memoryStorageMutation';

export type MemoryStorageCheckpoint =
  | 'event-captured'
  | 'operation-started'
  | 'atom-written'
  | 'catalog-updated'
  | 'operation-committed'
  | 'event-committed';

export interface MemoryV3StorageCoordinatorOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  eventJournal: MemoryEventJournal;
  operationJournal: MemoryOperationJournal;
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

export class MemoryV3StorageCoordinator {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly eventJournal: MemoryEventJournal;
  private readonly operationJournal: MemoryOperationJournal;
  private readonly onCheckpoint?: MemoryV3StorageCoordinatorOptions['onCheckpoint'];

  constructor(options: MemoryV3StorageCoordinatorOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.eventJournal = options.eventJournal;
    this.operationJournal = options.operationJournal;
    this.onCheckpoint = options.onCheckpoint;
  }

  async initialize(recoveryLimit = 1_000): Promise<MemoryV3RecoveryResult> {
    const scan = await this.atomStore.initialize();
    await this.eventJournal.initialize();
    await this.operationJournal.initialize();
    let rebuiltCatalog = false;
    if (this.catalog.countAtoms() !== scan.entries.length) {
      await this.catalog.rebuildFrom(this.catalogItems());
      rebuiltCatalog = true;
    }
    const result = await this.recover(recoveryLimit);
    return { ...result, rebuiltCatalog };
  }

  private async *catalogItems() {
    for await (const atom of this.atomStore.iterateAtoms()) {
      yield { atom, filePath: requiredRelativePath(this.atomStore, atom.id) };
    }
  }

  async apply(event: MemoryUpdateEvent, mutation: MemoryStorageMutation): Promise<MemoryAtom> {
    const captured = await this.eventJournal.capture({
      ...structuredClone(event),
      payload: {
        ...structuredClone(event.payload),
        [MUTATION_PAYLOAD_KEY]: structuredClone(mutation),
      },
    });
    await this.checkpoint('event-captured', captured.event.id);
    const persistedMutation = parseStorageMutation(captured.event.payload[MUTATION_PAYLOAD_KEY]);
    return this.resume(captured, persistedMutation);
  }

  async recover(limit = 1_000): Promise<Omit<MemoryV3RecoveryResult, 'rebuiltCatalog'>> {
    const recoveredEventIds: string[] = [];
    const failed: MemoryV3RecoveryResult['failed'] = [];
    for (const record of await this.eventJournal.listOutstanding(limit)) {
      const storedMutation = record.event.payload[MUTATION_PAYLOAD_KEY];
      if (storedMutation === undefined) continue;
      try {
        const mutation = parseStorageMutation(storedMutation);
        await this.resume(record, mutation);
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
        atomIds: [mutation.kind === 'create' ? mutation.atom.id : mutation.atomId],
        eventIds: [record.event.id],
        expectedRevisions: mutation.kind === 'create'
          ? { [mutation.atom.id]: 0 }
          : { [mutation.atomId]: mutation.expectedRevision },
      });
      this.catalog.projectEvent(record);
      this.catalog.projectOperation(operation);
      await this.checkpoint('operation-started', record.event.id, operation.id);

      const atom = await this.applyMutationIdempotently(mutation);
      await this.checkpoint('atom-written', record.event.id, operation.id, atom.id);
      this.catalog.upsertAtom(atom, requiredRelativePath(this.atomStore, atom.id));
      this.catalog.audit(mutation.kind, { eventId: record.event.id, revision: atom.revision }, atom.id, operation.id);
      await this.checkpoint('catalog-updated', record.event.id, operation.id, atom.id);

      if (operation.state !== 'committed') {
        operation = await this.operationJournal.markCommitted(operation.id);
        this.catalog.projectOperation(operation);
      }
      await this.checkpoint('operation-committed', record.event.id, operation.id, atom.id);
      const committedEvent = await this.eventJournal.markCommitted(record.event.id, operation.id);
      this.catalog.projectEvent(committedEvent);
      await this.checkpoint('event-committed', record.event.id, operation.id, atom.id);
      return atom;
    } catch (error) {
      await this.markRecovery(record, operation, error);
      throw error;
    }
  }

  private async applyMutationIdempotently(mutation: MemoryStorageMutation): Promise<MemoryAtom> {
    if (mutation.kind === 'create') {
      const existing = await this.atomStore.read(mutation.atom.id);
      if (!existing) return this.atomStore.create(mutation.atom);
      if (!matchesDefinedFields(existing, mutation.atom)) {
        throw new Error(`Existing atom ${existing.id} does not match the captured create mutation.`);
      }
      return existing;
    }

    const existing = await this.atomStore.read(mutation.atomId);
    if (!existing) throw new Error(`Memory atom not found during recovery: ${mutation.atomId}`);
    if (mutation.kind === 'update') {
      if (existing.revision === mutation.expectedRevision) {
        return this.atomStore.update(existing.id, mutation.expectedRevision, mutation.patch);
      }
      if (existing.revision === mutation.expectedRevision + 1 && matchesDefinedFields(existing, mutation.patch)) {
        return existing;
      }
      throw new Error(`Memory atom ${existing.id} changed after the captured update mutation.`);
    }
    const targetStatus = mutation.kind === 'archive' ? 'archived' : 'active';
    if (existing.revision === mutation.expectedRevision) {
      return mutation.kind === 'archive'
        ? this.atomStore.archive(existing.id, mutation.expectedRevision)
        : this.atomStore.restore(existing.id, mutation.expectedRevision);
    }
    if (existing.revision === mutation.expectedRevision + 1 && existing.status === targetStatus) return existing;
    throw new Error(`Memory atom ${existing.id} changed after the captured ${mutation.kind} mutation.`);
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
}

function parseStorageMutation(value: unknown): MemoryStorageMutation {
  if (!value || typeof value !== 'object') throw new Error('Memory event is missing its storage mutation payload.');
  const mutation = value as Partial<MemoryStorageMutation> & Record<string, unknown>;
  if (mutation.kind === 'create' && mutation.atom && typeof mutation.atom === 'object') {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'create' }>);
  }
  if (mutation.kind === 'update'
    && typeof mutation.atomId === 'string'
    && Number.isInteger(mutation.expectedRevision)
    && mutation.patch && typeof mutation.patch === 'object') {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'update' }>);
  }
  if ((mutation.kind === 'archive' || mutation.kind === 'restore')
    && typeof mutation.atomId === 'string'
    && Number.isInteger(mutation.expectedRevision)) {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'archive' | 'restore' }>);
  }
  throw new Error('Memory event contains an invalid storage mutation payload.');
}

function matchesDefinedFields(target: object, expected: object): boolean {
  const targetRecord = target as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => canonicalJson(targetRecord[key]) === canonicalJson(value));
}

function requiredRelativePath(store: MemoryAtomStore, atomId: string): string {
  const path = store.relativePathFor(atomId);
  if (!path) throw new Error(`Memory atom has no registered file path: ${atomId}`);
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
