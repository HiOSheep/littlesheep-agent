// Persisted, rebuildable daily usage index under the application data root (O5).
//
// The index is a derived cache: deleting it changes nothing but the cost of the
// next refresh, because every number in it comes from the durable event log.
// The one thing that is NOT derivable — the user's explicit "clear usage
// statistics" action — lives outside the derived directory, so discarding and
// rebuilding this index can never resurrect cleared consumption.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomically } from './durable-store-utils.js';
import { decodeClearRecord, decodeIndexFile, encodeIndexFile } from './provider-usage-daily-index-codec.js';
import {
  PROVIDER_USAGE_DAILY_INDEX_FILE,
  PROVIDER_USAGE_DAILY_INDEX_VERSION,
  providerUsageDailyPaths,
  type ProviderUsageDailyBackfillRecord,
  type ProviderUsageDailyClearRecord,
  type ProviderUsageDailyPaths,
  type ProviderUsageDailyRunRecord,
} from './provider-usage-daily-index-records.js';

export * from './provider-usage-daily-index-records.js';

const IDLE_BACKFILL: ProviderUsageDailyBackfillRecord = {
  status: 'idle',
  partitions: 0,
  processed: 0,
  indexed: 0,
  failed: 0,
};

export class ProviderUsageDailyIndexStore {
  private readonly directory: string;
  private readonly clearFilePath: string;
  private runsByKey = new Map<string, ProviderUsageDailyRunRecord>();
  private updatedAtValue: string | undefined;
  private scannedAtValue: string | undefined;
  private lastErrorValue: string | undefined;
  private backfillRecord: ProviderUsageDailyBackfillRecord = IDLE_BACKFILL;
  private clearedThrough: string | undefined;
  private dirty = false;

  constructor(paths: ProviderUsageDailyPaths) {
    this.directory = paths.directory;
    this.clearFilePath = paths.clearFile;
  }

  /** Derived index directory plus the non-derived clear record for a data root. */
  static pathsFor(dataRoot: string): ProviderUsageDailyPaths {
    return providerUsageDailyPaths(dataRoot);
  }

  get indexFile(): string {
    return join(this.directory, PROVIDER_USAGE_DAILY_INDEX_FILE);
  }

  get clearFile(): string {
    return this.clearFilePath;
  }

  get runs(): readonly ProviderUsageDailyRunRecord[] {
    return [...this.runsByKey.values()].sort((left, right) => (
      left.partitionKey.localeCompare(right.partitionKey)
    ));
  }

  get updatedAt(): string | undefined {
    return this.updatedAtValue;
  }

  get scannedAt(): string | undefined {
    return this.scannedAtValue;
  }

  get lastError(): string | undefined {
    return this.lastErrorValue;
  }

  get backfill(): ProviderUsageDailyBackfillRecord {
    return this.backfillRecord;
  }

  get clearScope(): string | undefined {
    return this.clearedThrough;
  }

  revisionFor(partitionKey: string): string | undefined {
    return this.runsByKey.get(partitionKey)?.revision;
  }

  /** Loads the derived index and the independent clear record. */
  async load(): Promise<void> {
    const raw = await readFileOrUndefined(this.indexFile);
    if (raw !== undefined) {
      const decoded = decodeIndexFile(raw);
      if (decoded) {
        this.runsByKey = decoded.runs;
        this.updatedAtValue = decoded.updatedAt;
        this.scannedAtValue = decoded.scannedAt;
        this.lastErrorValue = decoded.lastError;
        this.backfillRecord = decoded.backfill;
      } else {
        // A derived index that cannot be decoded is discarded, not guessed at:
        // the next refresh rebuilds it from the event log.
        this.runsByKey = new Map();
        this.lastErrorValue = 'derived usage index was unreadable and has been reset';
      }
    }
    const clearRaw = await readFileOrUndefined(this.clearFile);
    const clear = clearRaw === undefined ? undefined : decodeClearRecord(clearRaw);
    if (clear) this.clearedThrough = clear.clearedThrough;
  }

  /** Replaces one run's contribution; re-applying the same run is idempotent. */
  applyRun(record: ProviderUsageDailyRunRecord): void {
    this.runsByKey.set(record.partitionKey, record);
    this.dirty = true;
  }

  markScanned(at: string): void {
    this.scannedAtValue = at;
    this.dirty = true;
  }

  setLastError(message: string | undefined): void {
    if (this.lastErrorValue === message) return;
    this.lastErrorValue = message;
    this.dirty = true;
  }

  setBackfill(record: ProviderUsageDailyBackfillRecord): void {
    this.backfillRecord = record;
    this.dirty = true;
  }

  /** Explicit clear action: records the cutoff in its own non-derived file. */
  async recordClear(clearedThrough: string, clearedAt: string): Promise<void> {
    const record: ProviderUsageDailyClearRecord = {
      version: PROVIDER_USAGE_DAILY_INDEX_VERSION,
      clearedThrough,
      clearedAt,
    };
    this.clearedThrough = clearedThrough;
    await writeJsonAtomically(this.clearFile, record);
  }

  /** Writes the derived index when it changed. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const stored = encodeIndexFile({
      runs: this.runs,
      scannedAt: this.scannedAt,
      lastError: this.lastError,
      backfill: this.backfillRecord,
    });
    await writeJsonAtomically(this.indexFile, stored);
    this.updatedAtValue = stored.updatedAt;
    this.dirty = false;
  }
}

async function readFileOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
