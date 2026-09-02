// @littlesheep/harness — stages/finalize.ts
// FINALIZE: assemble the final assistant Message and settle it durably only
// after the session write succeeds. A persistence failure is a runtime error.

import type { FinalReplyReservation, FinalReplySettlement, RunContext, StageResult, Message } from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import type { SessionManager } from '@littlesheep/session';
import { markMemoryKnownStateStage } from '../memory-known-state.js';
import { assessResponseMemoryContinuity } from '../response-continuity.js';
import { writeMemoryState } from '../memory-state.js';
import { flushModelRequestLifecycles } from '../model-observability.js';
import { finalReplyFingerprint, finalReplySettlementId } from '../final-reply-identity.js';
import { writeReplyState } from '../reply-state.js';

export interface FinalizeStageDeps {
  sessionManager: SessionManager;
}

/** Factory: creates a finalize stage. */
export function createFinalizeStage(deps: FinalizeStageDeps) {
  return async function finalizeStage(ctx: RunContext): Promise<StageResult> {
    markMemoryKnownStateStage(ctx, 'finalize');
    try {
      // FINALIZE is the first authoritative publication boundary. Do not
      // propose or settle a reply while any model request from this run is
      // still missing its response/settlement event.
      await flushModelRequestLifecycles(ctx);
    } catch (error) {
      ctx.toolContext.log?.('error', `finalize: model request lifecycle flush failed: ${(error as Error).message}`);
      return runtimeFailure(ctx, 'finalize could not durably settle model request lifecycles.');
    }
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
    if (!replyText || !traceable || !provenance) {
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
    const replyFingerprint = finalReplyFingerprint(replyText);
    const settlementId = finalReplySettlementId(ctx.runId, replyFingerprint);
    const reservation: FinalReplyReservation = {
      version: 1,
      settlementId,
      reply: replyText,
      replyFingerprint,
      modelRequestId: provenance.modelRequestId,
    };
    const proposedSettlement: FinalReplySettlement = {
      ...reservation,
      status: 'proposed',
    };
    // Most replies are reserved when the model candidate is accepted. The
    // FINALIZE boundary repeats the operation idempotently for direct callers
    // and old integrations that set ctx.reply themselves.
    if (ctx.reserveUserFacingReplySettlement) {
      try {
        if (!await ctx.reserveUserFacingReplySettlement(reservation)) {
          return runtimeFailure(ctx, 'finalize rejected a duplicate or conflicting final reply settlement.');
        }
      } catch (error) {
        ctx.toolContext.log?.('error', `finalize: reply reservation failed: ${(error as Error).message}`);
        return runtimeFailure(ctx, 'finalize could not reserve the final reply settlement.');
      }
    }
    try {
      await ctx.appendDurableEvent?.({
        type: 'final_reply_proposed',
        source: 'runtime',
        eventId: `${ctx.runId}:final-reply-proposed`,
        idempotencyKey: `${ctx.runId}:final-reply-proposed`,
        payload: {
          reply: replyText,
          replyFingerprint,
          modelRequestId: provenance.modelRequestId,
          modelRequestIndex: provenance.modelRequestIndex,
          settlementId,
        },
      });
    } catch (error) {
      ctx.toolContext.log?.('error', `finalize: durable reply proposal failed: ${(error as Error).message}`);
      return runtimeFailure(ctx, 'finalize could not durably propose the final reply.');
    }
    const msg: Message = textMessage('assistant', replyText, {
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      stage: 'finalize',
      clarificationRequest: ctx.clarificationRequest,
      replyProvenance: provenance,
      finalReplySettlement: proposedSettlement,
    });
    ctx.produced.push(msg);

    // Persist before settling the durable final-reply event. This ordering
    // makes a crash recoverable without publishing an unpersisted answer.
    try {
      await deps.sessionManager.append(ctx.sessionId, ctx.produced);
    } catch (err) {
      ctx.toolContext.log?.('error', `finalize: persist failed: ${(err as Error).message}`);
      await settleRuntimeFailure(ctx, 'session_persist_failed');
      return runtimeFailure(ctx, `finalize could not persist the assistant reply: ${(err as Error).message}`);
    }
    try {
      if (ctx.settleUserFacingReplySettlement) {
        await ctx.settleUserFacingReplySettlement(reservation);
      }
      await ctx.appendDurableEvent?.({
        type: 'final_reply_settled',
        source: 'runtime',
        eventId: `${ctx.runId}:final-reply-settled`,
        idempotencyKey: `${ctx.runId}:final-reply-settled`,
        payload: {
          reply: replyText,
          replyFingerprint,
          modelRequestId: provenance.modelRequestId,
          modelRequestIndex: provenance.modelRequestIndex,
          settlementId,
        },
      });
      writeReplyState(ctx, 'finalize', {
        finalReplySettlement: {
          ...proposedSettlement,
          status: 'settled',
        },
      });
    } catch (error) {
      ctx.toolContext.log?.('error', `finalize: durable reply settlement failed: ${(error as Error).message}`);
      await settleRuntimeFailure(ctx, 'final_reply_settlement_failed');
      return runtimeFailure(ctx, 'finalize could not durably settle the final reply.');
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

async function settleRuntimeFailure(ctx: RunContext, reason: string): Promise<void> {
  try {
    await ctx.appendDurableEvent?.({
      type: 'runtime_status_settled',
      source: 'runtime',
      eventId: `${ctx.runId}:runtime-failure:${reason}`,
      idempotencyKey: `${ctx.runId}:runtime-failure:${reason}`,
      payload: { status: 'failed', reason },
    });
  } catch {
    // The caller already returns a failure; keep the original cause visible.
  }
}

function runtimeFailure(ctx: RunContext, error: string): StageResult {
  return {
    stage: 'finalize',
    next: 'exit',
    ok: false,
    error,
    meta: {
      produced: ctx.produced.length,
      memoryContinuityAssessment: ctx.memoryContinuityAssessment,
    },
  };
}
