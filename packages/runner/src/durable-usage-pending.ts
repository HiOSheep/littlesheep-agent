// Crash-safe incremental usage intents, independent of the authoritative log.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '@littlesheep/session';
import type { DurableHarnessEvent } from '@littlesheep/types';
import type { DurableRunPartitionRevision } from './durable-event-store.js';
import { hashParts, writeJsonAtomically } from './durable-store-utils.js';

export class DurableUsagePending {
  private readonly changed = new Set<string>();
  constructor(
    private readonly rootDir: string,
    private readonly writes: Map<string, Promise<void>>,
    private readonly revision: (partition: string) => Promise<DurableRunPartitionRevision | null>,
  ) {}

  async list(): Promise<string[]> {
    const files = await readdir(this.rootDir);
    const pending = files.flatMap(name => /^usage-pending-([a-f0-9]{64})\.json$/.exec(name)?.[1] ?? []);
    return [...new Set([...this.changed, ...pending])];
  }

  async mark(event: DurableHarnessEvent): Promise<void> {
    if (!['model_request_started', 'provider_usage_recorded', 'model_response_received', 'model_request_settled'].includes(event.type)) return;
    const key = hashParts(event.sessionId, event.runId);
    // Intent precedes the event commit, so a crash cannot hide a new receipt.
    await writeJsonAtomically(join(this.rootDir, `usage-pending-${key}.json`), { version: 1 });
    this.changed.add(key);
  }

  async acknowledge(key: string, revision: string): Promise<void> {
    const partition = join(this.rootDir, key);
    const previous = this.writes.get(partition) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const lock = await acquireLock(join(partition, '.events'), 60_000);
      try {
        if ((await this.revision(key))?.revision !== revision) return;
        await rm(join(this.rootDir, `usage-pending-${key}.json`), { force: true });
        this.changed.delete(key);
      } finally { await lock.release(); }
    });
    this.writes.set(partition, operation.then(() => undefined, () => undefined));
    await operation;
  }
}
