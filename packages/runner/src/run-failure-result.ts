// Next-path Runtime failure publication.
//
// A failed next run must never publish model prose, but it must still tell the
// user why it failed. These helpers keep the bounded, Runtime-owned failure
// detail while clearing every unpublished final-reply artifact.
import type { RunContext } from '@littlesheep/types';
import type { LogFn } from './infra.js';
import type { RunnerResult } from './runner.js';

/** Bounded user-facing failure detail kept from the underlying Runtime error. */
const MAX_RUNTIME_FAILURE_DETAIL_LENGTH = 512;

/** Persist the Runtime-owned failure status for the durable projection. */
export async function settleRuntimeFailureEvent(
  ctx: RunContext,
  reason: string,
  log?: LogFn,
): Promise<void> {
    try {
      await ctx.appendDurableEvent?.({
        type: 'runtime_status_settled',
        source: 'runtime',
        eventId: `${ctx.runId}:runtime-failure:${reason}`,
        idempotencyKey: `${ctx.runId}:runtime-failure:${reason}`,
        payload: { status: 'failed', reason },
      });
    } catch (error) {
      log?.('error', `runner: failed to persist Runtime failure status: ${(error as Error).message}`);
    }
}

/** Build the published result for a failed next run. */
export function runtimeFailureResult(result: RunnerResult, reason: string): RunnerResult {
    const runtimeStatus = {
      version: 1 as const,
      status: 'failed' as const,
      reason,
    };
    // The Runtime-owned failure text is not model prose. Keep it visible so
    // the user sees the actionable cause (for example a Provider auth error)
    // instead of only the internal settlement code.
    const detail = result.error?.replace(/\s+/gu, ' ').trim().slice(0, MAX_RUNTIME_FAILURE_DETAIL_LENGTH);
    return {
      ...clearUnpublishedNextResult(result),
      status: 'error',
      runtimeStatus,
      error: detail || `Runtime failed before publishing a final reply. Reason: ${reason}`,
      webEvidence: undefined,
    };
}

/** Drop every artifact that was never durably settled. */
export function clearUnpublishedNextResult(result: RunnerResult): RunnerResult {
  return {
    ...result,
    reply: '',
    replyProvenance: undefined,
    finalReplySettlement: undefined,
    messages: result.messages.filter((message) => !(message.role === 'assistant' && message.stage === 'finalize')),
  };
}
