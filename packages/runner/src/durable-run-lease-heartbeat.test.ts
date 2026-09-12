import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableRunLeaseHeartbeat } from './durable-run-lease-heartbeat.js';
import { DurableRunLeaseStore } from './durable-run-lease-store.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableRunLeaseHeartbeat', () => {
  it('renews a live run and releases its ownership', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-run-heartbeat-'));
    roots.push(rootDir);
    const store = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000 });
    const lost = vi.fn();
    const heartbeat = await DurableRunLeaseHeartbeat.acquire({
      store,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: lost,
    });
    const initial = await store.read('session-a', 'run-a');

    await delay(700);
    const renewed = await store.read('session-a', 'run-a');
    expect(renewed?.status).toBe('active');
    expect(Date.parse(renewed?.leaseUntil ?? '')).toBeGreaterThan(Date.parse(initial?.leaseUntil ?? ''));
    expect(lost).not.toHaveBeenCalled();
    await heartbeat.release();
    expect(await store.read('session-a', 'run-a')).toMatchObject({ status: 'released' });
  });

  it('reports renewal failure exactly once and stops scheduling work', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-run-heartbeat-'));
    roots.push(rootDir);
    const store = new DurableRunLeaseStore({ rootDir, leaseMs: 1_000 });
    const lost = vi.fn();
    const heartbeat = await DurableRunLeaseHeartbeat.acquire({
      store,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: lost,
    });
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('lease store unavailable'));

    await delay(700);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ message: 'lease store unavailable' }));
    heartbeat.abandon();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
