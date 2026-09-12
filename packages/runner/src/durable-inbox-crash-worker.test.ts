// Child-process fixture for the durable inbox kill/recovery test. In the
// ordinary suite it is a no-op; the parent test opts into the crash boundary.
import { expect, it } from 'vitest';
import { DurableInboxStore } from './durable-inbox-store.js';

const crashRoot = process.env.LS_DURABLE_INBOX_CRASH_ROOT;

it('holds a claimed ingress command until its parent terminates the process', async () => {
  if (!crashRoot) {
    expect(crashRoot).toBeUndefined();
    return;
  }
  const store = new DurableInboxStore({ rootDir: crashRoot, leaseMs: 1_000 });
  await store.initialize();
  await store.enqueue({
    commandId: 'run-killed:run-accepted',
    idempotencyKey: 'run-killed:run-accepted',
    sessionId: 'session-killed',
    runId: 'run-killed',
    type: 'run_accepted',
    source: 'runtime',
    payload: { origin: 'child-process', model: 'test/model' },
  });
  const [claimed] = await store.claim(1, { commandId: 'run-killed:run-accepted' });
  expect(claimed?.status).toBe('claimed');
  process.stdout.write('LS_DURABLE_INBOX_CLAIMED\n');
  await new Promise<never>(() => undefined);
}, 30_000);
