// Incremental updates and cancellable, resumable backfill for daily usage (O5).
//
// A pass never scans the whole history: it walks the store's partition listing
// with a budget, skips any partition whose event-log revision is unchanged, and
// remembers a cursor. That makes one bounded refresh, a long historical
// backfill and a resumed backfill the same operation, so cancelling a backfill
// can never lose or double count work: re-applying a run replaces its
// contribution instead of adding to it.
import type { DurableHarnessEvent, ProviderUsageDailySeries } from '@littlesheep/types';
import {
  PROVIDER_USAGE_DAILY_MAX_BACKFILL_STEP_BUDGET,
  PROVIDER_USAGE_DAILY_MAX_REFRESH_BUDGET,
} from '@littlesheep/types';
import type { DurableRunPartitionRevision } from './durable-event-store.js';
import { readProviderUsageRunFacts } from './provider-usage-daily-facts.js';
import {
  ProviderUsageDailyIndexStore,
  type ProviderUsageDailyBackfillRecord,
} from './provider-usage-daily-index.js';
import {
  buildProviderUsageDailyQuerySeries,
  type ProviderUsageDailyQueryInput,
} from './provider-usage-daily-query.js';

export type { ProviderUsageDailyQueryInput } from './provider-usage-daily-query.js';

export interface ProviderUsageEventSource {
  listRunPartitions(): Promise<string[]>;
  /** Pending new calls, including a prior process; never replays history. */
  listChangedRunPartitions?(): Promise<string[]>;
  acknowledgeUsagePartition?(partitionKey: string, revision: string): Promise<void>;
  readRunRevision(partitionKey: string): Promise<DurableRunPartitionRevision | null>;
  read(sessionId: string, runId: string): Promise<DurableHarnessEvent[]>;
}

