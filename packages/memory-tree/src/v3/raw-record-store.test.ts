import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStorageMutation, MemoryUpdateEvent } from './contracts.js';
import { MemoryEventJournal } from './event-journal.js';
import { MemoryRawRecordCommitConflictError } from './raw-record-commit-store.js';
import {
  MemoryRawRecordConflictError,
  MemoryRawRecordStore,
} from './raw-record-store.js';
import { makeAtomInput } from './test-fixtures.js';

describe('MemoryRawRecordStore', () => {
  let dataDir: string;
  let tick: number;
  let now: () => Date;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-raw-records-'));
    tick = Date.parse('2026-07-15T04:00:00.000Z');
    now = () => new Date(tick += 1_000);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps the first record byte identity and rejects an altered recapture', async () => {
    const store = new MemoryRawRecordStore({ dataDir, now });
    await store.initialize();
    const event = makeEvent('event-raw-record');
    const mutation = createMutation('atom-raw-record');
    const first = await store.capture(event, mutation);
    const duplicate = await store.capture(structuredClone(event), structuredClone(mutation));

    expect(duplicate).toEqual(first);
    expect(await store.count()).toBe(1);
    await expect(store.capture(
      { ...event, payload: { statement: 'altered after capture' } },
      mutation,
    )).rejects.toBeInstanceOf(MemoryRawRecordConflictError);
    expect(await store.get(event.id)).toEqual(first);
  });

  it('retains all raw records when the bounded recovery journal prunes committed records', async () => {
    const store = new MemoryRawRecordStore({ dataDir, now });
    const journal = new MemoryEventJournal({ dataDir, now, maxCommittedRecords: 1, maxTotalRecords: 10 });
    await store.initialize();
    await journal.initialize();
    for (let index = 0; index < 3; index += 1) {
      const event = makeEvent(`event-${index}`);
      await store.capture(event, createMutation(`atom-${index}`));
      await journal.capture(event);
      await journal.markCommitted(event.id);
    }

    expect(await journal.count()).toBe(1);
    expect(await store.count()).toBe(3);
    const restarted = new MemoryRawRecordStore({ dataDir, now });
    expect(await restarted.initialize()).toEqual({ count: 3, quarantined: 0 });
    expect((await restarted.listForAtom('atom-0')).map((record) => record.id)).toEqual(['event-0']);
  });

  it('stores an append-only commit receipt without rewriting the raw record', async () => {
    const store = new MemoryRawRecordStore({ dataDir, now });
    await store.initialize();
    const event = makeEvent('event-commit-receipt');
    const record = await store.capture(event, createMutation('atom-commit-receipt'));
    const receipt = await store.markCommitted(event.id, 'operation:event-commit-receipt');

    expect(await store.markCommitted(event.id, 'operation:event-commit-receipt')).toEqual(receipt);
    await expect(store.markCommitted(event.id, 'operation:other'))
      .rejects.toBeInstanceOf(MemoryRawRecordCommitConflictError);
    expect((await store.get(event.id))?.contentHash).toBe(record.contentHash);

    const restarted = new MemoryRawRecordStore({ dataDir, now });
    await restarted.initialize();
    expect(await restarted.getCommitReceipt(event.id)).toEqual(receipt);
    expect((await restarted.get(event.id))?.contentHash).toBe(record.contentHash);
  });
});

function makeEvent(id: string): MemoryUpdateEvent {
  return {
    version: 1,
    id,
    idempotencyKey: `raw-record:${id}`,
    kind: 'user-statement',
    domain: 'project',
    scope: 'project',
    scopeKey: 'project-a',
    source: { kind: 'user', id: 'user' },
    occurredAt: '2026-07-15T04:00:00.000Z',
    observedAt: '2026-07-15T04:00:01.000Z',
    evidenceRefs: [`message:${id}`],
    payload: { statement: `Raw record ${id}` },
  };
}

function createMutation(atomId: string): MemoryStorageMutation {
  return { kind: 'create', atom: makeAtomInput({ id: atomId }) };
}
