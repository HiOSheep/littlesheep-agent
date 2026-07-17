// @littlesheep/harness — stages/classify.ts
// CLASSIFY: rule fast path + LLM fallback. Writes ctx.classification and
// routes to reply (chat) / decide (problem) / ask_user (truly unclear).
//
// Design principle: "understanding is the agent's job, not the user's."
// Casual ambiguity should be classified as chat and handled naturally. The
// classifier reserves unclear for input with no actionable meaning, which is a
// first-class clarification request rather than an execution error.

import type { RunContext, StageResult, StageName } from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import { classify } from '@littlesheep/classifier';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { attachmentManifestText } from './_shared.js';

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export interface ClassifyStageDeps {
  llm: LlmClient;
  model: string;
  /** Rules confidence threshold to bypass LLM. Default 0.7. */
  rulesConfidenceThreshold?: number;
}

/** Factory: creates a classify stage that closes over the LLM deps. */
export function createClassifyStage(deps: ClassifyStageDeps) {
  return async function classifyStage(ctx: RunContext): Promise<StageResult> {
    let next: StageName;
    try {
      const classifierHistory = ctx.history.slice(-5);
      const manifest = attachmentManifestText(ctx.attachments);
      const classificationInbound = manifest
        ? { ...ctx.inbound, content: [...ctx.inbound.content, { type: 'text' as const, text: manifest }] }
        : ctx.inbound;
      const cls = await classify(classificationInbound, ctx.history, {
        llm: deps.llm,
        model: deps.model,
        rulesConfidenceThreshold: deps.rulesConfidenceThreshold ?? 0.7,
        onRequest: (request) => prepareModelRequest(
          ctx,
          'classify',
          request,
          buildRunRequestCandidates(ctx, 'classify', request.messages, { history: classifierHistory }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
      });
      ctx.classification = cls;
      if (cls.type === 'problem') {
        next = 'decide';
      } else if (cls.type === 'unclear') {
        const originalRequest = inboundText(ctx);
        ctx.clarificationRequest = {
          id: `${ctx.runId}:clarification`,
          kind: 'ambiguous_request',
          sourceStage: 'classify',
          createdAt: new Date().toISOString(),
          originalRequest,
          copySource: 'runtime_fallback',
          blockingReason: /[\u3400-\u9fff]/u.test(originalRequest)
            ? '当前消息不足以判断一个安全、明确的下一步。'
            : 'The message does not contain enough meaning to identify a safe next action.',
          questions: [{
            id: 'question-1',
            field: 'intent',
            prompt: /[\u3400-\u9fff]/u.test(originalRequest)
              ? '请补充你希望 LS 帮你完成的具体事情。'
              : 'What would you like LS to help you accomplish?',
            required: true,
          }],
        };
        next = 'ask_user';
      } else {
        next = 'reply';
      }
    } catch (err) {
      // Classifier never throws in practice, but defend against transport errors.
      ctx.classification = {
        type: 'unclear',
        confidence: 0.3,
        source: 'llm',
        reason: `classify error: ${(err as Error).message}`,
      };
      // A classifier transport failure is internal; do not make the user
      // clarify a message that may already be clear.
      next = 'reply';
    }
    return {
      stage: 'classify',
      next,
      ok: true,
      meta: { classification: ctx.classification },
    };
  };
}
