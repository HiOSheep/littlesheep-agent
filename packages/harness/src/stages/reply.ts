// @littlesheep/harness — stages/reply.ts
// REPLY: chat-classified messages get a simple LLM reply (no tools).

import type { RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage, ChatRequest } from '@littlesheep/llm';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import { attachmentContextMessages, toChatMessage, textOf, userChatMessage } from './_shared.js';
import { appendSystemPromptBundleAddons } from '../profile-prompt.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';

export interface ReplyStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
}

/** Factory: creates a reply stage. */
export function createReplyStage(deps: ReplyStageDeps) {
  return async function replyStage(ctx: RunContext): Promise<StageResult> {
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
      const res = stream
        ? await deps.llm.chatStream(req, (chunk) => {
            if (chunk.type === 'delta' && chunk.delta) {
              ctx.onAssistantDelta?.(chunk.delta);
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
      reply = res.content || '(no reply)';
    } catch (err) {
      reply = `(reply failed: ${(err as Error).message})`;
    }

    ctx.reply = reply;
    return {
      stage: 'reply',
      next: 'finalize',
      ok: true,
    };
  };
}
