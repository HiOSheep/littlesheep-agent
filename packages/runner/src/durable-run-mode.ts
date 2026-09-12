// Reads the Harness mode a durable run actually used.
//
// Later rollout changes must never reinterpret an old run, so the mode is read
// from durable facts first. Runs that predate the recorded field are treated as
// `next` whenever durable facts exist, which keeps their reply behind the
// authoritative settlement boundary instead of today's configuration.
import type { DurableEventStore } from './durable-event-store.js';

export async function readDurableHarnessMode(
  store: Pick<DurableEventStore, 'read'>,
  sessionId: string,
  runId: string,
): Promise<'shadow' | 'next' | undefined> {
  const events = await store.read(sessionId, runId);
  const mode = events.find((event) => event.type === 'run_accepted')?.payload.durableHarnessMode;
  if (mode === 'shadow' || mode === 'next') return mode;
  return events.length > 0 ? 'next' : undefined;
}