export interface ProviderUsageDailyServiceOptions {
  /** Application data root; the projection lives in its own subdirectories. */
  readonly dataRoot: string;
  readonly eventSource: ProviderUsageEventSource;
  /** Delay between background backfill steps; tests drive steps directly. */
  readonly stepDelayMs?: number;
  readonly now?: () => Date;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ProviderUsageDailyPassResult extends ProviderUsageDailyBackfillRecord {
  readonly hasMore: boolean;
}

export class ProviderUsageDailyService {
  private readonly store: ProviderUsageDailyIndexStore;
  private readonly source: ProviderUsageEventSource;
  private readonly stepDelayMs: number;
  private readonly now: () => Date;
  private readonly log: ((level: 'info' | 'warn' | 'error', message: string) => void) | undefined;
  private cursor: string | undefined;
  private processed = 0;
  private indexed = 0;
  private failed = 0;
  private partitions = 0;
  private startedAt: string | undefined;
  private status: ProviderUsageDailyBackfillRecord['status'] = 'idle';
  private lastFailure: string | undefined;
  private loop: NodeJS.Timeout | undefined;
  /** Bumped by every cancel/start so a stale scheduled step stops itself. */
  private loopToken = 0;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.catch(() => undefined).then(operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Index pending new calls before serving a query, independently of backfill. */
  synchronizeCurrent(): Promise<void> {
    return this.serialize(async () => {
      await this.initialize();
      const partitions = await this.source.listChangedRunPartitions?.() ?? [];
      for (const partition of partitions) {
        await this.indexPartition(partition);
      }
      if (partitions.length > 0 && await this.persist()) {
        for (const partition of partitions) {
          const revision = this.store.revisionFor(partition);
          if (revision) await this.source.acknowledgeUsagePartition?.(partition, revision);
        }
      }
    });
  }

  constructor(options: ProviderUsageDailyServiceOptions) {
    this.store = new ProviderUsageDailyIndexStore(
      ProviderUsageDailyIndexStore.pathsFor(options.dataRoot),
    );
    this.source = options.eventSource;
    this.stepDelayMs = Math.max(0, options.stepDelayMs ?? 5);
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
  }

  get indexStore(): ProviderUsageDailyIndexStore {
    return this.store;
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce().catch(error => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    if (this.initialized) return;
    await this.store.load();
    const persisted = this.store.backfill;
    // A pass that was running when the process died is resumable, not running.
    this.status = persisted.status === 'running' ? 'cancelled' : persisted.status;
    this.cursor = this.status === 'partial' || this.status === 'cancelled' ? persisted.cursor : undefined;
    this.processed = 0;
    this.indexed = 0;
    this.failed = 0;
    this.partitions = persisted.partitions;
    this.initialized = true;
    this.store.setBackfill(this.record());
  }

  /**
   * One bounded pass over the partition listing. Unchanged partitions cost only
   * a directory listing, so this is cheap enough to run from a user refresh.
   */
  runPass(
    options: { readonly budget?: number; readonly restart?: boolean } = {},
  ): Promise<ProviderUsageDailyPassResult> {
    return this.serialize(() => this.runPassLocked(options));
  }

  private async runPassLocked(
    options: { readonly budget?: number; readonly restart?: boolean },
  ): Promise<ProviderUsageDailyPassResult> {
    await this.initialize();
    const budget = clampBudget(options.budget, PROVIDER_USAGE_DAILY_MAX_REFRESH_BUDGET);
    if (options.restart || (this.cursor === undefined && this.processed > 0)) this.resetPass();
    const partitions = await this.source.listRunPartitions();
    this.partitions = partitions.length;
    this.startedAt ??= this.now().toISOString();
    let index = this.cursor === undefined ? 0 : partitions.indexOf(this.cursor);
    if (index < 0) index = 0;
    let stepped = 0;
    let failure: string | undefined;
    while (stepped < budget && index < partitions.length) {
      const partitionKey = partitions[index]!;
      index += 1;
      stepped += 1;
      this.processed += 1;
      try {
        if (await this.indexPartition(partitionKey)) this.indexed += 1;
      } catch (error) {
        this.failed += 1;
        failure ??= `${partitionKey}: ${(error as Error).message}`;
      }
    }
    this.cursor = index < partitions.length ? partitions[index] : undefined;
    this.status = failure
      ? 'failed'
      : this.cursor === undefined ? 'complete' : 'partial';
    this.lastFailure = failure;
    const record = this.record();
    this.store.setBackfill(record);
    await this.persist();
    return { ...record, hasMore: this.cursor !== undefined };
  }

  /** Starts a background backfill that steps until the history is covered. */
  async startBackfill(
    options: { readonly budgetPerStep?: number } = {},
  ): Promise<ProviderUsageDailyPassResult> {
    const budget = clampBudget(options.budgetPerStep, PROVIDER_USAGE_DAILY_MAX_BACKFILL_STEP_BUDGET);
    const token = ++this.loopToken;
    if (this.loop) clearTimeout(this.loop);
    this.loop = undefined;
    const first = await this.serialize(async () => {
      await this.initialize();
      if (this.loopToken !== token || this.status === 'complete') {
        return { ...this.record(), hasMore: this.cursor !== undefined };
      }
      return this.runPassLocked({ budget, restart: this.cursor === undefined });
    });
    if (!first.hasMore || this.loopToken !== token) return first;
    await this.serialize(async () => {
      if (this.loopToken !== token) return;
      this.status = 'running';
      this.store.setBackfill(this.record());
      await this.persist();
    });
    const schedule = (): void => {
      this.loop = setTimeout(() => {
        this.loop = undefined;
        if (this.loopToken !== token) return;
        void this.serialize(() => this.loopToken !== token ? Promise.resolve(undefined) : this.runPassLocked({ budget }))
          .then((result) => {
            if (result?.hasMore && this.loopToken === token) schedule();
          })
          .catch((error: unknown) => {
            const message = (error as Error).message;
            this.log?.('warn', `provider usage backfill failed: ${message}`);
            this.status = 'failed';
            this.lastFailure = message;
            this.store.setBackfill(this.record());
            void this.persist();
          });
      }, this.stepDelayMs);
      this.loop.unref?.();
    };
    schedule();
    return { ...this.record(), hasMore: true };
  }

  /** Cancels a background backfill; the cursor stays for a later resume. */
  async cancelBackfill(): Promise<ProviderUsageDailyPassResult> {
    this.loopToken += 1;
    if (this.loop) {
      clearTimeout(this.loop);
      this.loop = undefined;
    }
    return this.serialize(async () => {
      await this.initialize();
      this.status = 'cancelled';
      const record = this.record();
      this.store.setBackfill(record);
      await this.persist();
      return { ...record, hasMore: this.cursor !== undefined };
    });
  }

  /** Explicit clear: attempts at or before the instant stop being counted. */
  async clearThrough(clearedThrough: string): Promise<void> {
    await this.serialize(async () => {
      await this.initialize();
      await this.store.recordClear(clearedThrough, this.now().toISOString());
    });
  }

  /** Current pass progress without starting any work. */
  async progress(): Promise<ProviderUsageDailyPassResult> {
    await this.initialize();
    return { ...this.record(), hasMore: this.cursor !== undefined };
  }

  /** Folds the persisted projection into a bounded series. No disk reads. */
  query(input: ProviderUsageDailyQueryInput): ProviderUsageDailySeries {
    return buildProviderUsageDailyQuerySeries(this.store, input, {
      backfill: this.record(),
      now: this.now(),
    });
  }

  private async indexPartition(partitionKey: string): Promise<boolean> {
    const revision = await this.source.readRunRevision(partitionKey);
    if (!revision) return false;
    if (this.store.revisionFor(partitionKey) === revision.revision) return false;
    const events = await this.source.read(revision.sessionId, revision.runId);
    const facts = readProviderUsageRunFacts(events);
    const indexedAt = this.now().toISOString();
    if (!facts.ok) {
      // Kept with its revision so an unchanged broken log is not re-read on
      // every pass; a repaired or extended log has a new revision and is read
      // again. The run stays visible as missing coverage.
      this.store.applyRun({
        partitionKey,
        sessionId: revision.sessionId,
        runId: revision.runId,
        mode: 'unknown',
        revision: revision.revision,
        indexedAt,
        attempts: [],
        missing: [],
        unreadable: true,
        reason: facts.reason,
      });
      return true;
    }
    this.store.applyRun({
      partitionKey,
      sessionId: facts.facts.sessionId,
      runId: facts.facts.runId,
      mode: facts.facts.mode,
      revision: revision.revision,
      indexedAt,
      attempts: facts.facts.attempts,
      missing: facts.facts.missing,
    });
    return true;
  }

  private resetPass(): void {
    this.cursor = undefined;
    this.processed = 0;
    this.indexed = 0;
    this.failed = 0;
    this.startedAt = undefined;
  }

  private record(): ProviderUsageDailyBackfillRecord {
    const finished = this.cursor === undefined && this.processed > 0;
    return {
      status: this.status,
      partitions: this.partitions,
      processed: this.processed,
      indexed: this.indexed,
      failed: this.failed,
      ...(this.cursor === undefined ? {} : { cursor: this.cursor }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(finished && this.startedAt !== undefined ? { finishedAt: this.now().toISOString() } : {}),
      ...(this.lastFailure === undefined ? {} : { error: this.lastFailure }),
    };
  }

  private async persist(): Promise<boolean> {
    try {
      if (this.store.lastError?.startsWith('usage index write failed')) this.store.setLastError(undefined);
      this.store.markScanned(this.now().toISOString());
      await this.store.save();
      return true;
    } catch (error) {
      const message = `usage index write failed: ${(error as Error).message}`;
      this.store.setLastError(message);
      this.log?.('warn', message);
      return false;
    }
  }
}

function clampBudget(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.min(64, max);
  return Math.max(1, Math.min(Math.floor(value), max));
}
