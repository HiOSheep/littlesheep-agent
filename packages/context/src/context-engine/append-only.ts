// Append-only eviction bookkeeping for the Context Engine.
//
// A Provider prefix cache matches from token zero, so a caller extending a
// request it has already sent must not have that request silently re-numbered.
// The engine is the only place that knows what the previous request for a given
// run and stage actually delivered, so it keeps that record here rather than
// asking the caller to name ids it would have to derive twice.
import type { PrepareContextRequestInput } from './contracts.js';
import { deliveredUnitIds } from './eviction.js';
import type { ContextMessageCandidate } from './contracts.js';

/** Bounded number of run+stage append-only ledgers one engine instance keeps. */
export const MAX_APPEND_ONLY_LEDGERS = 32;

/**
 * The candidate ids an `appended-only` request protects.
 *
 * Under that scope the caller is asking to extend a request it has already sent,
 * so everything the previous request for the same run and stage delivered is
 * protected; the caller may also name extra candidates it owns. What remains
 * evictable is exactly what this request appended.
 */
export function protectedCandidateIds(
  input: PrepareContextRequestInput,
  delivered: ReadonlySet<string> | undefined,
): Set<string> {
  return new Set([...(delivered ?? []), ...(input.protectedCandidateIds ?? [])]);
}

/** One engine instance's record of what each run+stage request delivered. */
export class AppendOnlyLedger {
  private readonly delivered = new Map<string, Set<string>>();

  /** The units the previous request for this run and stage delivered, if any. */
  read(runId: string, stage: string): ReadonlySet<string> | undefined {
    return this.delivered.get(ledgerKey(runId, stage));
  }

  /** Record what this request delivered, after eviction has settled. */
  remember(
    runId: string,
    stage: string,
    candidates: readonly ContextMessageCandidate[],
    omitted: ReadonlySet<string>,
  ): void {
    const key = ledgerKey(runId, stage);
    if (this.delivered.has(key)) this.delivered.delete(key);
    this.delivered.set(key, deliveredUnitIds(candidates, omitted));
    while (this.delivered.size > MAX_APPEND_ONLY_LEDGERS) {
      const oldest = this.delivered.keys().next().value;
      if (oldest === undefined) break;
      this.delivered.delete(oldest);
    }
  }
}

function ledgerKey(runId: string, stage: string): string {
  return `${runId}\u0000${stage}`;
}
