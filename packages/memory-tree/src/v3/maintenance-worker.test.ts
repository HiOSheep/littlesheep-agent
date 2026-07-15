import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEngine, EmbeddingRequest, EmbeddingResult } from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';
import { MemoryV3MaintenanceWorker } from './maintenance-worker.js';
import { MemoryV3StorageCoordinator } from './storage-coordinator.js';
import { makeAtomInput } from './test-fixtures.js';

describe('MemoryV3MaintenanceWorker', () => {
  let dataDir: string;
  let atomStore: MemoryAtomStore;
  let eventJournal: MemoryEventJournal;
  let catalog: MemoryCatalog | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-maintenance-'));
    atomStore = new MemoryAtomStore({ dataDir });
    eventJournal = new MemoryEventJournal({ dataDir });
    await atomStore.initialize();
    await eventJournal.initialize();
  });

  afterEach(async () => {
    catalog?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rebuilds embeddings in bounded batches', async () => {
    const engine = makeEngine(true);
    catalog = new MemoryCatalog({ dataDir, embeddingEngine: engine });
    for (const id of ['atom-a', 'atom-b', 'atom-c']) {
      const atom = await atomStore.create(makeAtomInput({ id, title: id, content: `content ${id}` }));
      catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    }
    const worker = new MemoryV3MaintenanceWorker({
      atomStore,
      catalog,
      eventJournal,
      embeddingBatchSize: 2,
    });

    const first = await worker.runStartupCompensation();
    expect(first.embeddings).toMatchObject({ selected: 2, indexed: 2, remaining: 1, unavailable: false });
    const second = await worker.runStartupCompensation();
    expect(second.embeddings).toMatchObject({ selected: 1, indexed: 1, remaining: 0, unavailable: false });
    expect(engine.embed).toHaveBeenCalledTimes(2);
    expect((engine.embed as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.texts.length)).toEqual([2, 1]);
  });

  it('captures overdue records once and leaves them for the repository event consumer', async () => {
    const now = () => new Date('2026-07-15T06:00:00.000Z');
    catalog = new MemoryCatalog({ dataDir });
    const atom = await atomStore.create(makeAtomInput({
      id: 'due-atom',
      expiresAt: '2026-07-15T05:00:00.000Z',
    }));
    catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    const worker = new MemoryV3MaintenanceWorker({ atomStore, catalog, eventJournal, now });

    const first = await worker.runStartupCompensation();
    expect(first.due).toMatchObject({ selected: 1, captured: 1, remaining: 0, failures: [] });
    const [record] = await eventJournal.listOutstanding();
    expect(record?.event).toMatchObject({
      kind: 'time-due',
      atomId: atom.id,
      occurredAt: atom.expiresAt,
      observedAt: '2026-07-15T06:00:00.000Z',
      payload: { dueKind: 'expiry', dueAt: atom.expiresAt, atomRevision: atom.revision },
    });

    catalog.replaceDueRecords(atom.id, [{ atomId: atom.id, kind: 'expiry', dueAt: atom.expiresAt! }]);
    await worker.runStartupCompensation();
    expect(await eventJournal.count()).toBe(1);

    const coordinator = new MemoryV3StorageCoordinator({
      atomStore,
      catalog,
      eventJournal,
      operationJournal: new MemoryOperationJournal({ dataDir }),
    });
    await expect(coordinator.recover()).resolves.toEqual({ recoveredEventIds: [], failed: [] });
  });

  it('keeps work pending when a configured local model is temporarily unavailable', async () => {
    const engine = makeEngine(false);
    catalog = new MemoryCatalog({ dataDir, embeddingEngine: engine });
    for (const id of ['pending-a', 'pending-b']) {
      const atom = await atomStore.create(makeAtomInput({ id }));
      catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    }
    const worker = new MemoryV3MaintenanceWorker({ atomStore, catalog, eventJournal, embeddingBatchSize: 2 });

    const result = await worker.runStartupCompensation();
    expect(result.embeddings).toMatchObject({ selected: 2, indexed: 0, remaining: 2, unavailable: true });
    expect(catalog.listEmbeddingWork(2).every((entry) => entry.embeddingStatus === 'pending')).toBe(true);
    expect(engine.embed).not.toHaveBeenCalled();
  });

  it('runs one coalesced follow-up batch when a write lands during active embedding work', async () => {
    let releaseFirstEmbedding!: () => void;
    let markFirstEmbeddingStarted!: () => void;
    const firstEmbeddingStarted = new Promise<void>((resolve) => { markFirstEmbeddingStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirstEmbedding = resolve; });
    const engine = makeEngine(true);
    const baseEmbed = engine.embed;
    engine.embed = vi.fn(async (request: EmbeddingRequest): Promise<EmbeddingResult> => {
      if ((engine.embed as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
        markFirstEmbeddingStarted();
        await release;
      }
      return baseEmbed(request);
    });
    catalog = new MemoryCatalog({ dataDir, embeddingEngine: engine });
    const firstAtom = await atomStore.create(makeAtomInput({ id: 'active-batch-atom' }));
    catalog.upsertAtom(firstAtom, atomStore.relativePathFor(firstAtom.id)!);
    const worker = new MemoryV3MaintenanceWorker({ atomStore, catalog, eventJournal, embeddingBatchSize: 1 });

    const activeRun = worker.runStartupCompensation();
    await firstEmbeddingStarted;
    const lateAtom = await atomStore.create(makeAtomInput({ id: 'late-write-atom' }));
    catalog.upsertAtom(lateAtom, atomStore.relativePathFor(lateAtom.id)!);
    const followUp = worker.runAfterWrite();
    releaseFirstEmbedding();

    await Promise.all([activeRun, followUp]);
    expect(catalog.countEmbeddingWork()).toBe(0);
    expect(engine.embed).toHaveBeenCalledTimes(2);
  });
});

function makeEngine(available: boolean): EmbeddingEngine {
  const descriptor = {
    engineId: 'test-local',
    modelId: 'test-model',
    version: '1',
    dimensions: 2,
    transport: 'local' as const,
  };
  return {
    descriptor,
    isAvailable: vi.fn(async () => available),
    embed: vi.fn(async (request: EmbeddingRequest): Promise<EmbeddingResult> => ({
      descriptor,
      vectors: request.texts.map((text) => text.includes('atom-a') ? [1, 0] : [0, 1]),
    })),
  };
}
