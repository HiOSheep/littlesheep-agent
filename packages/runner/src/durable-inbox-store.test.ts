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
    const completed = await store.complete('command-1', ['event-1']);
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

  it('keeps permanent failures failed and permits explicit retryable requeue', async () => {
    const root = await newRoot();
    const store = new DurableInboxStore({ rootDir: root });
    await store.enqueue(input);
    await store.claim();
    expect((await store.fail('command-1', 'permanent', false)).status).toBe('failed');
    expect(await store.claim()).toEqual([]);
    expect((await store.fail('command-1', 'retry now', true)).status).toBe('queued');
    expect((await store.claim())[0]?.status).toBe('claimed');
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

  it('rejects invalid completion and lease bounds', async () => {
    const root = await newRoot();
    expect(() => new DurableInboxStore({ rootDir: root, leaseMs: 10 })).toThrow();
    const store = new DurableInboxStore({ rootDir: root });
    await expect(store.complete('missing', [])).rejects.toMatchObject({ kind: 'missing' });
    await store.enqueue(input);
    await expect(store.complete('command-1', [])).rejects.toMatchObject({ kind: 'state' });
  });
});
