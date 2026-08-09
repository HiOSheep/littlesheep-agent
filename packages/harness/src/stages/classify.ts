// @littlesheep/harness — stages/classify.ts
// CLASSIFY is retained as a compatibility boundary, but semantically it is a
// compact activity router: respond / execute / clarify.
//
// Design principle: "understanding is the agent's job, not the user's."
// Casual ambiguity should be classified as chat and handled naturally. The
// classifier reserves unclear for input with no actionable meaning, which is a
// first-class clarification request rather than an execution error.

import {
  activityFromMessageClass,
  type RunContext,
  type StageResult,
  type StageName,
} from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import { classify } from '@littlesheep/classifier';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
} from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { attachmentManifestText, recentHistoryForModel } from './_shared.js';
import { writeDecisionState } from '../decision-state.js';

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
      const classifierHistory = recentHistoryForModel(ctx.history, 4, 1_800);
      const manifest = attachmentManifestText(ctx.attachments);
      const classificationInbound = manifest
        ? { ...ctx.inbound, content: [...ctx.inbound.content, { type: 'text' as const, text: manifest }] }
        : ctx.inbound;
      const cls = await classify(classificationInbound, classifierHistory, {
        llm: deps.llm,
        model: deps.model,
        rulesConfidenceThreshold: deps.rulesConfidenceThreshold ?? 0.7,
        onRequest: (request) => prepareModelRequest(
          ctx,
          'classify',
          preferDirectModelOutput(ctx, request, { force: true }),
          buildRunRequestCandidates(ctx, 'classify', request.messages, { history: classifierHistory }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
      });
      const activity = cls.activity ?? activityFromMessageClass(cls.type);
      if (activity === 'execute') {
        writeDecisionState(ctx, 'classify', { classification: cls });
        next = 'decide';
      } else if (activity === 'clarify') {
        const originalRequest = inboundText(ctx);
        writeDecisionState(ctx, 'classify', {
          classification: cls,
          clarificationRequest: {
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
          },
        });
        next = 'ask_user';
      } else {
        writeDecisionState(ctx, 'classify', { classification: cls });
        next = 'reply';
      }
    } catch (err) {
      // Classifier never throws in practice, but defend against transport errors.
      writeDecisionState(ctx, 'classify', { classification: {
        activity: 'respond',
        type: 'chat',
        confidence: 0.3,
        source: 'llm',
        reason: `classify error: ${(err as Error).message}`,
      } });
      // A classifier transport failure is internal; do not make the user
      // clarify a message that may already be clear.
      next = 'reply';
    }
    return {
      stage: 'classify',
      next,
      ok: true,
      meta: {
        activity: ctx.classification?.activity
          ?? activityFromMessageClass(ctx.classification?.type),
        classification: ctx.classification,
      },
    };
  };
}
