// Shared reading of the run's verification record.
//
// VERIFY no longer asks a model to bless the run, so its verdicts now mean:
// - `pass`: Runtime itself proved the recorded acceptance (narrow structural shapes);
// - `unverified`: every recorded fact is complete and consistent and a
//   Provider-authored reply exists, but acceptance criteria that need human
//   judgement were not judged by anyone;
// - `needs_replan` / `fail`: recorded evidence contradicts completion.
//
// Downstream stages may build on a run whose evidence did not fail, but only a
// `pass` counts as proven acceptance.
import type { RunContext } from '@littlesheep/types';

/** True when the latest verification record did not fail. */
export function hasCleanVerification(ctx: Pick<RunContext, 'verificationHistory'>): boolean {
  const verdict = ctx.verificationHistory?.at(-1)?.verdict;
  return verdict === 'pass' || verdict === 'unverified';
}

/** True only when Runtime itself proved the recorded acceptance. */
export function hasProvenVerification(ctx: Pick<RunContext, 'verificationHistory'>): boolean {
  return ctx.verificationHistory?.at(-1)?.verdict === 'pass';
}
