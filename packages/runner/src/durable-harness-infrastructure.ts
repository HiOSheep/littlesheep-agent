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
): Promise<DurableHarnessInfrastructure> {
  const infrastructure: DurableHarnessInfrastructure = {
    durableEventStore: new DurableEventStore({ rootDir: join(rootDir, 'durable-events') }),
    durableInboxStore: new DurableInboxStore({ rootDir: join(rootDir, 'durable-inbox') }),
    durableRunLeaseStore: new DurableRunLeaseStore({ rootDir: join(rootDir, 'durable-run-leases') }),
    durableEffectLeaseStore: new DurableEffectLeaseStore({ rootDir: join(rootDir, 'durable-effect-leases') }),
  };
  try {
    await infrastructure.durableEventStore.initialize();
    await infrastructure.durableInboxStore.initialize();
    await infrastructure.durableRunLeaseStore.initialize();
    await infrastructure.durableEffectLeaseStore.initialize();
  } catch (error) {
    // Legacy Harness remains usable; next-mode admission reads this failure
    // and closes before any semantic model or tool work begins.
    infrastructure.durableHarnessInitializationError = error instanceof Error ? error : new Error(String(error));
    log?.('warn', `runner: durable Harness stores unavailable: ${infrastructure.durableHarnessInitializationError.message}`);
  }
  return infrastructure;
}
