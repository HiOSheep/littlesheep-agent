import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';
import { DurableRunLeaseStore } from './durable-run-lease-store.js';
import { DurableRunOwnership } from './durable-run-ownership.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableRunOwnership', () => {
  it('releases effect ownership before releasing the run owner', async () => {
    const stores = await newStores();
    const ownership = await DurableRunOwnership.acquire({
      ...stores,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: vi.fn(),
    });
    await ownership.effectLeases.acquire('effect-a');
    await ownership.effectLeases.confirm('effect-a');
    await ownership.release();

    await expect(stores.effectStore.read({ sessionId: 'session-a', runId: 'run-a', effectId: 'effect-a' }))
      .resolves.toMatchObject({ status: 'released' });
    await expect(stores.runStore.read('session-a', 'run-a')).resolves.toMatchObject({ status: 'released' });
  });

  it('still releases the run owner when effect cleanup reports an error', async () => {
    const stores = await newStores();
    const ownership = await DurableRunOwnership.acquire({
      ...stores,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: vi.fn(),
    });
    await ownership.effectLeases.acquire('effect-a');
    vi.spyOn(stores.effectStore, 'release').mockRejectedValue(new Error('effect store unavailable'));

    await expect(ownership.release()).rejects.toThrow('effect store unavailable');
    await expect(stores.runStore.read('session-a', 'run-a')).resolves.toMatchObject({ status: 'released' });
  });

  it('blocks a stale Run owner from acquiring a new effect after another Runner takes over', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-durable-run-ownership-fence-'));
    roots.push(root);
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const runStore = new DurableRunLeaseStore({ rootDir: join(root, 'runs'), leaseMs: 1_000, now });
    const effectStore = new DurableEffectLeaseStore({ rootDir: join(root, 'effects'), leaseMs: 1_000, now });
    const lost = vi.fn();
    const stale = await DurableRunOwnership.acquire({
      runStore,
      effectStore,
      sessionId: 'session-a',
      runId: 'run-a',
      onOwnershipLost: lost,
    });

    nowMs += 1_001;
    const replacement = await runStore.acquire('session-a', 'run-a');
    expect(replacement.kind).toBe('reclaimed');
    await expect(stale.effectLeases.acquire('effect-after-takeover')).rejects.toThrow(/ownership changed/u);
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(effectStore.read({
      sessionId: 'session-a', runId: 'run-a', effectId: 'effect-after-takeover',
    })).resolves.toBeNull();
    await stale.release().catch(() => undefined);
  });
});

async function newStores(): Promise<{ runStore: DurableRunLeaseStore; effectStore: DurableEffectLeaseStore }> {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-run-ownership-'));
  roots.push(root);
  return {
    runStore: new DurableRunLeaseStore({ rootDir: join(root, 'runs'), leaseMs: 1_000 }),
    effectStore: new DurableEffectLeaseStore({ rootDir: join(root, 'effects'), leaseMs: 1_000 }),
  };
}
