import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryCatalog } from './catalog.js';
import type { MemoryUpdateEvent } from './contracts.js';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';
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
      'event-captured',
      'operation-started',
      'atom-written',
      'catalog-updated',
      'operation-committed',
      'event-committed',
    ]);
    expect(await runtime.eventJournal.listOutstanding()).toEqual([]);
    expect(await runtime.operationJournal.listOutstanding()).toEqual([]);
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

  function makeRuntime() {
    const catalog = new MemoryCatalog({ dataDir });
    catalogs.push(catalog);
    return {
      atomStore: new MemoryAtomStore({ dataDir, now }),
      catalog,
      eventJournal: new MemoryEventJournal({ dataDir, now }),
      operationJournal: new MemoryOperationJournal({ dataDir, now }),
    };
  }
});

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
    evidenceRefs: ['message:user-1'],
    payload: { statement: 'Use local memory.' },
  };
}
