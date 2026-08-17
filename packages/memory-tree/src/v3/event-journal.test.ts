import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventJournal, MemoryOperationJournal } from './event-journal.js';
import type { MemoryUpdateEvent } from './contracts.js';

describe('Memory v3 event and operation journals', () => {
  let dataDir: string;
  let tick: number;
  let now: () => Date;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-journal-'));
    tick = Date.parse('2026-07-15T04:00:00.000Z');
    now = () => new Date(tick += 1_000);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('captures before processing, deduplicates, and recovers outstanding events after restart', async () => {
    const journal = new MemoryEventJournal({ dataDir, now });
    await journal.initialize();
    const event = makeEvent('event-1', 'user:correction:1');
    const captured = await journal.capture(event);
    const duplicate = await journal.capture({ ...event, id: 'different-id' });
    const recovery = await journal.markRecovery(event.id, 'temporary failure', 'operation-1');

    expect(captured.state).toBe('pending');
    expect(duplicate.event.id).toBe(event.id);
    expect(recovery.attempts).toBe(1);

    const restarted = new MemoryEventJournal({ dataDir, now });
    await restarted.initialize();
    expect((await restarted.listOutstanding()).map((record) => record.event.id)).toEqual([event.id]);
    const committed = await restarted.markCommitted(event.id, 'operation-1');
    expect(committed.state).toBe('committed');
    expect(await restarted.listOutstanding()).toEqual([]);
  });

  it('persists operation preconditions and recovery state', async () => {
    const journal = new MemoryOperationJournal({ dataDir, now });
    await journal.initialize();
    const started = await journal.start({
      id: 'operation-1',
      idempotencyKey: 'event-1:revision-1',
      kind: 'update',
      atomIds: ['atom-root'],
      eventIds: ['event-1'],
      expectedRevisions: { 'atom-root': 1 },
    });
    await journal.markRecovery(started.id, 'catalog unavailable');

    const restarted = new MemoryOperationJournal({ dataDir, now });
    await restarted.initialize();
    const outstanding = await restarted.listOutstanding();
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.expectedRevisions).toEqual({ 'atom-root': 1 });
    expect(outstanding[0]?.attempts).toBe(1);
    expect((await restarted.markCommitted(started.id)).state).toBe('committed');
  });

  it('bounds retained committed events without deleting pending recovery work', async () => {
    const journal = new MemoryEventJournal({ dataDir, now, maxCommittedRecords: 2, maxTotalRecords: 10 });
    await journal.initialize();
    for (let index = 0; index < 4; index += 1) {
      const event = makeEvent(`event-${index}`, `key-${index}`);
      await journal.capture(event);
      if (index < 3) await journal.markCommitted(event.id);
    }
    expect(await journal.count()).toBe(3);
    expect((await journal.listOutstanding()).map((record) => record.event.id)).toEqual(['event-3']);
  });

  it('rejects an oversized event before it can occupy the in-memory journal index', async () => {
    const journal = new MemoryEventJournal({ dataDir, now, maxRecordBytes: 1_000 });
    await journal.initialize();
    await expect(journal.capture({
      ...makeEvent('event-large', 'key-large'),
      payload: { body: 'x'.repeat(2_000) },
    })).rejects.toThrow(/byte safety limit/i);
    expect(await journal.count()).toBe(0);
  });

  it('isolates corrupt and oversized persisted events without indexing either record', async () => {
    const journal = new MemoryEventJournal({ dataDir, now, maxRecordBytes: 128 });
    const shard = join(journal.rootDir, '00');
    await mkdir(shard, { recursive: true });
    await Promise.all([
      writeFile(join(shard, 'broken.event.json'), '{broken', 'utf8'),
      writeFile(join(shard, 'oversized.event.json'), JSON.stringify({ body: 'x'.repeat(256) }), 'utf8'),
    ]);

    await journal.initialize();

    expect(await journal.count()).toBe(0);
    const quarantineDir = join(dataDir, 'memory-tree', 'v3', 'quarantine', 'events');
    const quarantined = await readdir(quarantineDir);
    expect(quarantined.filter((name) => name.endsWith('.reason.json'))).toHaveLength(2);
    expect(quarantined.filter((name) => !name.endsWith('.reason.json'))).toHaveLength(2);
  });
});

function makeEvent(id: string, idempotencyKey: string): MemoryUpdateEvent {
  return {
    version: 1,
    id,
    idempotencyKey,
    kind: 'user-correction',
    domain: 'project',
    scope: 'project',
    scopeKey: 'project-a',
    atomId: 'atom-root',
    expectedAtomRevision: 1,
    source: { kind: 'user', id: 'user' },
    occurredAt: '2026-07-15T04:00:00.000Z',
    observedAt: '2026-07-15T04:00:01.000Z',
    sourceRefs: ['conversation-source:run-1:user-message:user-1'],
    evidenceRefs: ['message:user-1'],
    payload: { correction: 'Use the local catalog.' },
  };
}
