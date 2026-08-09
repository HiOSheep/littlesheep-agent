// @littlesheep/harness — stages/finalize.ts
// FINALIZE: assemble the final assistant Message, push to ctx.produced, and
// persist via SessionManager. Persistence failure is logged but does NOT
// block the run from returning a result.

import type { RunContext, StageResult, Message } from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import type { SessionManager } from '@littlesheep/session';
import { markMemoryKnownStateStage } from '../memory-known-state.js';
import { assessResponseMemoryContinuity } from '../response-continuity.js';
import { writeMemoryState } from '../memory-state.js';

export interface FinalizeStageDeps {
  sessionManager: SessionManager;
}

/** Factory: creates a finalize stage. */
export function createFinalizeStage(deps: FinalizeStageDeps) {
  return async function finalizeStage(ctx: RunContext): Promise<StageResult> {
    markMemoryKnownStateStage(ctx, 'finalize');
    const replyText = ctx.reply?.trim();
    const provenance = ctx.replyProvenance;
    const modelRequest = provenance
      ? ctx.modelRequests?.find((request) => request.id === provenance.modelRequestId)
      : undefined;
    const traceable = Boolean(
      provenance?.source === 'llm'
      && modelRequest
      && modelRequest.requestIndex === provenance.modelRequestIndex
      && modelRequest.provider === provenance.provider
      && modelRequest.model === provenance.model
      && modelRequest.callContract?.purpose === provenance.purpose,
    );
    const memoryContinuityAssessment = assessResponseMemoryContinuity({
      reply: traceable ? replyText : undefined,
      inbound: ctx.inbound,
      history: ctx.history,
      initialMemoryContext: ctx.initialMemoryContext,
      sessionSummary: ctx.sessionSummary,
      memoryKnownState: ctx.memoryKnownState,
      memoryContextWorkingSet: ctx.memoryContextWorkingSet,
      taskBook: ctx.taskBook,
      toolResults: ctx.toolResults,
      modelRequests: ctx.modelRequests,
      contextSnapshots: ctx.contextSnapshots,
      replyProvenance: ctx.replyProvenance,
    });
    writeMemoryState(ctx, 'finalize', { memoryContinuityAssessment });
    // 1. Persist only a non-empty reply traceable to this run's real Provider request.
    if (!replyText || !traceable) {
      return {
        stage: 'finalize',
        next: 'exit',
        ok: false,
        error: 'finalize rejected a missing or untraceable Provider API user-facing reply.',
        meta: {
          produced: ctx.produced.length,
          memoryContinuityAssessment: ctx.memoryContinuityAssessment,
        },
      };
    }
    const msg: Message = textMessage('assistant', replyText, {
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      stage: 'finalize',
      clarificationRequest: ctx.clarificationRequest,
      replyProvenance: provenance,
    });
    ctx.produced.push(msg);

    // 2. Persist (failure is non-fatal — the run still returns ok).
    try {
      await deps.sessionManager.append(ctx.sessionId, ctx.produced);
    } catch (err) {
      ctx.toolContext.log?.('error', `finalize: persist failed: ${(err as Error).message}`);
    }

    return {
      stage: 'finalize',
      next: 'exit',
      ok: true,
      meta: {
        produced: ctx.produced.length,
        memoryContinuityAssessment: ctx.memoryContinuityAssessment,
      },
    };
  };
}
