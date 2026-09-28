// Read-only projection of the persisted daily usage index into a bounded series.
//
// The fold (dedup + coverage) and the series (calendar days, totals, facets)
// stay in their own pure modules; this file is only the wiring between the
// persisted index and those two, so the HTTP layer never recomputes a total.
import type { ProviderUsageDailySeries } from '@littlesheep/types';
import { foldProviderUsageDailyRuns } from './provider-usage-daily-fold.js';
import type { ProviderUsageDailyBackfillRecord } from './provider-usage-daily-index-records.js';
import { buildProviderUsageDailySeries } from './provider-usage-daily-series.js';

export interface ProviderUsageDailyQueryInput {
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly timezoneSource: 'request' | 'system';
  readonly provider?: string;
  readonly model?: string;
  readonly knownSessionIds?: ReadonlySet<string>;
}

export interface ProviderUsageDailyProjectionSource {
  readonly runs: Parameters<typeof foldProviderUsageDailyRuns>[0]['runs'];
  readonly clearScope: string | undefined;
  readonly updatedAt: string | undefined;
  readonly scannedAt: string | undefined;
  readonly lastError: string | undefined;
}

export interface ProviderUsageDailySeriesContext {
  readonly backfill: ProviderUsageDailyBackfillRecord;
  readonly now: Date;
}

export function buildProviderUsageDailyQuerySeries(
  store: ProviderUsageDailyProjectionSource,
  input: ProviderUsageDailyQueryInput,
  context: ProviderUsageDailySeriesContext,
): ProviderUsageDailySeries {
  const fold = foldProviderUsageDailyRuns({
    runs: store.runs,
    ...(store.clearScope === undefined ? {} : { clearedThrough: store.clearScope }),
    ...(input.knownSessionIds === undefined ? {} : { knownSessionIds: input.knownSessionIds }),
  });
  const unfiltered = input.provider === undefined && input.model === undefined;
  const attempts = unfiltered ? fold.attempts : fold.attempts.filter((attempt) => (
    (input.provider === undefined || attempt.provider === input.provider)
    && (input.model === undefined || attempt.model === input.model)
  ));
  const missing = unfiltered ? fold.missing : fold.missing.filter((mark) => (
    (input.provider === undefined || mark.provider === input.provider)
    && (input.model === undefined || mark.model === input.model)
  ));
  const backfill = context.backfill;
  return buildProviderUsageDailySeries({
    timezone: input.timezone,
    timezoneSource: input.timezoneSource,
    from: input.from,
    to: input.to,
    filters: {
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
    },
    attempts,
    missing,
    coverage: {
      indexedRuns: fold.indexedRuns,
      indexedSessions: fold.indexedSessions,
      attempts: fold.attempts.length,
      missingResponses: fold.missingResponses,
      unreportedRequests: fold.unreportedRequests,
      unreadableRuns: fold.unreadableRuns,
      modes: fold.modes,
      duplicateAttempts: fold.duplicateAttempts,
      ...(fold.firstAttemptAt === undefined ? {} : { firstAttemptAt: fold.firstAttemptAt }),
      ...(fold.lastAttemptAt === undefined ? {} : { lastAttemptAt: fold.lastAttemptAt }),
      ...(store.updatedAt === undefined ? {} : { updatedAt: store.updatedAt }),
      projectionBuilt: store.scannedAt !== undefined,
      stale: store.lastError !== undefined,
      ...(store.clearScope === undefined ? {} : { clearedThrough: store.clearScope }),
      retainedAfterDeleteSessions: fold.retainedAfterDeleteSessions,
      backfill: {
        status: backfill.status,
        partitions: backfill.partitions,
        processed: backfill.processed,
        indexed: backfill.indexed,
        failed: backfill.failed,
        ...(backfill.cursor === undefined ? {} : { cursor: backfill.cursor }),
        ...(backfill.startedAt === undefined ? {} : { startedAt: backfill.startedAt }),
        ...(backfill.finishedAt === undefined ? {} : { finishedAt: backfill.finishedAt }),
        ...(backfill.error === undefined ? {} : { error: backfill.error }),
      },
    },
    now: context.now,
  });
}
