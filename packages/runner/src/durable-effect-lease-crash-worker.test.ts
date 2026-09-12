// Child-process fixture proving a live effect lease is renewed until the
// owning OS process is terminated without graceful cleanup.
import { expect, it } from 'vitest';
import { DurableEffectLeaseCoordinator } from './durable-effect-lease-coordinator.js';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';

const crashRoot = process.env.LS_DURABLE_EFFECT_LEASE_CRASH_ROOT;
const identity = { sessionId: 'session-killed', runId: 'run-killed', effectId: 'effect-killed' };

it('renews an effect lease until its parent kills the process', async () => {
  if (!crashRoot) {
    expect(crashRoot).toBeUndefined();
    return;
  }
  const store = new DurableEffectLeaseStore({ rootDir: crashRoot, leaseMs: 1_000 });
  await store.initialize();
  const coordinator = new DurableEffectLeaseCoordinator({
    store,
    sessionId: identity.sessionId,
    runId: identity.runId,
    onOwnershipLost: (error) => { throw error; },
  });
  await coordinator.acquire(identity.effectId);
  const initial = await store.read(identity);
  while (true) {
    await delay(100);
    const current = await store.read(identity);
    if (current?.leaseUntil !== initial?.leaseUntil) break;
  }
  process.stdout.write('LS_DURABLE_EFFECT_LEASE_RENEWED\n');
  await new Promise<never>(() => undefined);
}, 30_000);

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
