import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    const first = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now, isOwnerProcessAlive: () => false });
    const second = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now, isOwnerProcessAlive: () => false });
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
    const first = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now, isOwnerProcessAlive: () => false });
    const second = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now, isOwnerProcessAlive: () => false });
    const acquired = await first.acquire('session-a', 'run-a');
    nowMs += 1_001;
    const reclaimed = await second.acquire('session-a', 'run-a');
    expect(reclaimed).toMatchObject({ kind: 'reclaimed', lease: { attempts: 2 } });
    await expect(first.renew('session-a', 'run-a', acquired.lease.ownerToken!))
      .rejects.toMatchObject({ kind: 'conflict' });
    await expect(first.release('session-a', 'run-a', acquired.lease.ownerToken!))
      .rejects.toMatchObject({ kind: 'conflict' });
  });

  it('allows only one of two concurrent Runner recovery claims', async () => {
    const rootDir = await newRoot();
    const first = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000 });
    const second = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000 });
    const outcomes = await Promise.all([
      first.acquire('session-a', 'run-a'),
      second.acquire('session-a', 'run-a'),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === 'acquired' || outcome.kind === 'reclaimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'conflict')).toHaveLength(1);
  });

  it('separates live owners from expired recoverable runs and reports one wake-up', async () => {
    const rootDir = await newRoot();
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const store = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now, isOwnerProcessAlive: () => false });
    await store.acquire('session-a', 'run-a');
    await expect(store.listActiveRuns()).resolves.toEqual([{ sessionId: 'session-a', runId: 'run-a' }]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([]);
    await expect(store.nextLeaseExpiry()).resolves.toBe('2026-09-10T00:00:01.000Z');

    nowMs += 1_001;
    await expect(store.listActiveRuns()).resolves.toEqual([]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([{ sessionId: 'session-a', runId: 'run-a' }]);
    await expect(store.nextLeaseExpiry()).resolves.toBeUndefined();
  });

  it('does not reclaim an expired lease while its owning process is still alive', async () => {
    const rootDir = await newRoot();
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const store = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000, now });
    const acquired = await store.acquire('session-live', 'run-live');
    nowMs += 1_001;
    await expect(store.acquire('session-live', 'run-live')).resolves.toMatchObject({ kind: 'conflict' });
    await expect(store.listActiveRuns()).resolves.toEqual([{ sessionId: 'session-live', runId: 'run-live' }]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([]);
    await expect(store.renew('session-live', 'run-live', acquired.lease.ownerToken!))
      .resolves.toMatchObject({ status: 'active', ownerProcessId: process.pid });
  });

  it('fails closed on an expired legacy lease without verifiable process ownership', async () => {
    const rootDir = await newRoot();
    const store = new DurableRunLeaseStore({ rootDir });
    await store.initialize();
    const acquired = await store.acquire('session-legacy', 'run-legacy');
    const names = await readdir(rootDir);
    const leaseFile = join(rootDir, names.find(name => name.endsWith('.json'))!);
    const existing = JSON.parse(await readFile(leaseFile, 'utf8')) as Record<string, unknown>;
    delete existing.ownerHost;
    delete existing.ownerProcessId;
    existing.leaseUntil = '2020-01-01T00:00:00.000Z';
    await writeFile(leaseFile, JSON.stringify(existing), 'utf8');
    expect(acquired.lease.ownerToken).toBeTruthy();
    await expect(store.acquire('session-legacy', 'run-legacy')).resolves.toMatchObject({ kind: 'conflict' });
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
