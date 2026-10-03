// Deduplicating fold over persisted Provider usage facts (O5).
//
// New attempt identity combines the Harness request id and physical HTTP attempt;
// transport retries within one logical call are separate billable responses.
// Legacy events retain their original logical request id. The durable event id is derived from run id + request id,
// so the same request id can only appear twice when a log was copied — a forked
// conversation, a replayed run, or the same partition read again. Folding by
// request id therefore collapses exactly those copies and never merges two
// independent attempts. When a copy and its original disagree, the earliest
// usage-event time wins, so re-indexing is order-independent.
import type { ProviderUsageDailyMissingFact } from './provider-usage-daily-series.js';
import type { ProviderUsageDailyCountedAttempt } from './provider-usage-daily-series.js';

export interface ProviderUsageDailyIndexedRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly mode: 'next' | 'shadow' | 'unknown';
  readonly attempts: readonly ProviderUsageDailyCountedAttempt[];
  readonly missing: readonly ProviderUsageDailyMissingFact[];
  /** True when the run's durable events could not be replayed at all. */
  readonly unreadable?: boolean;
}

export interface ProviderUsageDailyFoldOptions {
  /** Runs in a deterministic order (the index sorts partitions by key). */
  readonly runs: readonly ProviderUsageDailyIndexedRun[];
  /** Explicit clear scope: attempts at or before this instant are not counted. */
  readonly clearedThrough?: string;
  /** Session ids that still exist (active plus archived); others are retained. */
  readonly knownSessionIds?: ReadonlySet<string>;
}

export interface ProviderUsageDailyFoldResult {
  readonly attempts: readonly ProviderUsageDailyCountedAttempt[];
  readonly missing: readonly ProviderUsageDailyMissingFact[];
  readonly indexedRuns: number;
  readonly indexedSessions: number;
  readonly unreadableRuns: number;
  readonly duplicateAttempts: number;
  readonly missingResponses: number;
  readonly unreportedRequests: number;
  readonly modes: { readonly next: number; readonly shadow: number; readonly unknown: number };
  readonly firstAttemptAt?: string;
  readonly lastAttemptAt?: string;
  readonly retainedAfterDeleteSessions: number;
}

type FoldEntry =
  | { readonly kind: 'attempt'; readonly at: string; readonly attempt: ProviderUsageDailyCountedAttempt }
  | { readonly kind: 'missing'; readonly at: string; readonly mark: ProviderUsageDailyMissingFact };

export function foldProviderUsageDailyRuns(
  options: ProviderUsageDailyFoldOptions,
): ProviderUsageDailyFoldResult {
  const cutoff = options.clearedThrough;
  const entries = new Map<string, FoldEntry>();
  const sessions = new Set<string>();
  const modes = { next: 0, shadow: 0, unknown: 0 };
  let unreadableRuns = 0;
  let duplicateAttempts = 0;

  for (const run of options.runs) {
    modes[run.mode] += 1;
    if (run.unreadable) unreadableRuns += 1;
    for (const attempt of run.attempts) {
      if (cutoff !== undefined && attempt.at <= cutoff) continue;
      sessions.add(run.sessionId);
      const existing = entries.get(attempt.requestId);
      if (existing?.kind === 'attempt') {
        duplicateAttempts += 1;
        if (attempt.at < existing.at) {
          entries.set(attempt.requestId, { kind: 'attempt', at: attempt.at, attempt });
        }
        continue;
      }
      // A counted attempt is stronger evidence than a missing-coverage mark for
      // the same request id, so it replaces the mark.
      entries.set(attempt.requestId, { kind: 'attempt', at: attempt.at, attempt });
    }
    for (const mark of run.missing) {
      if (cutoff !== undefined && mark.at <= cutoff) continue;
      sessions.add(run.sessionId);
      const existing = entries.get(mark.requestId);
      if (!existing || (existing.kind === 'missing' && mark.at < existing.at)) {
        entries.set(mark.requestId, { kind: 'missing', at: mark.at, mark });
      }
    }
  }

  const attempts: ProviderUsageDailyCountedAttempt[] = [];
  const missing: ProviderUsageDailyMissingFact[] = [];
  let missingResponses = 0;
  let unreportedRequests = 0;
  let firstAttemptAt: string | undefined;
  let lastAttemptAt: string | undefined;
  let retainedSessions = 0;
  const retained = new Set<string>();
  for (const entry of [...entries.values()].sort(compareEntries)) {
    if (entry.kind === 'attempt') {
      attempts.push(entry.attempt);
      if (firstAttemptAt === undefined || entry.at < firstAttemptAt) firstAttemptAt = entry.at;
      if (lastAttemptAt === undefined || entry.at > lastAttemptAt) lastAttemptAt = entry.at;
      continue;
    }
    missing.push(entry.mark);
    if (entry.mark.kind === 'response_without_usage') missingResponses += 1;
    else if (entry.mark.kind === 'request_without_response') unreportedRequests += 1;
  }
  if (options.knownSessionIds) {
    for (const sessionId of sessions) {
      if (!options.knownSessionIds.has(sessionId) && !retained.has(sessionId)) {
        retained.add(sessionId);
        retainedSessions += 1;
      }
    }
  }

  return {
    attempts,
    missing,
    indexedRuns: options.runs.length,
    indexedSessions: sessions.size,
    unreadableRuns,
    duplicateAttempts,
    missingResponses,
    unreportedRequests,
    modes,
    ...(firstAttemptAt === undefined ? {} : { firstAttemptAt }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    retainedAfterDeleteSessions: retainedSessions,
  };
}

function compareEntries(left: FoldEntry, right: FoldEntry): number {
  return left.at.localeCompare(right.at) || identityOf(left).localeCompare(identityOf(right));
}

function identityOf(entry: FoldEntry): string {
  return entry.kind === 'attempt' ? entry.attempt.requestId : entry.mark.requestId;
}
