// Owns legacy and TaskBook execution orchestration; delegates tool loops, failure policy, and final reply synthesis.
import type { SystemPromptBundle } from '@littlesheep/prompt';
import { appendSystemPromptBundleAddons, buildUserFacingVoiceAddon } from '../../profile-prompt.js';
import type {
  RunContext,
  StageResult,
} from '@littlesheep/types';
import { attachmentContextMessages, recentHistoryForModel } from '../_shared.js';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import { buildBaseMessages } from './guidance.js';
import { applyUsage, runToolLoop } from './tool-loop.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../../user-facing-reply.js';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../../model-observability.js';
export { executeTaskBook } from './task-book-runner.js';

export async function executeLegacyLoop(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  sanitizeOpts: ExecuteSanitizeOptions,
): Promise<StageResult> {
  const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
  const result = await runToolLoop(deps, {
    ctx,
    messages: buildBaseMessages(ctx, systemPrompt.text, attachmentMessages),
    tools: ctx.tools,
    sanitizeOpts,
    systemSegments: systemPrompt.segments,
    insertedBeforePrimary: attachmentMessages.map((item) => item.context),
  });
  ctx.toolResults = result.toolResults;
  if (!result.ok) {
    ctx.lastError = { stage: 'execute', message: result.error ?? 'execute failed' };
    return { stage: 'execute', next: 'recover', ok: false, error: ctx.lastError.message };
  }
  applyUsage(ctx, result.usage);
  try {
    ctx.reply = await acceptUniqueUserFacingReply(
      ctx,
      'execute_tool_loop',
      result.content,
      (input) => rewriteLegacyExecutionReply(deps, ctx, systemPrompt, input),
    );
  } catch (error) {
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;
    ctx.lastError = { stage: 'execute', message: `user-facing execution reply generation failed: ${(error as Error).message}` };
    return { stage: 'execute', next: 'recover', ok: false, error: ctx.lastError.message };
  }
  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: { iterations: result.iterations, toolCalls: result.toolResults.length },
  };
}

async function rewriteLegacyExecutionReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  input: ReplyRewriteInput,
): Promise<string> {
  const rewrittenSystem = appendSystemPromptBundleAddons(systemPrompt, [{
    id: 'user-facing-rewrite',
    text: `${buildUserFacingVoiceAddon(ctx)}\n\nThe prior API-generated response exactly repeats a previously published LS reply. Generate the answer again with a genuinely different opening and sentence structure. Preserve runtime facts, execution status, evidence and uncertainty. Do not mention the regeneration. Return only the user-facing reply.`,
  }]);
  const attachments = attachmentContextMessages(ctx.runId, ctx.attachments);
  const rawRequest = {
    model: deps.model,
    messages: [
      ...buildBaseMessages(ctx, rewrittenSystem.text, attachments),
      {
        role: 'user' as const,
        content: `Prior API-generated response:\n${input.generatedReply}\n\nRecent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
      },
    ],
    temperature: 0.75,
    max_tokens: 4_096,
    signal: ctx.signal,
  } satisfies import('@littlesheep/llm').ChatRequest;
  const request = prepareModelRequest(
    ctx,
    'execute_tool_loop',
    rawRequest,
    buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
      history: recentHistoryForModel(ctx.history, 8),
      systemSegments: rewrittenSystem.segments,
      insertedBeforePrimary: attachments.map((item) => item.context),
    }),
  );
  const response = await deps.llm.chat(request);
  recordProviderUsage(ctx, request, response.usage);
  applyUsage(ctx, response.usage);
  return response.content;
}
