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
// Any recorded negative outcome keeps the verdict at `unverified`: the run's own
// failed calls are evidence the runtime reports, never something recovery may
// retry away or the model may claim as a pass.
import type { RunContext, StageResult } from '@littlesheep/types';
import {
  publishVerifiedReply,
  recordVerification,
  routeKnownIncompleteExecution,
  verifyDeterministicWriteReadExecution,
  verifyTrivialReadOnlyExecution,
} from './verify/routing.js';
import { recordedToolFailures, runtimeExecutionEvidenceGap } from './verify/task-state.js';
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

    // A run that recorded failed calls still publishes its answer: the failure is
    // a known outcome, not missing evidence. It only loses the right to `pass`,
    // and retrying it automatically re-sent the whole context for a re-plan the
    // model had already answered (measured: two extra requests per turn, and the
    // recovered attempt rebuilt a shorter prompt, which cost cache reuse).
    const recordedFailures = recordedToolFailures(ctx);
    if (recordedFailures.length > 0) {
      const reason = recordedFailureReason(ctx, recordedFailures);
      await recordVerification(ctx, { verdict: 'unverified', reason, source: 'structural' });
      publishVerifiedReply(ctx);
      return {
        stage: 'verify',
        next: 'finalize',
        ok: true,
        meta: { verdict: 'unverified', runtimeEvidenceComplete: true, recordedFailures },
      };
    }

    const reason = unverifiedAcceptanceReason(ctx);
    await recordVerification(ctx, { verdict: 'unverified', reason, source: 'structural' });
    publishVerifiedReply(ctx);
    return {
      stage: 'verify',
      next: 'finalize',
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

function recordedFailureReason(ctx: RunContext, failures: readonly string[]): string {
  const chinese = /[\u3400-\u9fff]/u.test(textOf(ctx.inbound));
  const detail = failures.slice(0, 3).join('; ');
  const more = failures.length > 3 ? ` (+${failures.length - 3})` : '';
  return chinese
    ? `本次运行记录了失败结果（${detail}${more}）：证据已保留、模型回复已发布，因此不能判定为 pass，需要人工判断的验收标准也未经验证。`
    : `This run recorded failed results (${detail}${more}): the evidence and the Provider-authored reply are kept, so the run cannot be a pass and acceptance criteria that need human judgement are not verified.`;
}
