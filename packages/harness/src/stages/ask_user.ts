// @littlesheep/harness — stages/ask_user.ts
// ASK_USER: unclear intent (CLASSIFY) or escalation (RECOVER). Produces a
// clarifying question to send back to the user. The runtime supplies facts;
// the final wording must come from the model and active SOUL.

import type {
  ClarificationRequest,
  ClarificationChain,
  RunContext,
  StageResult,
  StageName,
} from '@littlesheep/types';
import { filterAuthoritativeUserFacingMessages } from '@littlesheep/types';
import type { ChatRequest, LlmClient } from '@littlesheep/llm';
import { buildRunRequestCandidates } from '../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  callModelChat,
} from '../model-observability.js';
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from '../profile-prompt.js';
import { textOf } from './_shared.js';
import { publishUserFacingReply } from '../user-facing-reply.js';
import { clearReplyState } from '../reply-state.js';
import { renderClarificationMessage } from './clarification-message.js';
import { updateClarificationRequest, writeDecisionState } from '../decision-state.js';
import { recordFailure } from '../failure-state.js';

export interface AskUserStageDeps {
  llm: LlmClient;
  model: string;
}

/**
 * Factory: creates an ask_user stage.
 *
 * Two origins reach this stage, and they must not be confused:
 *
 * - The model asked the user something through `request_user_input`. Its wording
 *   is already published-quality and already has a Provider request behind it,
 *   so this stage publishes it as-is. Asking the model to word the same question
 *   again was a second Provider request for text that already existed.
 * - The Runtime escalated (a permission denial, an exhausted recovery budget).
 *   There is no model question, so one bounded wording call composes the user
 *   explanation. If that call returns nothing, the turn fails loudly: Runtime
 *   -authored text is never published as if the model had written it.
 */
