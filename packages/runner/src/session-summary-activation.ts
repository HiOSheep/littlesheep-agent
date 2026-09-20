// Records successful semantic-cache use without changing immutable summary projections.

import type { SessionManager } from '@littlesheep/session';
import type { CompactionSummary, SessionId, VerificationRecord } from '@littlesheep/types';

export interface SessionSummaryActivationInput {
  sessionManager: SessionManager;
  sessionId: SessionId;
  summary?: CompactionSummary;
  usedSummaryId?: string;
  answerUsedSummaryId?: string;
  runId: string;
  status: 'ok' | 'error' | 'aborted';
  verification?: VerificationRecord;
  successfulToolCallIds: string[];
  recordedAt: string;
}

export async function recordSessionSummaryActivation(
  input: SessionSummaryActivationInput,
): Promise<boolean> {
  if (!input.summary) return false;
  const usedForRun = input.summary.id === input.usedSummaryId;
  const usedByAnswer = input.summary.id === input.answerUsedSummaryId;
  if (!usedForRun && !usedByAnswer) return false;
  // `passed` records that the run completed with complete recorded evidence and
  // no failed verification. `unverified` (acceptance not judged) still counts
  // for the routing-level "useful" outcome; the stronger `verified` flag stays
  // limited to a Runtime-proven pass.
  const proven = input.status === 'ok' && input.verification?.verdict === 'pass';
  const passed = input.status === 'ok'
    && (proven || input.verification?.verdict === 'unverified');
  if (!passed && !(input.status === 'ok' && usedByAnswer)) return false;
  const verified = usedForRun && proven && (
    input.verification?.source === 'structural'
    || input.successfulToolCallIds.length > 0
  );
  await input.sessionManager.recordCompactionActivation(input.sessionId, input.summary.id, {
    id: `session-summary-activation:${input.runId}:${input.summary.id}`,
    outcome: 'useful',
    verified,
    observedAt: input.recordedAt,
  });
  return true;
}
