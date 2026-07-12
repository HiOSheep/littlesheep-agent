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
import { textOf } from './_shared.js';

/** Factory: creates an ask_user stage. No extra LLM call is needed because the
 * clarification contract already contains user-facing prompts. */
export function createAskUserStage() {
  return async function askUserStage(ctx: RunContext): Promise<StageResult> {
    const request = ensureClarificationRequest(ctx);
    const question = renderClarificationMessage(request);

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
