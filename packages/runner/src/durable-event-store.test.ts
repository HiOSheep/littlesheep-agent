import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableHarnessKernel } from '@littlesheep/harness';
import { DurableEventStore, DurableEventStoreError } from './durable-event-store.js';
import { hashParts } from './durable-store-utils.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function newRoot(): Promise<string> {
  const result = mkdtemp(join(tmpdir(), 'ls-durable-events-'));
  return result.then((root) => {
    roots.push(root);
    return root;
  });
}

const base = {
  sessionId: 'session-a',
  runId: 'run-a',
  type: 'user_input_appended' as const,
  source: 'app' as const,
  occurredAt: '2026-09-02T10:00:00.000Z',
  payload: { text: 'hello', count: 1 },
};

describe('DurableEventStore', () => {
  it('appends immutable events with contiguous cursors and cursor replay', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root });
    await store.initialize();
    const first = await store.append({ ...base, eventId: 'event-1', idempotencyKey: 'input-1' });
    const second = await store.append({
      ...base,
      eventId: 'event-2',
      idempotencyKey: 'input-2',
      type: 'route_decided',
      source: 'runtime',
      payload: { route: 'respond' },
    });
    expect(first.kind).toBe('appended');
    expect(second.kind).toBe('appended');
    if (first.kind !== 'appended' || second.kind !== 'appended') throw new Error('expected append');
    expect(first.event.cursor).toBe(1);
    expect(second.event.cursor).toBe(2);
    expect(await store.readAfter('session-a', 'run-a', 1)).toHaveLength(1);
    expect((await store.read('session-a', 'run-a')).map((event) => event.cursor)).toEqual([1, 2]);
  });

  it('deduplicates exact event/idempotency retries and rejects conflicts', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root });
    const input = { ...base, eventId: 'event-1', idempotencyKey: 'input-1' };
    expect((await store.append(input)).kind).toBe('appended');
    expect((await store.append(input)).kind).toBe('duplicate');
    const eventConflict = await store.append({ ...input, payload: { text: 'changed', count: 1 } });
    expect(eventConflict).toMatchObject({ kind: 'conflict', key: 'eventId' });
    const keyConflict = await store.append({ ...input, eventId: 'event-2', payload: { text: 'changed', count: 1 } });
    expect(keyConflict).toMatchObject({ kind: 'conflict', key: 'idempotencyKey' });
    expect((await store.read('session-a', 'run-a')).length).toBe(1);
  });

  it('serializes concurrent appends without duplicate cursors', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root });
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => store.append({
      ...base,
      eventId: `event-${index}`,
      idempotencyKey: `input-${index}`,
      payload: { index },
    })));
    expect(outcomes.every((outcome) => outcome.kind === 'appended')).toBe(true);
    expect((await store.read('session-a', 'run-a')).map((event) => event.cursor)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it('retries stale cursors across independent kernels without losing events', async () => {
    const root = await newRoot();
    const storeA = new DurableEventStore({ rootDir: root });
    const storeB = new DurableEventStore({ rootDir: root });
    await Promise.all([storeA.initialize(), storeB.initialize()]);
    const kernelA = new DurableHarnessKernel({ eventStore: storeA });
    const kernelB = new DurableHarnessKernel({ eventStore: storeB });

    await kernelA.append({
      sessionId: 'session-a',
      runId: 'run-a',
      eventId: 'accept',
      idempotencyKey: 'accept',
      type: 'run_accepted',
      source: 'runtime',
      payload: {},
    });

    const outcomes = await Promise.all([
      kernelA.append({
        sessionId: 'session-a',
        runId: 'run-a',
        eventId: 'input-a',
        idempotencyKey: 'input-a',
        type: 'user_input_appended',
        source: 'app',
        payload: { text: 'from-a' },
      }),
      kernelB.append({
        sessionId: 'session-a',
        runId: 'run-a',
        eventId: 'input-b',
        idempotencyKey: 'input-b',
        type: 'user_input_appended',
        source: 'app',
        payload: { text: 'from-b' },
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['appended', 'appended']);
    const reloaded = new DurableEventStore({ rootDir: root });
    const events = await reloaded.read('session-a', 'run-a');
    expect(events.map((event) => event.cursor)).toEqual([1, 2, 3]);
    expect(new Set(events.map((event) => event.eventId))).toEqual(new Set(['accept', 'input-a', 'input-b']));
    expect((await kernelB.append({
      sessionId: 'session-a',
      runId: 'run-a',
      eventId: 'input-b',
      idempotencyKey: 'input-b',
      type: 'user_input_appended',
      source: 'app',
      payload: { text: 'from-b' },
    })).kind).toBe('duplicate');
  });

  it('reloads from disk and does not expose raw session or payload in filenames', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root });
    await store.append({ ...base, eventId: 'event-1', idempotencyKey: 'input-1', payload: { secret: 'do-not-name' } });
    const reloaded = new DurableEventStore({ rootDir: root });
    await reloaded.initialize();
    expect(await reloaded.read('session-a', 'run-a')).toHaveLength(1);
    const partition = join(root, hashParts('session-a', 'run-a'));
    const names = await readdir(partition);
    expect(names.some((name) => name.includes('session-a') || name.includes('do-not-name'))).toBe(false);
  });

  it('enumerates durable runs for startup recovery without exposing payloads', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root });
    await store.append({ ...base, eventId: 'event-b', idempotencyKey: 'input-b', sessionId: 'session-b', runId: 'run-b' });
    await store.append({ ...base, eventId: 'event-a', idempotencyKey: 'input-a', sessionId: 'session-a', runId: 'run-a' });
    const reloaded = new DurableEventStore({ rootDir: root });
    await expect(reloaded.listRuns()).resolves.toEqual([
      { sessionId: 'session-a', runId: 'run-a' },
      { sessionId: 'session-b', runId: 'run-b' },
    ]);
  });

  it('fails closed on unknown versions, invalid files, and gaps', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root });
    await store.append({ ...base, eventId: 'event-1', idempotencyKey: 'input-1' });
    const partition = join(root, hashParts('session-a', 'run-a'));
    const file = (await readdir(partition)).find((name) => name.endsWith('.json'));
    if (!file) throw new Error('missing event file');
    const parsed = JSON.parse(await readFile(join(partition, file), 'utf8')) as Record<string, unknown>;
    await writeFile(join(partition, file), JSON.stringify({ ...parsed, version: 99 }), 'utf8');
    await expect(store.read('session-a', 'run-a')).rejects.toBeInstanceOf(DurableEventStoreError);

    await writeFile(join(partition, 'invalid.json'), '{}', 'utf8');
    await expect(new DurableEventStore({ rootDir: root }).initialize()).rejects.toBeInstanceOf(DurableEventStoreError);
  });

  it('enforces bounded payloads and event history', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: root, maxPayloadBytes: 1_024, maxEventsPerRun: 1 });
    await expect(store.append({ ...base, eventId: 'event-oversize', idempotencyKey: 'oversize', payload: { text: 'x'.repeat(2_000) } })).rejects.toThrow(/payload exceeds/);
    await store.append({ ...base, eventId: 'event-1', idempotencyKey: 'input-1' });
    await expect(store.append({ ...base, eventId: 'event-2', idempotencyKey: 'input-2', payload: { count: 2 } })).rejects.toThrow(/exceeds 1 events/);
  });
});
