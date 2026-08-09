import type { RunContext, TaskBook, TaskStepResult } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
} from '../../model-observability.js';
import {
  appendSystemPromptAddons,
  buildCompactBehaviorProfileAddon,
  buildCompactUserFacingVoiceAddon,
  buildUserFacingVoiceAddon,
} from '../../profile-prompt.js';
import { textOf } from '../_shared.js';
import type { ExecuteStageDeps } from './contracts.js';
import { applyUsage } from './tool-loop.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../../user-facing-reply.js';
import { isCompactReadOnlyResult } from '../../compact-read-only-result.js';

export async function synthesizeFinalReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  taskBook: TaskBook,
  stepResults: TaskStepResult[],
  replyStage: 'execute' | 'reply' = 'execute',
): Promise<string> {
  const compact = isCompactReadOnlyResult(ctx, taskBook, stepResults);
  const stepSummary = stepResults.map((step, index) =>
    `${index + 1}. ${step.title ?? step.stepId} [${step.status}]\n`
    + `Description: ${step.description}\n`
    + `Output: ${step.output ?? '(no output)'}\n`
    + (step.error ? `Error: ${step.error}\n` : ''),
  ).join('\n');
  const voiceSystemPrompt = appendSystemPromptAddons(
    compact
      ? `Write the final LS reply for one completed Runtime-validated read-only tool call. Answer exactly what the user asked, in the user's language. Preserve supplied facts, truncation, and uncertainty; invent nothing and omit internal workflow. Return only the concise reply.`
      : `You are the final response assembler. Produce the final user-facing answer from completed task-book step results.
Follow progressive disclosure: lead with the outcome and completion status, then give key results, artifacts, evidence, and the next action only when useful. Keep detail proportional to the user's request; simple tasks should not become reports. Do not dump raw command output or private chain-of-thought. Never hide failed or partial steps, permission denials, risks, uncertainty, external side effects, or decisions required from the user. Do not claim failed steps succeeded.`,
    compact ? buildCompactBehaviorProfileAddon(ctx) : ctx.profilePromptAddon,
    ctx.reasoningPromptAddon,
    compact ? buildCompactUserFacingVoiceAddon(ctx) : buildUserFacingVoiceAddon(ctx),
  );

  const requestFinalReply = async (rewrite?: ReplyRewriteInput): Promise<string> => {
    const rawRequest = {
      model: deps.model,
      messages: [
        {
          role: 'system',
          content: rewrite
            ? `${voiceSystemPrompt}\n\nRegeneration contract:\n- The prior API-generated response exactly repeats a previously published LS reply.\n- Generate the final answer again with a genuinely different opening and sentence structure.\n- Preserve every runtime fact, result, failure, permission decision and uncertainty.\n- Do not mention the regeneration or comparison.\n- Return only the final user-facing answer.`
            : voiceSystemPrompt,
        },
        {
          role: 'user',
          content: [
            compact
              ? `Request: ${textOf(ctx.inbound)}\n\n`
                + `Verified ${taskBook.steps[0]!.toolProposal!.name} result:\n${stepResults[0]!.output}\n\n`
                + 'Reply only.'
              : `Original request:\n${textOf(ctx.inbound)}\n\n`
                + `Task goal:\n${taskBook.goal}\n\n`
                + `Success criteria:\n${taskBook.successCriteria.map((item) => `- ${item}`).join('\n')}\n\n`
                + `Step results:\n${stepSummary}\n\n`
                + `Write the final reply in the user's language.`,
            ...(rewrite ? [
              `Prior API-generated response:\n${rewrite.generatedReply}`,
              `Recent replies to avoid repeating exactly:\n${rewrite.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
            ] : []),
          ].join('\n\n'),
        },
      ],
      temperature: rewrite ? 0.75 : 0.65,
      max_tokens: compact ? 300 : 900,
      signal: ctx.signal,
    } satisfies import('@littlesheep/llm').ChatRequest;
    const request = prepareModelRequest(
      ctx,
      'execute_final_reply',
      preferDirectModelOutput(ctx, rawRequest, { force: true }),
      buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    );
    const response = await deps.llm.chat(request);
    recordProviderUsage(ctx, request, response.usage);
    applyUsage(ctx, response.usage);
    return response.content;
  };

  const initial = await requestFinalReply();
  return acceptUniqueUserFacingReply(
    ctx,
    'execute_final_reply',
    initial,
    requestFinalReply,
    replyStage,
  );
}
