// Detects a committed correction/forget so a pre-revocation session summary stops
// being injected as current memory. The Runtime owns this decision; the model
// never marks its own output as revoked.

import type { RunContext, StageResult } from '@littlesheep/types';

export function memoryRevokedDuringRun(ctx: RunContext, stageResult: StageResult): boolean {
  const decisions = ctx.memoryIntentDecisions ?? [];
  if (decisions.some((record) => record.decision === 'committed' && record.proposedIntent === 'invalidate')) {
    return true;
  }
  const corrections = (stageResult.meta as { memoryAtomCorrections?: unknown } | undefined)?.memoryAtomCorrections;
  return Array.isArray(corrections)
    && corrections.some((entry) => Boolean(
      entry
      && typeof entry === 'object'
      && (entry as { status?: unknown }).status === 'committed',
    ));
}
