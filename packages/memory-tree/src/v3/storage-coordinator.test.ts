import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import type { MemoryUpdateEvent } from './contracts.js';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';
import { MemoryRawRecordStore } from './raw-record-store.js';
import { MemoryV3StorageCoordinator } from './storage-coordinator.js';
import { makeAtomInput } from './test-fixtures.js';

describe('MemoryV3StorageCoordinator', () => {
  let dataDir: string;
  let tick: number;
  let now: () => Date;
  let catalogs: MemoryCatalog[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-coordinator-'));
    tick = Date.parse('2026-07-15T04:00:00.000Z');
    now = () => new Date(tick += 1_000);
    catalogs = [];
  });

  afterEach(async () => {
    for (const catalog of catalogs) catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists the event before mutation and commits both journals after catalog projection', async () => {
    const runtime = makeRuntime();
    const checkpoints: string[] = [];
    const coordinator = new MemoryV3StorageCoordinator({
      ...runtime,
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
    });
    await coordinator.initialize();
    const atom = await coordinator.apply(makeEvent('event-success'), { kind: 'create', atom: makeAtomInput() });

    expect(atom.revision).toBe(1);
    expect(runtime.catalog.getAtom(atom.id)?.contentHash).toBe(atom.contentHash);
    expect(checkpoints).toEqual([
      'raw-record-captured',
      'event-captured',
      'operation-started',
      'atom-written',
      'catalog-updated',
      'operation-committed',
      'raw-record-committed',
      'event-committed',
    ]);
    expect(await runtime.rawRecordStore.getCommitReceipt('event-success')).toMatchObject({
      rawRecordId: 'event-success',
      operationId: 'memory-operation:event-success',
      rawRecordContentHash: (await runtime.rawRecordStore.get('event-success'))?.contentHash,
    });
    expect(await runtime.eventJournal.listOutstanding()).toEqual([]);
    expect(await runtime.operationJournal.listOutstanding()).toEqual([]);
  });

  it('rebuilds a missing recovery event from a raw record after restart', async () => {
    let injected = false;
    const firstRuntime = makeRuntime();
    const first = new MemoryV3StorageCoordinator({
      ...firstRuntime,
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'raw-record-captured' && !injected) {
          injected = true;
          throw new Error('simulated crash after raw record capture');
        }
      },
    });
    await first.initialize();
    await expect(first.apply(makeEvent('event-raw-record-only'), { kind: 'create', atom: makeAtomInput() }))
      .rejects.toThrow(/raw record capture/i);
    expect(await firstRuntime.rawRecordStore.count()).toBe(1);
    expect(await firstRuntime.eventJournal.get('event-raw-record-only')).toBeUndefined();
    expect(await firstRuntime.atomStore.read('atom-root')).toBeUndefined();
    firstRuntime.catalog.close();
    catalogs = catalogs.filter((catalog) => catalog !== firstRuntime.catalog);

    const secondRuntime = makeRuntime();
    const recovery = await new MemoryV3StorageCoordinator(secondRuntime).initialize();
    expect(recovery.failed).toEqual([]);
    expect(recovery.recoveredEventIds).toEqual(['event-raw-record-only']);
    expect(await secondRuntime.atomStore.read('atom-root')).toBeDefined();
    expect(secondRuntime.catalog.getAtom('atom-root')).toBeDefined();
  });

  it('rebuilds a deleted catalog from evolved atoms without replaying pruned historical records', async () => {
    const firstRuntime = makeRuntime(1);
    const first = new MemoryV3StorageCoordinator(firstRuntime);
    await first.initialize();
    const created = await first.apply(makeEvent('event-catalog-create'), { kind: 'create', atom: makeAtomInput() });
    const updated = await first.apply(makeEvent('event-catalog-update'), {
      kind: 'update',
      atomId: created.id,
      expectedRevision: created.revision,
      patch: { summary: 'A later raw record changed this projection.' },
    });
    const archived = await first.apply(makeEvent('event-catalog-archive'), {
      kind: 'archive',
      atomId: updated.id,
      expectedRevision: updated.revision,
    });
    expect(await firstRuntime.eventJournal.count()).toBe(1);
    expect(await firstRuntime.rawRecordStore.count()).toBe(3);
    expect(archived).toMatchObject({ revision: 3, status: 'archived' });
    const catalogPath = firstRuntime.catalog.dbPath;
    firstRuntime.catalog.close();
    catalogs = catalogs.filter((catalog) => catalog !== firstRuntime.catalog);
    for (const path of [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`]) {
      await rm(path, { force: true });
    }

    const secondRuntime = makeRuntime(1);
    const recovery = await new MemoryV3StorageCoordinator(secondRuntime).initialize();
    expect(recovery.failed).toEqual([]);
    expect(recovery.rebuiltCatalog).toBe(true);
    expect(await secondRuntime.atomStore.read('atom-root')).toMatchObject({ revision: 3, status: 'archived' });
    expect(secondRuntime.catalog.getAtom('atom-root')).toMatchObject({ revision: 3, status: 'archived' });
    expect(await secondRuntime.rawRecordStore.getCommitReceipt('event-catalog-create')).toBeDefined();
    expect(await secondRuntime.rawRecordStore.getCommitReceipt('event-catalog-update')).toBeDefined();
  });

  it('replays an atom-written/catalog-missing failure idempotently after restart', async () => {
    let injected = false;
    const firstRuntime = makeRuntime();
    const first = new MemoryV3StorageCoordinator({
      ...firstRuntime,
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'atom-written' && !injected) {
          injected = true;
          throw new Error('simulated crash after atom write');
        }
      },
    });
    await first.initialize();
    await expect(first.apply(makeEvent('event-recovery'), { kind: 'create', atom: makeAtomInput() }))
      .rejects.toThrow(/simulated crash/i);
    expect(await firstRuntime.atomStore.read('atom-root')).toBeDefined();
    expect(firstRuntime.catalog.countAtoms()).toBe(0);
    firstRuntime.catalog.close();
    catalogs = catalogs.filter((catalog) => catalog !== firstRuntime.catalog);

    const secondRuntime = makeRuntime();
    const second = new MemoryV3StorageCoordinator(secondRuntime);
    const recovery = await second.initialize();

    expect(recovery.failed).toEqual([]);
    expect(recovery.recoveredEventIds).toEqual(['event-recovery']);
    expect(secondRuntime.catalog.countAtoms()).toBe(1);
    expect(await secondRuntime.eventJournal.listOutstanding()).toEqual([]);
    expect(await secondRuntime.operationJournal.listOutstanding()).toEqual([]);
  });

  it('recovers a captured event even when no operation record was created', async () => {
    let injected = false;
    const firstRuntime = makeRuntime();
    const first = new MemoryV3StorageCoordinator({
      ...firstRuntime,
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'event-captured' && !injected) {
          injected = true;
          throw new Error('simulated crash after event capture');
        }
      },
    });
    await first.initialize();
    await expect(first.apply(makeEvent('event-captured-only'), { kind: 'create', atom: makeAtomInput() }))
      .rejects.toThrow(/event capture/i);
    expect(await firstRuntime.atomStore.read('atom-root')).toBeUndefined();
    firstRuntime.catalog.close();
    catalogs = catalogs.filter((catalog) => catalog !== firstRuntime.catalog);

    const secondRuntime = makeRuntime();
    const second = new MemoryV3StorageCoordinator(secondRuntime);
    const recovery = await second.initialize();
    expect(recovery.recoveredEventIds).toEqual(['event-captured-only']);
    expect(await secondRuntime.atomStore.read('atom-root')).toBeDefined();
  });

  it('recovers a merge after the target write without duplicating either projection', async () => {
    let injected = false;
    const firstRuntime = makeRuntime();
    const first = new MemoryV3StorageCoordinator({
      ...firstRuntime,
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'merge-target-written' && !injected) {
          injected = true;
          throw new Error('simulated crash after merge target');
        }
      },
    });
    await first.initialize();
    await seedMergeAtoms(firstRuntime);
    await expect(first.apply(makeEvent('event-merge-recovery'), mergeMutation()))
      .rejects.toThrow(/merge target/iu);
    expect((await firstRuntime.atomStore.read('merge-target'))?.revision).toBe(2);
    expect((await firstRuntime.atomStore.read('merge-source'))?.revision).toBe(1);
    firstRuntime.catalog.close();
    catalogs = catalogs.filter((catalog) => catalog !== firstRuntime.catalog);

    const secondRuntime = makeRuntime();
    const second = new MemoryV3StorageCoordinator(secondRuntime);
    const recovery = await second.initialize();
    expect(recovery.failed).toEqual([]);
    expect(recovery.recoveredEventIds).toEqual(['event-merge-recovery']);
    expect(await secondRuntime.atomStore.read('merge-target')).toMatchObject({ revision: 2, mergedFromAtomIds: ['merge-source'] });
    expect(await secondRuntime.atomStore.read('merge-source')).toMatchObject({ revision: 2, status: 'tombstone' });
    expect(secondRuntime.catalog.getAtom('merge-target')?.revision).toBe(2);
    expect(secondRuntime.catalog.getAtom('merge-source')?.revision).toBe(2);
  });

  it('recovers merge catalog projection after both atom files were written', async () => {
    let injected = false;
    const firstRuntime = makeRuntime();
    const first = new MemoryV3StorageCoordinator({
      ...firstRuntime,
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'atom-written' && !injected) {
          injected = true;
          throw new Error('simulated crash before merge catalog projection');
        }
      },
    });
    await first.initialize();
    await seedMergeAtoms(firstRuntime);
    await expect(first.apply(makeEvent('event-merge-catalog'), mergeMutation()))
      .rejects.toThrow(/catalog projection/iu);
    expect((await firstRuntime.atomStore.read('merge-target'))?.revision).toBe(2);
    expect((await firstRuntime.atomStore.read('merge-source'))?.revision).toBe(2);
    expect(firstRuntime.catalog.getAtom('merge-target')?.revision).toBe(1);
    firstRuntime.catalog.close();
    catalogs = catalogs.filter((catalog) => catalog !== firstRuntime.catalog);

    const secondRuntime = makeRuntime();
    const recovery = await new MemoryV3StorageCoordinator(secondRuntime).initialize();
    expect(recovery.failed).toEqual([]);
    expect(secondRuntime.catalog.getAtom('merge-target')?.revision).toBe(2);
    expect(secondRuntime.catalog.getAtom('merge-source')).toMatchObject({ revision: 2, status: 'tombstone' });
  });

  it('checks both merge revisions before changing either atom', async () => {
    const runtime = makeRuntime();
    const coordinator = new MemoryV3StorageCoordinator(runtime);
    await coordinator.initialize();
    await seedMergeAtoms(runtime);
    const mutation = mergeMutation();
    mutation.sourceExpectedRevision = 0;
    await expect(coordinator.apply(makeEvent('event-merge-conflict'), mutation))
      .rejects.toThrow(/merge source/iu);
    expect((await runtime.atomStore.read('merge-target'))?.revision).toBe(1);
    expect((await runtime.atomStore.read('merge-source'))?.revision).toBe(1);
  });

  function makeRuntime(maxCommittedRecords?: number) {
    const catalog = new MemoryCatalog({ dataDir });
    catalogs.push(catalog);
    return {
      atomStore: new MemoryAtomStore({ dataDir, now }),
      catalog,
      eventJournal: new MemoryEventJournal({
        dataDir,
        now,
        ...(maxCommittedRecords === undefined ? {} : { maxCommittedRecords }),
      }),
      operationJournal: new MemoryOperationJournal({
        dataDir,
        now,
        ...(maxCommittedRecords === undefined ? {} : { maxCommittedRecords }),
      }),
      rawRecordStore: new MemoryRawRecordStore({ dataDir, now }),
    };
  }

  async function seedMergeAtoms(runtime: ReturnType<typeof makeRuntime>) {
    for (const atom of [
      await runtime.atomStore.create(makeAtomInput({ id: 'merge-target' })),
      await runtime.atomStore.create(makeAtomInput({ id: 'merge-source' })),
    ]) runtime.catalog.upsertAtom(atom, runtime.atomStore.relativePathFor(atom.id)!);
  }
});

function mergeMutation(): Extract<import('./contracts.js').MemoryStorageMutation, { kind: 'merge' }> {
  return {
    kind: 'merge',
    targetAtomId: 'merge-target',
    targetExpectedRevision: 1,
    targetPatch: { mergedFromAtomIds: ['merge-source'] },
    sourceAtomId: 'merge-source',
    sourceExpectedRevision: 1,
    sourcePatch: {
      status: 'tombstone',
      merge: { intoAtomId: 'merge-target', at: '2026-07-15T04:00:02.000Z', reason: 'duplicate projection' },
    },
  };
}

function makeEvent(id: string): MemoryUpdateEvent {
  return {
    version: 1,
    id,
    idempotencyKey: `key:${id}`,
    kind: 'user-statement',
    domain: 'project',
    scope: 'project',
    scopeKey: 'project-a',
    source: { kind: 'user', id: 'user' },
    occurredAt: '2026-07-15T04:00:00.000Z',
    observedAt: '2026-07-15T04:00:01.000Z',
    sourceRefs: ['conversation-source:run-1:user-message:user-1'],
    evidenceRefs: ['message:user-1'],
    payload: { statement: 'Use local memory.' },
  };
}
