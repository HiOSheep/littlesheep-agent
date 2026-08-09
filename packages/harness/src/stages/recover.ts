// @littlesheep/harness — stages/recover.ts
// RECOVER: LLM decides retry / escalate / abort when a prior stage failed.
// Increments recoveryAttempts; forces escalate once max is exceeded.

import type { RunContext, StageName, StageResult } from '@littlesheep/types';
import { textOf } from './_shared.js';
import {
  acceptUniqueUserFacingReply,
  reserveUserFacingReplyOnce,
} from '../user-facing-reply.js';
import type { DecodedRecovery, RecoverStageDeps } from './recover/contracts.js';
import { requestRecoveryDecision, rewriteAbortReason } from './recover/model-call.js';
import {
  isStructuredDecodeFailure,
  normalizeRecoveryPlan,
  retryStageFor,
} from './recover/policy.js';
import { writeReplanState } from '../replan-state.js';
import { clearReplyState } from '../reply-state.js';
import { updateClarificationRequest, writeDecisionState } from '../decision-state.js';

export type { RecoverStageDeps } from './recover/contracts.js';

/** Factory: creates a recover stage. */
export function createRecoverStage(deps: RecoverStageDeps) {
  return async function recoverStage(ctx: RunContext): Promise<StageResult> {
    ctx.recoveryAttempts = (ctx.recoveryAttempts ?? 0) + 1;

    // Force-escalate once we've exhausted retries.
    if (ctx.recoveryAttempts > ctx.maxRecoveryAttempts) {
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: { forcedEscalate: true, attempts: ctx.recoveryAttempts },
      };
    }

    const lastError = ctx.lastError;
    const availableToolNames = new Set(ctx.tools.map((t) => t.name));

    if (isStructuredDecodeFailure(lastError) && ctx.recoveryAttempts === 1) {
      return {
        stage: 'recover',
        next: retryStageFor(lastError?.stage),
        ok: true,
        meta: {
          deterministicRetry: true,
          attempts: ctx.recoveryAttempts,
          failedStage: lastError?.stage,
        },
      };
    }

    let parsed: DecodedRecovery | null;
    try {
      parsed = await requestRecoveryDecision(deps, ctx);
    } catch (e) {
      // Transport error during recovery — escalate to the user instead of
      // propagating to default-harness → exit. RECOVER itself failing must
      // not silently kill the run.
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: {
          fallbackEscalate: true,
          attempts: ctx.recoveryAttempts,
          transportError: (e as Error).message,
        },
      };
    }

    if (!parsed || (parsed.action !== 'retry' && parsed.action !== 'escalate' && parsed.action !== 'abort')) {
      // Could not decode → escalate conservatively.
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: { fallbackEscalate: true, attempts: ctx.recoveryAttempts },
      };
    }

    const coercedAbort = parsed.action === 'abort' && isStructuredDecodeFailure(lastError);
    const action = coercedAbort ? 'retry' : parsed.action;
    let next: StageName;
    if (action === 'retry') {
      const revised = normalizeRecoveryPlan(parsed.revisedPlan, availableToolNames);
      if (revised) {
        writeReplanState(ctx, 'recover', { plan: revised, taskBook: undefined });
        next = 'execute';
      } else {
        next = retryStageFor(lastError?.stage);
      }
    } else if (action === 'escalate') {
      const visibleMessage = parsed.userMessage?.trim();
      const originalRequest = textOf(ctx.inbound);
      const chinese = /[\u3400-\u9fff]/u.test(originalRequest);
      writeDecisionState(ctx, 'recover', { clarificationRequest: {
        id: `${ctx.runId}:clarification`,
        kind: 'recovery_decision',
        sourceStage: 'recover',
        createdAt: new Date().toISOString(),
        originalRequest,
        copySource: visibleMessage ? 'model' : 'runtime_fallback',
        blockingReason: parsed.reason?.trim()
          || `${lastError?.stage ?? 'recover'}: ${lastError?.message ?? 'execution could not continue'}`,
        questions: [{
          id: 'question-1',
          field: 'recoveryDecision',
          prompt: visibleMessage ?? (chinese ? '你希望我接下来如何处理？' : 'How would you like me to proceed?'),
          required: true,
        }],
      } });
      if (visibleMessage) {
        let reserved: string | undefined;
        try {
          reserved = await reserveUserFacingReplyOnce(ctx, 'recover', visibleMessage);
        } catch (error) {
          ctx.lastError = { stage: 'recover', message: `user-facing recovery reply generation failed: ${(error as Error).message}` };
          return { stage: 'recover', next: 'exit', ok: false, error: ctx.lastError.message };
        }
        if (reserved) {
          updateClarificationRequest(ctx, 'recover', (value) => ({ ...value, prompt: reserved }));
          next = 'finalize';
          return {
            stage: 'recover',
            next,
            ok: true,
            meta: {
              action: parsed.action,
              attempts: ctx.recoveryAttempts,
              reason: parsed.reason,
              directClarification: true,
            },
          };
        }
      }
      next = 'ask_user';
    } else {
      try {
        await acceptUniqueUserFacingReply(
          ctx,
          'recover',
          parsed.reason ?? '',
          (input) => rewriteAbortReason(deps, ctx, lastError, input),
        );
      } catch (error) {
        clearReplyState(ctx, 'recover');
        ctx.lastError = { stage: 'recover', message: `user-facing recovery reply generation failed: ${(error as Error).message}` };
        return { stage: 'recover', next: 'exit', ok: false, error: ctx.lastError.message };
      }
      next = 'finalize';
    }

    return {
      stage: 'recover',
      next,
      ok: true,
      meta: {
        action,
        attempts: ctx.recoveryAttempts,
        reason: parsed.reason,
        ...(coercedAbort ? { coercedAbort: true } : {}),
      },
    };
  };
}
