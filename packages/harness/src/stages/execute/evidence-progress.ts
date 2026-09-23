// Evidence identity and the no-progress ledger of the single main loop.
//
// The loop has to answer one question after every tool round: did this round add
// evidence the run did not already have? It decides that by hashing what a call
// actually touched and returned — tool source, resource keys, completeness, and
// either the settled effect's idempotency key or the bounded output — not by
// comparing tool names, which would call two different reads of the same file
// "progress" and two reads of different files "the same call".
//
// The identities are persisted on the run (`loopBudget.evidenceFingerprints`)
// because recovery re-enters this loop: a round that re-reads what the previous
// attempt already read must still count as no progress instead of resetting the
// bound. The set is bounded; once it saturates the run reports no further
// progress rather than growing without limit.
import { createHash } from 'node:crypto';
import type { RunContext, ToolResult } from '@littlesheep/types';
import { writeRuntimeState } from '../../runtime-state.js';
import { safeStringify } from './tool-result-persistence.js';
import { MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS } from './iteration-budget.js';

export const MAX_EVIDENCE_FINGERPRINTS = 128;

export interface EvidenceFingerprintState {
  saturated: boolean;
}

/** Record one result's identity; false when the run already had this evidence. */
export function registerEvidenceFingerprint(
  ctx: RunContext,
  fingerprints: Set<string>,
  state: EvidenceFingerprintState,
  toolName: string,
  result: ToolResult,
): boolean {
  const invocation = [...(ctx.toolInvocations ?? [])]
    .reverse()
    .find((candidate) => candidate.callId === result.callId);
  const sideEffect = result.ok
    ? ctx.sideEffects?.find((effect) => effect.callId === result.callId && effect.status === 'succeeded')
    : undefined;
  const normalizedOutput = normalizeEvidenceOutput(safeStringify(result.ok ? result.output : result.error));
  const fingerprint = createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(invocation?.toolSource ?? 'unknown-source')
    .update('\0')
    .update(invocation?.resourceKeys?.length
      ? invocation.resourceKeys.join('\0')
      : invocation?.inputHash ?? 'unknown-input')
    .update('\0')
    .update(invocation?.outputTruncated === true || result.sanitized === true ? 'partial' : 'complete')
    .update('\0')
    .update(sideEffect ? 'side-effect' : result.ok ? 'ok' : 'error')
    .update('\0')
    .update(sideEffect?.idempotencyKey ?? normalizedOutput)
    .digest('hex');
  if (fingerprints.has(fingerprint)) return false;
  if (state.saturated || fingerprints.size >= MAX_EVIDENCE_FINGERPRINTS) {
    state.saturated = true;
    return false;
  }
  fingerprints.add(fingerprint);
  return true;
}

/** Persist the no-progress ledger so a re-entered loop continues the same bound. */
export function persistToolLoopProgress(
  ctx: RunContext,
  fingerprints: ReadonlySet<string>,
  saturated: boolean,
  noProgressRounds: number,
): void {
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...(ctx.loopBudget ?? {
        attemptsUsed: ctx.modelCallCount ?? 0,
        maxAttempts: ctx.maxModelCalls ?? 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
        noProgressRounds: 0,
        maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      }),
      noProgressRounds,
      maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      evidenceFingerprints: [...fingerprints],
      evidenceFingerprintSaturated: saturated,
    },
  });
}

/** Timestamps and durations are not evidence: normalize them out of the identity. */
function normalizeEvidenceOutput(value: string): string {
  return value
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b/gu, '<timestamp>')
    .replace(/\b(duration|elapsed|time)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:ms|s)?\b/giu, '$1=<duration>')
    .replace(/\s+/gu, ' ')
    .trim();
}
