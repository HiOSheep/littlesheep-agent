// Child-process fixture that proves a live run lease is renewed before the
// parent terminates the owning OS process.
import { expect, it } from 'vitest';
import { DurableRunLeaseHeartbeat } from './durable-run-lease-heartbeat.js';
import { DurableRunLeaseStore } from './durable-run-lease-store.js';

const crashRoot = process.env.LS_DURABLE_RUN_LEASE_CRASH_ROOT;

it('renews a run lease until its parent kills the process', async () => {
  if (!crashRoot) {
    expect(crashRoot).toBeUndefined();
    return;
  }
  const store = new DurableRunLeaseStore({ rootDir: crashRoot, leaseMs: 1_000 });
  await store.initialize();
  const heartbeat = await DurableRunLeaseHeartbeat.acquire({
    store,
    sessionId: 'session-killed',
    runId: 'run-killed',
    onOwnershipLost: (error) => { throw error; },
  });
  const initial = await store.read('session-killed', 'run-killed');
  while (true) {
    await delay(100);
    const current = await store.read('session-killed', 'run-killed');
    if (current?.updatedAt !== initial?.updatedAt) break;
  }
  expect(heartbeat.ownerToken).toBeTruthy();
  process.stdout.write('LS_DURABLE_RUN_LEASE_RENEWED\n');
  await new Promise<never>(() => undefined);
}, 30_000);

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
