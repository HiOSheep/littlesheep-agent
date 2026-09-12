// Child-process fixture for the durable event store concurrency test. In the
// ordinary suite it is a no-op; the parent opts into the shared partition.
import { expect, it } from 'vitest';
import { DurableEventStore } from './durable-event-store.js';

const crashRoot = process.env.LS_DURABLE_EVENT_CRASH_ROOT;
const prefix = process.env.LS_DURABLE_EVENT_CRASH_PREFIX;

it('appends a concurrent batch into one shared durable run partition', async () => {
  if (!crashRoot || !prefix) {
    expect(crashRoot).toBeUndefined();
    return;
  }
  const store = new DurableEventStore({ rootDir: crashRoot });
  await store.initialize();
  for (let index = 0; index < 25; index += 1) {
    const eventId = `${prefix}-e${index}`;
    await store.append({
      eventId,
      idempotencyKey: eventId,
      sessionId: 'session-concurrent',
      runId: 'run-concurrent',
      type: 'stage_transition_recorded',
      source: 'runtime',
      payload: { prefix, index, stage: 'execute', next: 'verify', ok: true, attempt: index, transitionEventId: eventId },
    });
  }
  process.stdout.write(`LS_DURABLE_EVENT_APPENDED:${prefix}\n`);
}, 60_000);
