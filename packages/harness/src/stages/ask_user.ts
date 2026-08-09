// @littlesheep/harness — stages/ask_user.ts
// ASK_USER: unclear intent (CLASSIFY) or escalation (RECOVER). Produces a
// clarifying question to send back to the user. The runtime supplies facts;
// the final wording must come from the model and active SOUL.

import type {
  ClarificationRequest,
  RunContext,
  StageResult,
} from '@littlesheep/types';
import type { ChatRequest, LlmClient } from '@littlesheep/llm';
import { buildRunRequestCandidates } from '../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
} from '../model-observability.js';
import { writeProviderUsageState } from '../usage-state.js';
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from '../profile-prompt.js';
import { textOf } from './_shared.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../user-facing-reply.js';
import { clearReplyState } from '../reply-state.js';
import { renderClarificationMessage } from './clarification-message.js';
import { updateClarificationRequest, writeDecisionState } from '../decision-state.js';

export interface AskUserStageDeps {
  llm: LlmClient;
  model: string;
}

/**
 * Factory: creates an ask_user stage.
 *
 * Structured clarification facts may originate in DECIDE or Runtime, but the
 * final text shown to the user is always composed in this stage by the model.
 */
export function createAskUserStage(deps?: AskUserStageDeps) {
  return async function askUserStage(ctx: RunContext): Promise<StageResult> {
    clearReplyState(ctx, 'ask_user');
    const request = ensureClarificationRequest(ctx);
    if (!ctx.clarificationRequest) {
      writeDecisionState(ctx, 'ask_user', { clarificationRequest: request });
    }
    const fallback = renderClarificationMessage(request);
    if (!deps) {
      ctx.lastError = { stage: 'ask_user', message: 'user-facing clarification generation requires an LLM.' };
      return { stage: 'ask_user', next: 'exit', ok: false, error: ctx.lastError.message };
    }

    try {
      const question = await acceptUniqueUserFacingReply(
        ctx,
        'ask_user',
        await composeClarificationMessage(deps, ctx, request, fallback),
        (input) => composeClarificationMessage(deps, ctx, request, fallback, input),
      );
      updateClarificationRequest(ctx, 'ask_user', (value) => ({
        ...value,
        prompt: question,
        copySource: 'model',
      }));
    } catch (error) {
      ctx.lastError = { stage: 'ask_user', message: `user-facing clarification generation failed: ${(error as Error).message}` };
      return { stage: 'ask_user', next: 'exit', ok: false, error: ctx.lastError.message };
    }
    return {
      stage: 'ask_user',
      next: 'finalize',
      ok: true,
      meta: {
        escalated: request.kind === 'recovery_decision',
        clarificationRequestId: request.id,
        questionCount: request.questions.length,
      },
    };
  };
}

async function composeClarificationMessage(
  deps: AskUserStageDeps,
  ctx: RunContext,
  request: ClarificationRequest,
  fallback: string,
  rewrite?: ReplyRewriteInput,
): Promise<string> {
  const system = appendSystemPromptAddons(
    `You are the ASK_USER stage of a hard-control-flow agent. Compose one concise, actionable clarification message for the user from the supplied runtime facts. Return only the message text, with no preamble or JSON. Preserve every option and required decision; do not add facts, risks, permissions, paths or claims that are not present in the input.`,
    buildUserFacingVoiceAddon(ctx),
    rewrite
      ? `The prior API-generated response exactly repeats a previously published LS reply. Generate the clarification again with a genuinely different opening and sentence structure while preserving every runtime fact. Do not mention the regeneration. Prior response:\n${rewrite.generatedReply}\nRecent replies to avoid repeating exactly:\n${rewrite.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`
      : undefined,
  );
  const baseMessages: ChatRequest['messages'] = [
    {
      role: 'system',
      content: system,
    },
    {
      role: 'user',
      content: JSON.stringify({
        originalRequest: request.originalRequest,
        blockingReason: request.blockingReason,
        questions: request.questions,
        runtimeDraft: fallback,
      }),
    },
  ];
  let maxTokens = 320;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const messages = attempt === 1
      ? baseMessages
      : [
          ...baseMessages,
          {
            role: 'user' as const,
            content: 'The previous response contained no visible text. Return one concise user-facing clarification now; keep private reasoning bounded.',
          },
        ];
    const rawRequest = {
      model: deps.model,
      messages,
      temperature: rewrite ? 0.75 : 0.65,
      max_tokens: maxTokens,
      signal: ctx.signal,
    } satisfies ChatRequest;

    const prepared = prepareModelRequest(
      ctx,
      'ask_user',
      // Clarification copy is a bounded wording task, not another reasoning
      // phase. Keep it direct even when the run itself uses high reasoning.
      preferDirectModelOutput(ctx, rawRequest, { force: true }),
      buildRunRequestCandidates(ctx, 'ask_user', rawRequest.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    );
    const response = await deps.llm.chat(prepared);
    recordProviderUsage(ctx, prepared, response.usage);
    writeProviderUsageState(ctx, 'ask_user', response.usage);
    if (response.content.trim()) return response.content;
    maxTokens = 640;
  }
  return '';
}

function ensureClarificationRequest(ctx: RunContext): ClarificationRequest {
  if (ctx.clarificationRequest) return ctx.clarificationRequest;

  const originalRequest = textOf(ctx.inbound).slice(0, 500);
  if (ctx.lastError) {
    return {
      id: `${ctx.runId}:clarification`,
      kind: 'recovery_decision',
      sourceStage: ctx.lastError.stage === 'verify' ? 'verify'
        : ctx.lastError.stage === 'execute' ? 'execute'
          : 'recover',
      createdAt: new Date().toISOString(),
      originalRequest,
      copySource: 'runtime_fallback',
      blockingReason: `${ctx.lastError.stage}: ${ctx.lastError.message}`,
      questions: [{
        id: 'question-1',
        field: 'recoveryDecision',
        prompt: usesChinese(originalRequest)
          ? '执行遇到问题后，你希望我如何继续？'
          : 'How would you like me to proceed after the execution problem?',
        required: true,
      }],
    };
  }

  return {
    id: `${ctx.runId}:clarification`,
    kind: 'ambiguous_request',
    sourceStage: 'classify',
    createdAt: new Date().toISOString(),
    originalRequest,
    copySource: 'runtime_fallback',
    blockingReason: usesChinese(originalRequest)
      ? '当前信息不足以确定下一步。'
      : 'There is not enough information to determine the next action.',
    questions: [{
      id: 'question-1',
      field: 'intent',
      prompt: usesChinese(originalRequest)
        ? '请补充你希望 LS 完成的具体事情。'
        : 'What would you like LS to accomplish?',
      required: true,
    }],
  };
}

function usesChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}
