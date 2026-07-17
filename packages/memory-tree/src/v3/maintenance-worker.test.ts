import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEngine, EmbeddingRequest, EmbeddingResult } from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';
import { MemoryRawRecordStore } from './raw-record-store.js';
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

  it('drains every bounded embedding batch in the background and coalesces concurrent requests', async () => {
    const engine = makeEngine(true);
    catalog = new MemoryCatalog({ dataDir, embeddingEngine: engine });
    for (const id of ['drain-a', 'drain-b', 'drain-c', 'drain-d', 'drain-e']) {
      const atom = await atomStore.create(makeAtomInput({ id, title: id, content: `content ${id}` }));
      catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    }
    const worker = new MemoryV3MaintenanceWorker({
      atomStore,
      catalog,
      eventJournal,
      embeddingBatchSize: 2,
    });

    const first = worker.startBackgroundDrain();
    const second = worker.startBackgroundDrain();
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      passes: 3,
      indexed: 5,
      stalled: false,
      aborted: false,
      last: { embeddings: { remaining: 0 } },
    });
    expect(catalog.countEmbeddingWork()).toBe(0);
    expect((engine.embed as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.texts.length))
      .toEqual([2, 2, 1]);
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
      rawRecordStore: new MemoryRawRecordStore({ dataDir }),
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

  it('stops a background drain when the model is unavailable and retries on a later trigger', async () => {
    let available = false;
    const engine = makeEngine(true);
    engine.isAvailable = vi.fn(async () => available);
    catalog = new MemoryCatalog({ dataDir, embeddingEngine: engine });
    for (const id of ['retry-a', 'retry-b']) {
      const atom = await atomStore.create(makeAtomInput({ id }));
      catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    }
    const worker = new MemoryV3MaintenanceWorker({ atomStore, catalog, eventJournal, embeddingBatchSize: 1 });

    await expect(worker.startBackgroundDrain()).resolves.toMatchObject({
      passes: 1,
      indexed: 0,
      stalled: true,
      aborted: false,
      last: { embeddings: { unavailable: true, remaining: 2 } },
    });
    available = true;
    await expect(worker.startBackgroundDrain()).resolves.toMatchObject({
      passes: 2,
      indexed: 2,
      stalled: false,
      aborted: false,
    });
    expect(catalog.countEmbeddingWork()).toBe(0);
  });

  it('aborts and awaits a background drain before shutdown completes', async () => {
    let yieldCount = 0;
    let markBetweenPasses!: () => void;
    let releaseYield!: () => void;
    const betweenPasses = new Promise<void>((resolve) => { markBetweenPasses = resolve; });
    const yieldGate = new Promise<void>((resolve) => { releaseYield = resolve; });
    const engine = makeEngine(true);
    catalog = new MemoryCatalog({ dataDir, embeddingEngine: engine });
    for (const id of ['shutdown-a', 'shutdown-b', 'shutdown-c']) {
      const atom = await atomStore.create(makeAtomInput({ id }));
      catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    }
    const worker = new MemoryV3MaintenanceWorker({
      atomStore,
      catalog,
      eventJournal,
      embeddingBatchSize: 1,
      yieldControl: async () => {
        yieldCount += 1;
        if (yieldCount !== 2) return;
        markBetweenPasses();
        await yieldGate;
      },
    });

    const drain = worker.startBackgroundDrain();
    await betweenPasses;
    const shutdown = worker.shutdown();
    releaseYield();
    await shutdown;
    await expect(drain).resolves.toMatchObject({ passes: 1, indexed: 1, aborted: true });
    expect(catalog.countEmbeddingWork()).toBe(2);
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
