import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableInboxError, DurableInboxStore } from './durable-inbox-store.js';
import { hashParts } from './durable-store-utils.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-inbox-'));
  roots.push(root);
  return root;
}

const input = {
  commandId: 'command-1',
  idempotencyKey: 'command-key-1',
  sessionId: 'session-a',
  runId: 'run-a',
  type: 'effect_intent_created' as const,
  source: 'runtime' as const,
  payload: { effectId: 'effect-1', toolName: 'write' },
};

describe('DurableInboxStore', () => {
  it('enqueues idempotently, claims with a lease, and completes once', async () => {
    const root = await newRoot();
    const store = new DurableInboxStore({ rootDir: root, leaseMs: 1_000 });
    await store.initialize();
    expect((await store.enqueue(input)).kind).toBe('enqueued');
    expect((await store.enqueue(input)).kind).toBe('duplicate');
    expect((await store.enqueue({ ...input, payload: { effectId: 'changed' } })).kind).toBe('conflict');
    const claimed = await store.claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('claimed');
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.claimToken).toBeTruthy();
    const completed = await store.complete('command-1', ['event-1'], claimed[0]?.claimToken);
    expect(completed.status).toBe('completed');
    expect((await store.complete('command-1', ['event-1'])).status).toBe('completed');
    await expect(store.complete('command-1', ['event-2'])).rejects.toBeInstanceOf(DurableInboxError);
    expect(await store.claim()).toEqual([]);
  });

  it('requeues an expired lease after restart and increments attempts', async () => {
    const root = await newRoot();
    let nowMs = Date.parse('2026-09-02T10:00:00.000Z');
    const now = () => new Date(nowMs);
    const first = new DurableInboxStore({ rootDir: root, leaseMs: 1_000, now });
    await first.enqueue(input);
    await first.claim();
    nowMs += 2_000;
    const restarted = new DurableInboxStore({ rootDir: root, leaseMs: 1_000, now });
    await restarted.initialize();
    const claimed = await restarted.claim();
    expect(claimed[0]).toMatchObject({ commandId: 'command-1', status: 'claimed', attempts: 2 });
  });

  it('reports the earliest active claim lease for a recovery wake-up', async () => {
    const root = await newRoot();
    let nowMs = Date.parse('2026-09-02T10:00:00.000Z');
    const now = () => new Date(nowMs);
    const store = new DurableInboxStore({ rootDir: root, leaseMs: 2_000, now });
    await store.enqueue(input);
    const [claimed] = await store.claim();

    await expect(store.listRecoverableRuns()).resolves.toEqual([]);
    await expect(store.listActiveClaimedRuns()).resolves.toEqual([{
      sessionId: 'session-a',
      runId: 'run-a',
    }]);
    await expect(store.nextClaimLeaseExpiry()).resolves.toBe('2026-09-02T10:00:02.000Z');
    nowMs += 500;
    await store.complete('command-1', ['event-1'], claimed?.claimToken);
    await expect(store.listActiveClaimedRuns()).resolves.toEqual([]);
    await expect(store.nextClaimLeaseExpiry()).resolves.toBeUndefined();
  });

  it('keeps permanent failures failed and permits explicit retryable requeue', async () => {
    const root = await newRoot();
    const store = new DurableInboxStore({ rootDir: root });
    await store.enqueue(input);
    const [claimed] = await store.claim();
    expect((await store.fail('command-1', 'permanent', false, claimed?.claimToken)).status).toBe('failed');
    expect(await store.claim()).toEqual([]);
    expect((await store.fail('command-1', 'retry now', true)).status).toBe('queued');
    expect((await store.claim())[0]?.status).toBe('claimed');
  });

  it('rejects a stale worker after an expired command is reclaimed', async () => {
    const root = await newRoot();
    let nowMs = Date.parse('2026-09-02T10:00:00.000Z');
    const now = () => new Date(nowMs);
    const firstWorker = new DurableInboxStore({ rootDir: root, leaseMs: 1_000, now });
    const secondWorker = new DurableInboxStore({ rootDir: root, leaseMs: 1_000, now });
    await firstWorker.enqueue(input);
    const [firstClaim] = await firstWorker.claim();
    nowMs += 2_000;
    const [secondClaim] = await secondWorker.claim();

    expect(secondClaim?.claimToken).toBeTruthy();
    expect(secondClaim?.claimToken).not.toBe(firstClaim?.claimToken);
    await expect(firstWorker.complete('command-1', ['event-stale'], firstClaim?.claimToken))
      .rejects.toMatchObject({ kind: 'state' });
    await expect(firstWorker.fail('command-1', 'stale failure', false, firstClaim?.claimToken))
      .rejects.toMatchObject({ kind: 'state' });
    await expect(secondWorker.complete('command-1', ['event-current'], secondClaim?.claimToken))
      .resolves.toMatchObject({ status: 'completed', resultEventIds: ['event-current'] });
  });

  it('claims only the requested durable run without draining another run', async () => {
    const root = await newRoot();
    const store = new DurableInboxStore({ rootDir: root });
    await store.enqueue(input);
    await store.enqueue({
      ...input,
      commandId: 'command-2',
      idempotencyKey: 'command-key-2',
      sessionId: 'session-b',
      runId: 'run-b',
      source: 'channel',
      type: 'user_input_appended',
      occurredAt: '2026-09-02T10:00:00.000Z',
    });

    await expect(store.listRecoverableRuns(1)).resolves.toEqual([{
      sessionId: 'session-a',
      runId: 'run-a',
    }]);
    await expect(store.listRecoverableRuns(0)).rejects.toThrow('between 1 and 1024');

    const claimed = await store.claim(1, { sessionId: 'session-b', runId: 'run-b' });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      commandId: 'command-2',
      source: 'channel',
      occurredAt: '2026-09-02T10:00:00.000Z',
    });
    expect((await store.read('command-1'))?.status).toBe('queued');
  });

  it('fails closed on corrupt command files and never uses raw ids as filenames', async () => {
    const root = await newRoot();
    const store = new DurableInboxStore({ rootDir: root });
    await store.enqueue(input);
    const file = join(root, `${hashParts('command-1')}.json`);
    await writeFile(file, JSON.stringify({ version: 99 }), 'utf8');
    await expect(store.initialize()).rejects.toBeInstanceOf(DurableInboxError);
    expect((await readdir(root)).some((name) => name.includes('command-1'))).toBe(false);
  });

  it('ignores an in-flight atomic temp file without accepting unknown files', async () => {
    const root = await newRoot();
    const store = new DurableInboxStore({ rootDir: root });
    await store.enqueue(input);
    await writeFile(
      join(root, `${hashParts('command-1')}.json.4242.0f0e0d0c-0b0a-4908-8706-050403020100.tmp`),
      'partial',
      'utf8',
    );
    await expect(store.initialize()).resolves.toBeUndefined();
    await writeFile(join(root, 'stranger.txt'), 'x', 'utf8');
    const reopened = new DurableInboxStore({ rootDir: root });
    await expect(reopened.initialize()).rejects.toBeInstanceOf(DurableInboxError);
  });

  it('rejects invalid completion and lease bounds', async () => {
    const root = await newRoot();
    expect(() => new DurableInboxStore({ rootDir: root, leaseMs: 10 })).toThrow();
    const store = new DurableInboxStore({ rootDir: root });
    await expect(store.complete('missing', [])).rejects.toMatchObject({ kind: 'missing' });
    await store.enqueue(input);
    await expect(store.complete('command-1', [])).rejects.toMatchObject({ kind: 'state' });
  });
});
