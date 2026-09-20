// VERIFY orchestration facade over Runtime-provable evidence and bounded recovery.
//
// There is no separate verification model call. Asking the same model to bless
// its own work added one more request with its own prompt shape (and its own
// cache prefix), and it could not prove anything the recorded evidence did not
// already show. VERIFY now asserts only what Runtime evidence proves:
//
// - a narrow structural pass (`pass`) for the read-only and write-then-read
//   shapes whose acceptance the code checks exactly;
// - every other completed run is recorded as `unverified`: the recorded facts
//   are complete and consistent, the Provider-authored reply exists, and the
//   acceptance criteria that need human judgement were not judged by anyone.
//
// Any recorded failure routes through the existing bounded recovery path, so a
// tool failure still cannot be turned into a claimed success.
import type { RunContext, StageResult } from '@littlesheep/types';
import {
  publishVerifiedReply,
  recordVerification,
  routeKnownIncompleteExecution,
  verifyDeterministicWriteReadExecution,
  verifyTrivialReadOnlyExecution,
} from './verify/routing.js';
import { runtimeExecutionEvidenceGap } from './verify/task-state.js';
import { textOf } from './_shared.js';

export function createVerifyStage() {
  return async function verifyStage(ctx: RunContext): Promise<StageResult> {
    const replanAttempts = ctx.replanAttempts ?? 0;
    const maxReplan = ctx.maxReplanAttempts ?? 2;
    ctx.onToolEvent?.({ type: 'verification_start', visibility: 'silent' });
    const runtimeVerdict = await verifyTrivialReadOnlyExecution(ctx)
      ?? await verifyDeterministicWriteReadExecution(ctx);
    if (runtimeVerdict) return runtimeVerdict;

    const evidenceGap = runtimeExecutionEvidenceGap(ctx);
    if (evidenceGap) {
      return routeKnownIncompleteExecution(
        ctx,
        replanAttempts,
        maxReplan,
        evidenceGap,
        { runtimeEvidenceGap: evidenceGap },
      );
    }
    if (!ctx.reply?.trim() || ctx.replyProvenance?.source !== 'llm') {
      // No Provider-authored reply means nothing user-visible can be settled;
      // this is an execution gap, not an unverified criterion.
      return routeKnownIncompleteExecution(
        ctx,
        replanAttempts,
        maxReplan,
        'no Provider-authored reply exists for this run',
        { missingReply: true },
      );
    }

    const reason = unverifiedAcceptanceReason(ctx);
    await recordVerification(ctx, { verdict: 'unverified', reason, source: 'structural' });
    publishVerifiedReply(ctx);
    return {
      stage: 'verify',
      next: 'evolve',
      ok: true,
      meta: { verdict: 'unverified', runtimeEvidenceComplete: true, reason },
    };
  };
}

function unverifiedAcceptanceReason(ctx: RunContext): string {
  const chinese = /[\u3400-\u9fff]/u.test(textOf(ctx.inbound));
  return chinese
    ? 'Runtime 已确认记录的工具证据完整、全部调用成功，且存在模型回复；需要人工判断的验收标准未经验证。'
    : 'Runtime confirmed the recorded tool evidence is complete, every call succeeded and a Provider-authored reply exists; acceptance criteria that need human judgement are not verified.';
}
