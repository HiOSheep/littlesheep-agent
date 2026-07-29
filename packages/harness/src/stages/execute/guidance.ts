import type { ChatMessage } from '@littlesheep/llm';
import type {
  PlanStep,
  RunContext,
  TaskBook,
  TaskStepResult,
} from '@littlesheep/types';
import {
  attachmentContextMessages,
  recentHistoryForModel,
  textOf,
  toChatMessage,
  userChatMessage,
} from '../_shared.js';

export function renderPlanGuidance(plan: PlanStep[]): string {
  const lines = plan.map((step, index) => {
    const tools = step.tools && step.tools.length > 0 ? ` [tools: ${step.tools.join(', ')}]` : '';
    const approval = step.requiresApproval ? ' (needs approval)' : '';
    return `${index + 1}. ${step.description}${tools}${approval}`;
  });
  return `Proposed plan (from DECIDE):\n${lines.join('\n')}`;
}

export function renderTaskBookGuidance(taskBook: TaskBook): string {
  const criteria = taskBook.successCriteria.length > 0
    ? taskBook.successCriteria.map((item) => `- ${item}`).join('\n')
    : '- Satisfy the calibrated user goal.';
  const lines = taskBook.steps.map((step, index) => {
    const label = step.title ? `${step.title}: ` : '';
    const tools = step.tools && step.tools.length > 0 ? ` [tools: ${step.tools.join(', ')}]` : '';
    const approval = step.requiresApproval ? ' (needs approval)' : '';
    const stepCriteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
      ? `\n     acceptance: ${step.acceptanceCriteria.join('; ')}`
      : '';
    const expected = step.expectedOutput ? `\n     expected: ${step.expectedOutput}` : '';
    return `${index + 1}. ${label}${step.description}${tools}${approval}${stepCriteria}${expected}`;
  });
  return `Task book (from DECIDE):
Goal: ${taskBook.goal}
Complexity: ${taskBook.complexity}
Overdelivery limit: ${taskBook.overdeliveryPolicy.maxExtraScopeRatio}x
Overdelivery guidance: ${taskBook.overdeliveryPolicy.guidance}
Success criteria:
${criteria}

Steps:
${lines.join('\n')}

Execution rules:
- Keep work proportional to the calibrated complexity.
- Do not exceed the overdelivery limit; avoid doing broad extra work unless it directly improves the goal.
- When the task is trivial/simple, prefer the shortest sufficient route.
- When evidence is needed, use tools to verify before claiming success.`;
}

export function renderStepGuidance(
  taskBook: TaskBook,
  step: PlanStep,
  stepId: string,
  index: number,
  total: number,
  previousResults: TaskStepResult[],
): string {
  const criteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
    ? step.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
    : '- Complete the described step well enough to advance the task.';
  const previous = previousResults.length > 0
    ? previousResults.map((result, resultIndex) => (
        `${resultIndex + 1}. ${result.title ?? result.stepId}: ${truncateText(result.output ?? result.error ?? result.status, 600)}`
      )).join('\n')
    : '(none)';
  return `Step execution contract:
You are executing exactly one task-book step.
Task goal: ${taskBook.goal}
Current step: ${index + 1}/${total}
Step id: ${stepId}
Step title: ${step.title ?? '(untitled)'}
Step description: ${step.description}
Step acceptance criteria:
${criteria}
Expected output: ${step.expectedOutput ?? '(not specified)'}
Previous step results:
${previous}

Instructions:
- Complete only this step.
- Use tools when they reduce uncertainty or are required by the step.
- Request independent tool calls together; keep dependent calls in separate rounds.
- Return a concise step result when the step is complete. It may be shown to the user directly, so use the user's language, follow the active SOUL.md voice, preserve runtime facts, and do not expose private chain-of-thought.
- Do not claim the whole task is complete unless this is the final step.`;
}

export function buildBaseMessages(
  ctx: RunContext,
  systemMessage: string,
  attachments: ReturnType<typeof attachmentContextMessages>,
): ChatMessage[] {
  return [
    { role: 'system', content: systemMessage },
    ...recentHistoryForModel(ctx.history, 8).map(toChatMessage),
    ...attachments.map((item) => item.message),
    userChatMessage(textOf(ctx.inbound), ctx.attachments),
  ];
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}
