import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableEffectLeaseCoordinator } from './durable-effect-lease-coordinator.js';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableEffectLeaseCoordinator', () => {
  it('renews active effects, exposes only a redacted owner, and releases settlement ownership', async () => {
    const rootDir = await newRoot();
    const store = new DurableEffectLeaseStore({ rootDir, leaseMs: 1_000 });
    const lost = vi.fn();
    const coordinator = new DurableEffectLeaseCoordinator({
      store,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: lost,
    });
    const claim = await coordinator.acquire('effect-a');
    expect(claim).toMatchObject({ kind: 'acquired', ownerId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const initial = await store.read({ sessionId: 'session-a', runId: 'run-a', effectId: 'effect-a' });
    expect(claim.kind === 'acquired' && claim.ownerId).not.toBe(initial?.ownerToken);

    await delay(700);
    const renewed = await store.read({ sessionId: 'session-a', runId: 'run-a', effectId: 'effect-a' });
    expect(Date.parse(renewed?.leaseUntil ?? '')).toBeGreaterThan(Date.parse(initial?.leaseUntil ?? ''));
    expect(lost).not.toHaveBeenCalled();
    await coordinator.release('effect-a');
    await expect(store.read({ sessionId: 'session-a', runId: 'run-a', effectId: 'effect-a' }))
      .resolves.toMatchObject({ status: 'released' });
  });

  it('reports renewal ownership loss and stops managing the failed claim', async () => {
    const rootDir = await newRoot();
    const store = new DurableEffectLeaseStore({ rootDir, leaseMs: 1_000 });
    const lost = vi.fn();
    const coordinator = new DurableEffectLeaseCoordinator({
      store,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: lost,
    });
    await coordinator.acquire('effect-a');
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('effect ownership changed'));
    await delay(700);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ message: 'effect ownership changed' }));
    await coordinator.releaseAll();
  });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-effect-coordinator-'));
  roots.push(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
