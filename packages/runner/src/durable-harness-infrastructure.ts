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

/**
 * Marks for work this module moved off the Runner build.
 *
 * They are emitted straight to the `[bootstrap-timing]` stream instead of the
 * caller's `mark` callback: the callback is the sequential stage timer used to
 * attribute a *build*, and these entries finish after the build has returned.
 * They carry their own measured duration, like the four overlapping store marks.
 */
const timingEnabled = process.env['LITTLESHEEP_BOOTSTRAP_TIMING'] === '1';

function markDeferred(stage: string, durationMs: number): void {
  if (!timingEnabled) return;
  console.log(`[bootstrap-timing] ${JSON.stringify({
    stage,
    processUptimeMs: Math.round(process.uptime() * 1_000 * 10) / 10,
    durationMs: Math.round(durationMs * 10) / 10,
  })}`);
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
   * Failure semantics stay the same for the startup checks each store performs:
   * the first failure in declaration order is the one reported and recorded, and
   * `durableHarnessInitializationError` still closes next-mode admission before
   * any model or tool work. The only difference is that a later store may have
   * finished its own initialization (and expired-claim requeue) before the failure is
   * raised; that write is bounded, idempotent, and confined to its own
   * directory, and the run cannot proceed on the failed store either way.
   */
  const stores: Array<{ stage: string; initialize: () => Promise<void> }> = [
    { stage: 'runner-infra-durable-events-ready', initialize: () => infrastructure.durableEventStore.initialize() },
    { stage: 'runner-infra-durable-inbox-ready', initialize: () => infrastructure.durableInboxStore.initialize() },
    { stage: 'runner-infra-durable-run-leases-ready', initialize: () => infrastructure.durableRunLeaseStore.initialize() },
    { stage: 'runner-infra-durable-effect-leases-ready', initialize: () => infrastructure.durableEffectLeaseStore.initialize() },
  ];
  /**
   * The part of store initialization that answers "may this process admit a
   * new run" stays on this path; the part that only answers "what does history
   * hold" does not.
   *
   * Paired measurement on the large-root fixture: the inbox and the run-lease
   * store spent 210 ms and 198 ms parsing every historical record, against 10 ms
   * on a root with no history. A fresh run never reads those records - it
   * acquires its own lease by file name - so the two scans now do the work that
   * admission depends on (directory validation, active records, expired-claim
   * requeue) and the remaining records are read once, after the Runner is
   * published. See `DurableInboxStore.initialize` and
   * `DurableRunLeaseStore.initialize` for what each defers and why nothing that
   * still needs the records can observe them missing.
   *
   * `warmDeferredDurableStores` is that after-publish pass. It is deliberately
   * not awaited here: awaiting it would put the same cost back on the build.
   */
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
    warmDeferredDurableStores(infrastructure, log);
  } catch (error) {
    // Legacy Harness remains usable; next-mode admission reads this failure
    // and closes before any semantic model or tool work begins.
    infrastructure.durableHarnessInitializationError = error instanceof Error ? error : new Error(String(error));
    log?.('warn', `runner: durable Harness stores unavailable: ${infrastructure.durableHarnessInitializationError.message}`);
  }
  return infrastructure;
}

/**
 * Read the records the startup scans deferred, once, off the publish path.
 *
 * A failure is recorded the same way a startup scan failure is and leaves the
 * deferred set in place, so the next full read retries it and still fails closed
 * on the same file - nothing downstream ever sees a command set that silently
 * lost a record.
 */
export function warmDeferredDurableStores(
  infrastructure: DurableHarnessInfrastructure,
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void,
): void {
  const startedAt = performance.now();
  void infrastructure.durableInboxStore.warmDeferredCommands().then(
    () => markDeferred('runner-durable-inbox-deferred-read', performance.now() - startedAt),
    (error: unknown) => {
      markDeferred('runner-durable-inbox-deferred-read', performance.now() - startedAt);
      log?.('warn', `runner: durable inbox deferred read failed: ${(error as Error).message}`);
    },
  );
}
