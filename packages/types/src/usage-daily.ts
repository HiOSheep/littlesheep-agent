// Cross-day Provider usage aggregation contract (O5).
//
// Every counted number here comes from a persisted Provider-reported usage
// event (a durable physical `provider_usage_recorded` receipt, with legacy
// logical-response compatibility). Local context ledgers, conservative safety estimates and
// embedding usage are never counted. `cached` and `reasoning` are subsets of
// `input` / `output` and are never added to `total`, so a consumer never has to
// decide which of them overlaps.

export const PROVIDER_USAGE_DAILY_VERSION = 1 as const;

/** Hard bound on one daily-series response: `days.length` never exceeds this. */
export const PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS = 400;
/** Default range when the caller names neither end (the heatmap's "last year"). */
export const PROVIDER_USAGE_DAILY_DEFAULT_RANGE_DAYS = 366;
/** Bound on each identity facet list returned with a series. */
export const PROVIDER_USAGE_DAILY_MAX_IDENTITIES = 64;
/** Bound on partitions a single refresh call may examine. */
export const PROVIDER_USAGE_DAILY_MAX_REFRESH_BUDGET = 512;
/** Bound on partitions a single backfill step may examine. */
export const PROVIDER_USAGE_DAILY_MAX_BACKFILL_STEP_BUDGET = 512;

/**
 * How one local day looked. A day with no recorded call (`empty`) is a
 * different fact from a day whose calls reported zero tokens (`recorded` with
 * `total: 0`), and both differ from a day whose calls happened but reported no
 * valid usage at all (`recording_error` with no counted attempts).
 */
/** `partial` is accepted only for older API consumers; new series emit recording_error. */
export type ProviderUsageDailyDayState = 'recorded' | 'recording_error' | 'partial' | 'empty' | 'future';

export interface ProviderUsageDailyDay {
  /** Calendar date in the series timezone, `YYYY-MM-DD`. */
  readonly date: string;
  readonly state: ProviderUsageDailyDayState;
  /** Deduplicated Provider attempts that carry a real usage report. */
  readonly requests: number;
  /** Sum of Provider-reported `totalTokens` (falling back to input + output). */
  readonly total: number;
  readonly input: number;
  readonly output: number;
  /** Subset of `input`: Provider-reported cache reads. */
  readonly cached: number;
  /** Subset of `output`: Provider-reported reasoning tokens. */
  readonly reasoning: number;
  /** Responses that reached the Provider but carried no usable usage report. */
  readonly missingResponses: number;
  /** Requests that started and never recorded a response. */
  readonly unreportedRequests: number;
  /** Execution outcomes, kept separate from usage recording errors. */
  readonly failedRequests?: number;
  readonly interruptedRequests?: number;
  readonly pendingRequests?: number;
}

export interface ProviderUsageDailyIdentity {
  readonly id: string;
  readonly requests: number;
  readonly total: number;
}

export interface ProviderUsageDailyTotals {
  readonly total: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly reasoning: number;
  readonly requests: number;
  /** Days in range with at least one counted attempt. */
  readonly activeDays: number;
  readonly peak?: { readonly date: string; readonly total: number };
}

export interface ProviderUsageDailyBackfillProgress {
  /**
   * `partial` means the projection does not cover every discovered partition
   * yet and another refresh continues from `cursor`; `running` means a
   * background backfill loop is stepping right now.
   */
  readonly status: 'idle' | 'partial' | 'running' | 'cancelled' | 'complete' | 'failed';
  /** Durable run partitions discovered on the last pass. */
  readonly partitions: number;
  /** Partitions this pass has already examined (unchanged ones included). */
  readonly processed: number;
  /** Partitions whose facts were (re)applied during this pass. */
  readonly indexed: number;
  /** Partitions that could not be read at all during this pass. */
  readonly failed: number;
  /** Partition key to resume from; absent when the pass reached the end. */
  readonly cursor?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface ProviderUsageDailyCoverage {
  readonly timezone: string;
  readonly timezoneSource: 'request' | 'system';
  /** Runs present in the derived projection (not in the event log). */
  readonly indexedRuns: number;
  readonly indexedSessions: number;
  /**
   * Counters below describe the whole projection, not just the queried range or
   * the active filters; the per-day rows carry the range-scoped facts.
   */
  readonly attempts: number;
  readonly missingResponses: number;
  readonly unreportedRequests: number;
  /** Runs that could not be reduced from their durable events at all. */
  readonly unreadableRuns: number;
  readonly modes: { readonly next: number; readonly shadow: number; readonly unknown: number };
  /** Attempts dropped because the same request id was already counted. */
  readonly duplicateAttempts: number;
  readonly firstAttemptAt?: string;
  readonly lastAttemptAt?: string;
  readonly updatedAt?: string;
  /** False until a refresh or backfill has applied at least one run. */
  readonly projectionBuilt: boolean;
  /** True when the last update failed and the numbers are the last good ones. */
  readonly stale: boolean;
  /** Explicit clear action scope: attempts at or before this instant are gone. */
  readonly clearedThrough?: string;
  /** Sessions with retained usage whose conversation no longer exists. */
  readonly retainedAfterDeleteSessions: number;
  readonly backfill: ProviderUsageDailyBackfillProgress;
  /** Human-readable timezone, dedup, missingness and retention statement. */
  readonly statement: string;
}

export interface ProviderUsageDailySeries {
  readonly version: typeof PROVIDER_USAGE_DAILY_VERSION;
  readonly timezone: string;
  readonly range: { readonly from: string; readonly to: string; readonly days: number };
  readonly bounds: {
    readonly maxRangeDays: number;
    readonly maxIdentities: number;
    readonly identitiesTruncated: boolean;
  };
  readonly filters: { readonly provider?: string; readonly model?: string };
  readonly days: readonly ProviderUsageDailyDay[];
  readonly totals: ProviderUsageDailyTotals;
  /** Facets over the filtered result set; bounded and sorted by total desc. */
  readonly identities: {
    readonly providers: readonly ProviderUsageDailyIdentity[];
    readonly models: readonly ProviderUsageDailyIdentity[];
  };
  readonly coverage: ProviderUsageDailyCoverage;
}

/** Parsed and validated daily-series query. */
export interface ProviderUsageDailyQuery {
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly timezoneSource: 'request' | 'system';
  readonly provider?: string;
  readonly model?: string;
}
