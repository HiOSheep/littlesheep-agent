// @littlesheep/harness — stages/reply.ts
// REPLY: chat-classified messages get a simple LLM reply (no tools).

import type { RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { assembleSystemPrompt, resolvePromptConfig } from '@littlesheep/prompt';
import { toChatMessage, textOf, userChatMessage } from './_shared.js';
import { appendSystemPromptAddons } from '../profile-prompt.js';

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
    const systemPrompt = await assembleSystemPrompt(resolved, {
      tools: ctx.tools,
      bootstrap: ctx.bootstrap ?? {},
      prelude: ctx.prelude,
      memoryRootIndex: ctx.memoryRootIndex,
    }, 'full');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: appendSystemPromptAddons(
          systemPrompt,
          ctx.profilePromptAddon,
          ctx.reasoningPromptAddon,
        ),
      },
      ...ctx.history.map(toChatMessage),
      userChatMessage(textOf(ctx.inbound), ctx.attachments),
    ];

    let reply: string;
    try {
      const req = {
        model: deps.model,
        messages,
        temperature: 0.7,
        signal: ctx.signal,
      };
      const res = ctx.onAssistantDelta
        ? await deps.llm.chatStream(req, (chunk) => {
            if (chunk.type === 'delta' && chunk.delta) {
              ctx.onAssistantDelta?.(chunk.delta);
            }
          })
        : await deps.llm.chat(req);
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
