// @littlesheep/harness — stages/finalize.ts
// FINALIZE: assemble the final assistant Message, push to ctx.produced, and
// persist via SessionManager. Persistence failure is logged but does NOT
// block the run from returning a result.

import type { RunContext, StageResult, Message } from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import type { SessionManager } from '@littlesheep/session';
import { markMemoryKnownStateStage } from '../memory-known-state.js';

export interface FinalizeStageDeps {
  sessionManager: SessionManager;
}

/** Factory: creates a finalize stage. */
export function createFinalizeStage(deps: FinalizeStageDeps) {
  return async function finalizeStage(ctx: RunContext): Promise<StageResult> {
    markMemoryKnownStateStage(ctx, 'finalize');
    // 1. Build the final assistant message.
    const replyText = ctx.reply && ctx.reply.length > 0 ? ctx.reply : '(no reply)';
    const msg: Message = textMessage('assistant', replyText, {
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      stage: 'finalize',
      clarificationRequest: ctx.clarificationRequest,
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
      meta: { produced: ctx.produced.length },
    };
  };
}
