// Construction boundary for stores owned by the durable Harness path.
import { join } from 'node:path';
import { DurableEventStore } from './durable-event-store.js';
import { DurableInboxStore } from './durable-inbox-store.js';
import { DurableRunLeaseStore } from './durable-run-lease-store.js';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';

export interface DurableHarnessInfrastructure {
  durableEventStore: DurableEventStore;
  durableInboxStore: DurableInboxStore;
  durableRunLeaseStore: DurableRunLeaseStore;
  durableEffectLeaseStore: DurableEffectLeaseStore;
  durableHarnessInitializationError?: Error;
}

export async function buildDurableHarnessInfrastructure(
  rootDir: string,
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void,
  mark?: (stage: string, durationMs?: number) => void,
): Promise<DurableHarnessInfrastructure> {
  const infrastructure: DurableHarnessInfrastructure = {
    durableEventStore: new DurableEventStore({ rootDir: join(rootDir, 'durable-events') }),
    durableInboxStore: new DurableInboxStore({ rootDir: join(rootDir, 'durable-inbox') }),
    durableRunLeaseStore: new DurableRunLeaseStore({ rootDir: join(rootDir, 'durable-run-leases') }),
    durableEffectLeaseStore: new DurableEffectLeaseStore({ rootDir: join(rootDir, 'durable-effect-leases') }),
  };
  /**
   * Each store owns its own directory and takes its own lock file *inside* that
   * directory, so the four startup scans share nothing but the parent directory:
   * they are independent work, and running them in sequence only adds three
   * avoidable waits to the cold-start path.
   *
   * Paired measurement (`normal` profile, 8-10 runs per variant, `--no-send`):
   * the phase takes 36-40 ms in sequence and 10-13 ms overlapped, and the Runner
   * build (`execution-start` → `runner-ready`) drops from 114-116 ms to
   * 99-101 ms. Part of the saving is absorbed by the next stage — bootstrap file
   * registration reads 28-34 ms in sequence and 44-45 ms here — so the net build
   * gain is about 14 ms. Renderer-side moments (input usable, session readable)
   * stayed inside their run-to-run spread, so this is a stage-level gain and is
   * not claimed as a measured first-executable improvement.
   *
   * Failure semantics stay the same as the sequential version for callers: the
   * first failure in declaration order is the one reported and recorded, and
   * `durableHarnessInitializationError` still closes next-mode admission before
   * any model or tool work. The only difference is that a later store may have
   * finished its own scan (and expired-claim requeue) before the failure is
   * raised; that write is bounded, idempotent, and confined to its own
   * directory, and the run cannot proceed on the failed store either way.
   */
  const stores: Array<{ stage: string; initialize: () => Promise<void> }> = [
    { stage: 'runner-infra-durable-events-ready', initialize: () => infrastructure.durableEventStore.initialize() },
    { stage: 'runner-infra-durable-inbox-ready', initialize: () => infrastructure.durableInboxStore.initialize() },
    { stage: 'runner-infra-durable-run-leases-ready', initialize: () => infrastructure.durableRunLeaseStore.initialize() },
    { stage: 'runner-infra-durable-effect-leases-ready', initialize: () => infrastructure.durableEffectLeaseStore.initialize() },
  ];
  try {
    const settled = await Promise.allSettled(stores.map(async (store) => {
      // The mark carries this store's own elapsed time because the stores now
      // overlap; the caller's shared timer would only measure completions.
      const startedAt = performance.now();
      try {
        await store.initialize();
      } finally {
        mark?.(store.stage, performance.now() - startedAt);
      }
    }));
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } catch (error) {
    // Legacy Harness remains usable; next-mode admission reads this failure
    // and closes before any semantic model or tool work begins.
    infrastructure.durableHarnessInitializationError = error instanceof Error ? error : new Error(String(error));
    log?.('warn', `runner: durable Harness stores unavailable: ${infrastructure.durableHarnessInitializationError.message}`);
  }
  return infrastructure;
}
