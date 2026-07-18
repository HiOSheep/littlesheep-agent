// @littlesheep/harness — stages/reply.ts
// REPLY: chat-classified messages get a simple LLM reply (no tools).

import type { RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage, ChatRequest } from '@littlesheep/llm';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import { attachmentContextMessages, toChatMessage, textOf, userChatMessage } from './_shared.js';
import { appendSystemPromptBundleAddons, buildUserFacingVoiceAddon } from '../profile-prompt.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../user-facing-reply.js';

export interface ReplyStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
}

/** Factory: creates a reply stage. */
export function createReplyStage(deps: ReplyStageDeps) {
  return async function replyStage(ctx: RunContext): Promise<StageResult> {
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;
    const resolved = resolvePromptConfig(deps.config, deps.branding);
    // Use 'full' mode so output directives (language, conciseness) apply to chat replies.
    // 'minimal' mode skips outputDirectivesSection, causing language/conciseness issues.
    const baseSystemPrompt = await assembleSystemPromptBundle(resolved, {
      tools: ctx.tools,
      bootstrap: ctx.bootstrap ?? {},
      prelude: ctx.prelude,
      sessionSummary: ctx.sessionSummary,
      memoryRootIndex: ctx.memoryRootIndex,
      initialMemoryContext: ctx.initialMemoryContext,
    }, 'full');
    const systemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [
      { id: 'profile', text: ctx.profilePromptAddon },
      { id: 'reasoning', text: ctx.reasoningPromptAddon },
      { id: 'user-facing-voice', text: buildUserFacingVoiceAddon(ctx) },
    ]);

    const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt.text,
      },
      ...ctx.history.map(toChatMessage),
      ...attachmentMessages.map((item) => item.message),
      userChatMessage(textOf(ctx.inbound), ctx.attachments),
    ];

    let reply: string;
    try {
      const stream = ctx.onAssistantDelta !== undefined;
      const rawRequest = {
        model: deps.model,
        messages,
        temperature: 0.7,
        signal: ctx.signal,
        stream,
      } satisfies ChatRequest;
      const req = prepareModelRequest(
        ctx,
        'reply',
        rawRequest,
        buildRunRequestCandidates(ctx, 'reply', rawRequest.messages, {
          systemSegments: systemPrompt.segments,
          insertedBeforePrimary: attachmentMessages.map((item) => item.context),
        }),
      );
      let streamed = '';
      const res = stream
        ? await deps.llm.chatStream(req, (chunk) => {
            if (chunk.type === 'delta' && chunk.delta) {
              streamed += chunk.delta;
            }
          })
        : await deps.llm.chat(req);
      recordProviderUsage(ctx, req, res.usage);
      if (res.usage) {
        ctx.usage = {
          promptTokens: res.usage.promptTokens,
          completionTokens: res.usage.completionTokens,
          totalTokens: res.usage.totalTokens ?? res.usage.promptTokens + res.usage.completionTokens,
          source: 'provider',
        };
      }
      const apiGeneratedReply = res.content || streamed;
      reply = await acceptUniqueUserFacingReply(
        ctx,
        'reply',
        apiGeneratedReply,
        (input) => rewriteReply(deps, ctx, systemPrompt.text, messages, input),
      );
      // The Provider API is called for this run; publish only after the
      // generated response passes the durable duplicate gate.
      ctx.onAssistantDelta?.(reply);
    } catch (err) {
      ctx.lastError = { stage: 'reply', message: `user-facing reply generation failed: ${(err as Error).message}` };
      return {
        stage: 'reply',
        next: 'exit',
        ok: false,
        error: ctx.lastError.message,
      };
    }

    ctx.reply = reply;
    return {
      stage: 'reply',
      next: 'finalize',
      ok: true,
    };
  };
}

async function rewriteReply(
  deps: ReplyStageDeps,
  ctx: RunContext,
  systemPrompt: string,
  originalMessages: ChatMessage[],
  input: ReplyRewriteInput,
): Promise<string> {
  const rawRequest = {
    model: deps.model,
    messages: [
      {
        role: 'system' as const,
        content: `${systemPrompt}\n\nRegeneration contract:\n- The prior API-generated response exactly repeats a previously published LS reply.\n- Generate the answer again with a genuinely different opening and sentence structure.\n- Preserve the original answer, scope, uncertainty and user language.\n- Do not mention this regeneration request or the comparison.\n- Return only the new user-facing reply.`,
      },
      ...originalMessages.slice(1),
      {
        role: 'user' as const,
        content: [
          `Prior API-generated response:\n${input.generatedReply}`,
          `Recent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
        ].join('\n\n'),
      },
    ],
    temperature: 0.75,
    max_tokens: 4_096,
    signal: ctx.signal,
    stream: false,
  } satisfies ChatRequest;
  const request = prepareModelRequest(
    ctx,
    'reply',
    rawRequest,
    buildRunRequestCandidates(ctx, 'reply', rawRequest.messages, {
      history: ctx.history,
      primaryUserKind: 'user_input',
    }),
  );
  const response = await deps.llm.chat(request);
  recordProviderUsage(ctx, request, response.usage);
  if (response.usage) {
    ctx.usage = {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens ?? response.usage.promptTokens + response.usage.completionTokens,
      source: 'provider',
    };
  }
  return response.content;
}
