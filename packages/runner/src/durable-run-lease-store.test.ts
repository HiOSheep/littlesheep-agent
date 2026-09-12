import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableRunLeaseStore } from './durable-run-lease-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-run-lease-'));
  roots.push(root);
  return root;
}

describe('DurableRunLeaseStore', () => {
  it('fences active owners, renews, releases and permits a later run identity reuse', async () => {
    const rootDir = await newRoot();
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const first = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now });
    const second = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now });
    const acquired = await first.acquire('session-a', 'run-a');
    expect(acquired.kind).toBe('acquired');
    expect(await second.acquire('session-a', 'run-a')).toMatchObject({ kind: 'conflict' });

    nowMs += 500;
    const renewed = await first.renew('session-a', 'run-a', acquired.lease.ownerToken!);
    expect(renewed.leaseUntil).toBe('2026-09-10T00:00:01.500Z');
    const released = await first.release('session-a', 'run-a', acquired.lease.ownerToken!);
    expect(released).toMatchObject({ status: 'released', attempts: 1 });
    expect(await second.acquire('session-a', 'run-a')).toMatchObject({
      kind: 'reclaimed',
      lease: { status: 'active', attempts: 2 },
    });
  });

  it('rejects a stale owner after lease expiry and takeover', async () => {
    const rootDir = await newRoot();
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const first = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now });
    const second = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now });
    const acquired = await first.acquire('session-a', 'run-a');
    nowMs += 1_001;
    await expect(first.renew('session-a', 'run-a', acquired.lease.ownerToken!))
      .rejects.toMatchObject({ kind: 'expired' });
    const reclaimed = await second.acquire('session-a', 'run-a');
    expect(reclaimed).toMatchObject({ kind: 'reclaimed', lease: { attempts: 2 } });
    await expect(first.release('session-a', 'run-a', acquired.lease.ownerToken!))
      .rejects.toMatchObject({ kind: 'conflict' });
  });

  it('separates live owners from expired recoverable runs and reports one wake-up', async () => {
    const rootDir = await newRoot();
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const store = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now });
    await store.acquire('session-a', 'run-a');
    await expect(store.listActiveRuns()).resolves.toEqual([{ sessionId: 'session-a', runId: 'run-a' }]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([]);
    await expect(store.nextLeaseExpiry()).resolves.toBe('2026-09-10T00:00:01.000Z');

    nowMs += 1_001;
    await expect(store.listActiveRuns()).resolves.toEqual([]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([{ sessionId: 'session-a', runId: 'run-a' }]);
    await expect(store.nextLeaseExpiry()).resolves.toBeUndefined();
  });

  it('fails closed on malformed lease storage', async () => {
    const rootDir = await newRoot();
    await writeFile(join(rootDir, 'unexpected.tmp'), '{}', 'utf8');
    const store = new DurableRunLeaseStore({ rootDir });
    await expect(store.initialize()).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('ignores an in-flight atomic temp file while still rejecting unknown names', async () => {
    const rootDir = await newRoot();
    const store = new DurableRunLeaseStore({ rootDir });
    const acquired = await store.acquire('session-a', 'run-a');
    expect(acquired.kind).toBe('acquired');
    await writeFile(
      join(rootDir, 'a'.repeat(64) + '.json.4242.0f0e0d0c-0b0a-4908-8706-050403020100.tmp'),
      'partial',
      'utf8',
    );
    await expect(store.initialize()).resolves.toBeUndefined();
    await expect(store.listActiveRuns()).resolves.toEqual([{ sessionId: 'session-a', runId: 'run-a' }]);
  });
});
