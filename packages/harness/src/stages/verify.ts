// VERIFY orchestration facade over structural evidence and bounded recovery.
import type { RunContext, StageResult } from '@littlesheep/types';
import {
  type DecodedVerdict,
  type VerifyStageDeps,
} from './verify/contracts.js';
import { requestVerificationVerdict } from './verify/model-call.js';
import {
  escalateExhaustedReplan,
  publishVerifiedReply,
  recordVerification,
  routeKnownIncompleteExecution,
  verifyDeterministicWriteReadExecution,
  verifyTrivialReadOnlyExecution,
} from './verify/routing.js';
import {
  canRecoverWithPartialReplan,
  deriveReplanTargets,
  hasIncompleteTaskExecution,
  installPartialReplan,
} from './verify/task-state.js';
import { acceptedUsedMemoryAtomIds } from './verify/memory-evidence.js';
import { writeReplanState } from '../replan-state.js';
import { recordFailure } from '../failure-state.js';
export type { VerifyStageDeps } from './verify/contracts.js';
export function createVerifyStage(deps: VerifyStageDeps) {
  return async function verifyStage(ctx: RunContext): Promise<StageResult> {
    const replanAttempts = ctx.replanAttempts ?? 0;
    const maxReplan = ctx.maxReplanAttempts ?? 2;
    ctx.onToolEvent?.({ type: 'verification_start', visibility: 'silent' });
    const runtimeVerdict = await verifyTrivialReadOnlyExecution(ctx)
      ?? await verifyDeterministicWriteReadExecution(ctx);
    if (runtimeVerdict) return runtimeVerdict;
    let parsed: DecodedVerdict | null;
    try {
      parsed = await requestVerificationVerdict(deps, ctx, replanAttempts, maxReplan);
    } catch (error) {
      return routeKnownIncompleteExecution(
        ctx,
        replanAttempts,
        maxReplan,
        `verifier transport error: ${(error as Error).message}`,
        { transportError: (error as Error).message },
      );
    }

    if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'needs_replan' && parsed.verdict !== 'fail')) {
      return routeKnownIncompleteExecution(ctx, replanAttempts, maxReplan, 'verdict decode failed', { decodeFailure: true });
    }
    if (parsed.verdict === 'pass') {
      if (hasIncompleteTaskExecution(ctx)) {
        return routeKnownIncompleteExecution(
          ctx,
          replanAttempts,
          maxReplan,
          'verifier returned pass despite failed or missing step evidence',
          { structuralOverride: true },
        );
      }
      await recordVerification(ctx, {
        verdict: 'pass',
        reason: parsed.reason ?? 'Task contract satisfied.',
        usedMemoryAtomIds: acceptedUsedMemoryAtomIds(ctx, parsed.usedMemoryAtomIds),
        source: 'model',
      });
      publishVerifiedReply(ctx);
      return {
        stage: 'verify',
        next: 'evolve',
        ok: true,
        meta: { verdict: 'pass', reason: parsed.reason, replanAttempts },
      };
    }

    const targetStepIds = deriveReplanTargets(ctx, parsed.failedStepIds);
    const shouldPartialReplan = parsed.verdict === 'needs_replan'
      || (parsed.verdict === 'fail' && canRecoverWithPartialReplan(ctx, targetStepIds));
    if (parsed.verdict === 'fail' && !shouldPartialReplan) {
      const message = `verify failed: ${parsed.reason ?? 'tool error detected'}`;
      recordFailure(ctx, 'verify', 'verify', message);
      await recordVerification(ctx, {
        verdict: 'fail',
        reason: parsed.reason ?? 'Tool error detected.',
        failedStepIds: targetStepIds,
        source: 'model',
      });
      return {
        stage: 'verify',
        next: 'recover',
        ok: false,
        error: message,
        meta: { verdict: 'fail', reason: parsed.reason, failedStepIds: targetStepIds },
      };
    }

    const reason = parsed.reason ?? 'previous plan did not achieve the goal';
    const feedback = parsed.feedback ?? reason;
    if (replanAttempts >= maxReplan) return escalateExhaustedReplan(ctx, reason, feedback);

    const nextReplanAttempts = replanAttempts + 1;
    writeReplanState(ctx, 'verify', {
      replanAttempts: nextReplanAttempts,
      verifyFeedback: feedback,
    });
    if (ctx.taskBook && targetStepIds.length > 0) {
      installPartialReplan(ctx, targetStepIds, reason, feedback, nextReplanAttempts);
    }
    await recordVerification(ctx, {
      verdict: 'needs_replan',
      reason,
      feedback,
      failedStepIds: targetStepIds,
      source: 'model',
    });
    return {
      stage: 'verify',
      next: 'decide',
      ok: true,
      meta: {
        verdict: 'needs_replan',
        reason: parsed.reason,
        feedback: ctx.verifyFeedback,
        failedStepIds: targetStepIds,
        replanAttempts: ctx.replanAttempts,
      },
    };
  };
}
