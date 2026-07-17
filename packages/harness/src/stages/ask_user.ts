// @littlesheep/harness — stages/ask_user.ts
// ASK_USER: unclear intent (CLASSIFY) or escalation (RECOVER). Produces a
// clarifying question to send back to the user. Prefers an LLM-generated
// question; falls back to a templated question on LLM failure.

import type {
  ClarificationQuestion,
  ClarificationRequest,
  RunContext,
  StageResult,
} from '@littlesheep/types';
import type { ChatRequest, LlmClient } from '@littlesheep/llm';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from '../profile-prompt.js';
import { textOf } from './_shared.js';

export interface AskUserStageDeps {
  llm: LlmClient;
  model: string;
}

/**
 * Factory: creates an ask_user stage.
 *
 * DECIDE-authored clarification requests already contain model-written copy,
 * so they are rendered without another call. Runtime-generated requests get
 * one bounded composition call when a provider is available; the deterministic
 * renderer remains the explicit degraded fallback for offline/error cases.
 */
export function createAskUserStage(deps?: AskUserStageDeps) {
  return async function askUserStage(ctx: RunContext): Promise<StageResult> {
    const request = ensureClarificationRequest(ctx);
    const fallback = renderClarificationMessage(request);
    const existingPrompt = request.prompt?.trim();
    const question = existingPrompt
      || (request.copySource === 'model' || !deps
        ? fallback
        : await composeClarificationMessage(deps, ctx, request, fallback));

    request.prompt = question;
    ctx.clarificationRequest = request;
    ctx.reply = question;
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
): Promise<string> {
  const rawRequest = {
    model: deps.model,
    messages: [
      {
        role: 'system',
        content: appendSystemPromptAddons(
          `You are the ASK_USER stage of a hard-control-flow agent. Compose one concise, actionable clarification message for the user from the supplied runtime facts. Return only the message text, with no preamble or JSON. Preserve every option and required decision; do not add facts, risks, permissions, paths or claims that are not present in the input.`,
          buildUserFacingVoiceAddon(ctx),
        ),
      },
      {
        role: 'user',
        content: JSON.stringify({
          originalRequest: request.originalRequest,
          blockingReason: request.blockingReason,
          questions: request.questions,
        }),
      },
    ],
    temperature: 0.45,
    max_tokens: 500,
    signal: ctx.signal,
  } satisfies ChatRequest;

  try {
    const prepared = prepareModelRequest(
      ctx,
      'ask_user',
      rawRequest,
      buildRunRequestCandidates(ctx, 'ask_user', rawRequest.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    );
    const response = await deps.llm.chat(prepared);
    recordProviderUsage(ctx, prepared, response.usage);
    if (response.usage) {
      ctx.usage = {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens ?? response.usage.promptTokens + response.usage.completionTokens,
        source: 'provider',
      };
    }
    const content = response.content.trim();
    if (content) {
      request.copySource = 'model';
      return content;
    }
  } catch {
    // Keep the request actionable when the optional composition call fails.
  }
  return fallback;
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

function renderClarificationMessage(request: ClarificationRequest): string {
  const chinese = usesChinese(request.originalRequest)
    || request.questions.some((question) => usesChinese(question.prompt));
  const reason = request.blockingReason.trim();
  if (request.questions.length === 1) {
    const question = formatQuestion(request.questions[0]!, chinese);
    return reason.length > 0 ? `${reason}\n\n${question}` : question;
  }
  const heading = chinese ? '继续前还需要你补充以下信息：' : 'I need the following information before continuing:';
  const questions = `${heading}\n${request.questions
    .map((question, index) => `${index + 1}. ${formatQuestion(question, chinese)}`)
    .join('\n')}`;
  return reason.length > 0 ? `${reason}\n\n${questions}` : questions;
}

function formatQuestion(question: ClarificationQuestion, chinese: boolean): string {
  const suffix: string[] = [];
  if (question.options?.length) {
    suffix.push(chinese ? `可选：${question.options.join('、')}` : `Options: ${question.options.join(', ')}`);
  }
  if (question.defaultValue) {
    suffix.push(chinese ? `默认：${question.defaultValue}` : `Default: ${question.defaultValue}`);
  }
  return suffix.length > 0 ? `${question.prompt}（${suffix.join('；')}）` : question.prompt;
}

function usesChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}
