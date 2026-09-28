// Persisted shapes and file names of the derived daily usage index (O5).
import { join } from 'node:path';
import type { ProviderUsageDailyIndexedRun } from './provider-usage-daily-fold.js';

export const PROVIDER_USAGE_DAILY_INDEX_VERSION = 1 as const;
/** The rebuilt-from-events cache directory; deleting it is always safe. */
export const PROVIDER_USAGE_DAILY_INDEX_DIRECTORY = 'usage-index';
export const PROVIDER_USAGE_DAILY_INDEX_FILE = 'provider-usage-daily-index.json';
/**
 * Explicit user actions live outside the derived directory: an action the user
 * took is not a cache, so discarding and rebuilding the index must never
 * resurrect consumption the user cleared.
 */
export const PROVIDER_USAGE_DAILY_STATE_DIRECTORY = 'usage-state';
export const PROVIDER_USAGE_DAILY_CLEAR_FILE = 'provider-usage-clear-record.json';

export type ProviderUsageDailyBackfillStatus =
  | 'idle' | 'partial' | 'running' | 'cancelled' | 'complete' | 'failed';

export interface ProviderUsageDailyBackfillRecord {
  readonly status: ProviderUsageDailyBackfillStatus;
  /** Durable run partitions discovered on the last pass. */
  readonly partitions: number;
  /** Partitions this pass has already examined (unchanged ones included). */
  readonly processed: number;
  /** Partitions whose facts were (re)applied during this pass. */
  readonly indexed: number;
  /** Partitions that could not be read at all during this pass. */
  readonly failed: number;
  readonly cursor?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface ProviderUsageDailyRunRecord extends ProviderUsageDailyIndexedRun {
  readonly partitionKey: string;
  /** Event-log revision this record was built from; unchanged means skip. */
  readonly revision: string;
  readonly indexedAt: string;
  readonly reason?: string;
}

export interface ProviderUsageDailyClearRecord {
  readonly version: typeof PROVIDER_USAGE_DAILY_INDEX_VERSION;
  readonly clearedThrough: string;
  readonly clearedAt: string;
}

export interface ProviderUsageDailyPaths {
  /** Derived index directory. */
  readonly directory: string;
  /** Explicit clear action record; never inside `directory`. */
  readonly clearFile: string;
}

/** Absolute paths of the usage projection for one application data root. */
export function providerUsageDailyPaths(dataRoot: string): ProviderUsageDailyPaths {
  return {
    directory: join(dataRoot, PROVIDER_USAGE_DAILY_INDEX_DIRECTORY),
    clearFile: join(dataRoot, PROVIDER_USAGE_DAILY_STATE_DIRECTORY, PROVIDER_USAGE_DAILY_CLEAR_FILE),
  };
}
