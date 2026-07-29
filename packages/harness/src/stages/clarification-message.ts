import type { ClarificationQuestion, ClarificationRequest } from '@littlesheep/types';

/** Assemble model-authored clarification facts into the exact visible text. */
export function renderClarificationMessage(request: ClarificationRequest): string {
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
