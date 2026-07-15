// VERIFY orchestration facade over structural evidence and bounded recovery.
import type { ChatMessage } from '@littlesheep/llm';
import type { RunContext, StageResult } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { appendSystemPromptAddons } from '../profile-prompt.js';
import { callLlmForJson } from './_shared.js';
import {
  type DecodedVerdict,
  type VerifyStageDeps,
  VERIFY_SYSTEM_PROMPT,
} from './verify/contracts.js';
import { buildVerifyUserMessage } from './verify/evidence.js';
import {
  escalateExhaustedReplan,
  publishVerifiedReply,
  recordVerification,
  routeKnownIncompleteExecution,
} from './verify/routing.js';
import {
  canRecoverWithPartialReplan,
  deriveReplanTargets,
  hasIncompleteTaskExecution,
  installPartialReplan,
} from './verify/task-state.js';

export type { VerifyStageDeps } from './verify/contracts.js';

export function createVerifyStage(deps: VerifyStageDeps) {
  return async function verifyStage(ctx: RunContext): Promise<StageResult> {
    const replanAttempts = ctx.replanAttempts ?? 0;
    const maxReplan = ctx.maxReplanAttempts ?? 2;
    ctx.onToolEvent?.({ type: 'verification_start' });
    const messages: ChatMessage[] = [
      { role: 'system', content: appendSystemPromptAddons(VERIFY_SYSTEM_PROMPT, ctx.profilePromptAddon) },
      { role: 'user', content: buildVerifyUserMessage(ctx, replanAttempts, maxReplan) },
    ];

    let parsed: DecodedVerdict | null;
    try {
      ({ parsed } = await callLlmForJson<DecodedVerdict>(deps.llm, deps.model, messages, {
        maxAttempts: 2,
        maxTokens: 500,
        signal: ctx.signal,
        onRequest: (request) => prepareModelRequest(
          ctx,
          'verify',
          request,
          buildRunRequestCandidates(ctx, 'verify', request.messages, {
            history: [],
            primaryUserKind: 'workflow_state',
          }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
      }));
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
      recordVerification(ctx, {
        verdict: 'pass',
        reason: parsed.reason ?? 'Task contract satisfied.',
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
      ctx.lastError = {
        stage: 'verify',
        message: `verify failed: ${parsed.reason ?? 'tool error detected'}`,
      };
      recordVerification(ctx, {
        verdict: 'fail',
        reason: parsed.reason ?? 'Tool error detected.',
        failedStepIds: targetStepIds,
        source: 'model',
      });
      return {
        stage: 'verify',
        next: 'recover',
        ok: false,
        error: ctx.lastError.message,
        meta: { verdict: 'fail', reason: parsed.reason, failedStepIds: targetStepIds },
      };
    }

    const reason = parsed.reason ?? 'previous plan did not achieve the goal';
    const feedback = parsed.feedback ?? reason;
    if (replanAttempts >= maxReplan) return escalateExhaustedReplan(ctx, reason, feedback);

    ctx.replanAttempts = replanAttempts + 1;
    ctx.verifyFeedback = feedback;
    if (ctx.taskBook && targetStepIds.length > 0) {
      installPartialReplan(ctx, targetStepIds, reason, feedback, ctx.replanAttempts);
    }
    recordVerification(ctx, {
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