export function createAskUserStage(deps?: AskUserStageDeps) {
  return async function askUserStage(ctx: RunContext): Promise<StageResult> {
    clearReplyState(ctx, 'ask_user');
    const request = attachClarificationChain(ctx, ensureClarificationRequest(ctx));
    writeDecisionState(ctx, 'ask_user', { clarificationRequest: request });
    // The wording the model already produced, with the request that proves it.
    const modelAuthored = modelAuthoredQuestion(request);
    const draft = renderClarificationMessage(request);
    if (!deps && !modelAuthored) {
      const message = 'user-facing clarification generation requires an LLM.';
      recordFailure(ctx, 'ask_user', 'ask_user', message);
      return { stage: 'ask_user', next: 'exit', ok: false, error: message };
    }

    try {
      const question = modelAuthored
        ? await publishModelAuthoredQuestion(ctx, modelAuthored)
        : await publishComposedClarification(deps!, ctx, request, draft);
      updateClarificationRequest(ctx, 'ask_user', (value) => ({
        ...value,
        prompt: question,
        copySource: 'model',
      }));
    } catch (error) {
      const message = `user-facing clarification generation failed: ${(error as Error).message}`;
      recordFailure(ctx, 'ask_user', 'ask_user', message);
      return { stage: 'ask_user', next: 'exit', ok: false, error: message };
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

/**
 * The model's own question, when one exists.
 *
 * Both facts are required: the wording and the request that authored it. A
 * runtime draft has no request id, which is what keeps it from being published
 * through the model-reply boundary.
 */
function modelAuthoredQuestion(
  request: ClarificationRequest,
): { text: string; modelRequestId: string } | undefined {
  const text = request.prompt?.trim();
  const modelRequestId = request.copyModelRequestId;
  if (request.copySource !== 'model' || !text || !modelRequestId) return undefined;
  return { text, modelRequestId };
}

async function publishModelAuthoredQuestion(
  ctx: RunContext,
  question: { text: string; modelRequestId: string },
): Promise<string> {
  const published = await publishUserFacingReply(
    ctx,
    'execute_tool_loop',
    question.text,
    'ask_user',
    question.modelRequestId,
  );
  if (!published) {
    throw new Error('the clarification settlement already holds a different message');
  }
  return published;
}

async function publishComposedClarification(
  deps: AskUserStageDeps,
  ctx: RunContext,
  request: ClarificationRequest,
  draft: string,
): Promise<string> {
  const composed = await composeClarificationMessage(deps, ctx, request, draft);
  if (!composed.trim()) {
    // The model produced no visible text twice. There is no model-authored
    // question to publish, and the runtime draft is not one: fail so the run
    // reports a Runtime error instead of showing fixed wording as an Agent
    // reply.
    throw new Error('the clarification model produced no visible text after two attempts');
  }
  const published = await publishUserFacingReply(ctx, 'ask_user', composed);
  if (!published) {
    throw new Error('the clarification settlement already holds a different message');
  }
  return published;
}

/**
 * Compose the user explanation for a Runtime escalation.
 *
 * Returns empty when the model produced no visible text: the caller fails the
 * turn rather than publishing the runtime draft. The draft stays a Runtime fact
 * (it is the request's own `blockingReason` and question text) and the UI can
 * show it as Runtime status; it must not become the Agent's reply.
 */
async function composeClarificationMessage(
  deps: AskUserStageDeps,
  ctx: RunContext,
  request: ClarificationRequest,
  runtimeDraft: string,
): Promise<string> {
  const system = appendSystemPromptAddons(
    `You are the ASK_USER stage of a hard-control-flow agent. Compose one concise, actionable clarification message for the user from the supplied runtime facts. Return only the message text, with no preamble or JSON. Preserve every option and required decision; do not add facts, risks, permissions, paths or claims that are not present in the input.`,
    { id: 'user-facing-voice', text: buildUserFacingVoiceAddon(ctx) },
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
        clarificationChain: request.clarificationChain,
        runtimeDraft,
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
      temperature: 0.65,
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
    const response = await callModelChat(ctx, deps.llm, prepared);
    if (response.content.trim()) return response.content;
    maxTokens = 640;
  }
  return '';
}

function attachClarificationChain(
  ctx: RunContext,
  request: ClarificationRequest,
): ClarificationRequest {
  const response = ctx.clarificationResponse;
  if (!response) return request;
  const prior = [...filterAuthoritativeUserFacingMessages(ctx.history)]
    .reverse()
    .find((message) => (
      message.role === 'assistant'
      && message.clarificationRequest?.id === response.requestId
    ))
    ?.clarificationRequest;
  const remainingFields = [...new Set(request.questions.map((question) => boundedField(question.field)))].slice(0, 16);
  const remaining = new Set(remainingFields);
  const answeredFields = [...new Set((prior?.questions ?? [])
    .map((question) => boundedField(question.field))
    .filter((field) => !remaining.has(field)))].slice(0, 16);
  const failureStage = clarificationFailureStage(ctx.lastError?.stage);
  const chain: ClarificationChain = {
    version: 1,
    previousRequestId: response.requestId.slice(0, 512),
    ...(prior?.sourceStage ? { previousSourceStage: prior.sourceStage } : {}),
    answeredAt: response.answeredAt,
    answeredFields,
    remainingFields,
    ...(ctx.taskBook?.goal ? { taskGoal: ctx.taskBook.goal.slice(0, 1_024) } : {}),
    ...(failureStage ? { failureStage } : {}),
    attachmentCount: Math.min(64, ctx.attachments?.length ?? 0),
    ...(ctx.resolvedRunConfig?.permissionPolicyId
      ? { permissionPolicyId: ctx.resolvedRunConfig.permissionPolicyId }
      : {}),
  };
  return {
    ...request,
    id: request.id === response.requestId ? `${request.id}:follow-up` : request.id,
    clarificationChain: chain,
  };
}

function clarificationFailureStage(
  stage: StageName | undefined,
): ClarificationChain['failureStage'] | undefined {
  if (stage === 'classify' || stage === 'decide' || stage === 'execute' || stage === 'recover' || stage === 'verify') {
    return stage;
  }
  return undefined;
}

function boundedField(value: string): string {
  return value.trim().slice(0, 128);
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
