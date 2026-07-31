import type { ChatMessage } from '@littlesheep/llm';
import type { RunContext } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
} from '../../model-observability.js';
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from '../../profile-prompt.js';
import type { ReplyRewriteInput } from '../../user-facing-reply.js';
import { callLlmForJson, textOf, toChatMessage } from '../_shared.js';
import {
  type DecodedRecovery,
  type RecoverStageDeps,
  RECOVER_SYSTEM_PROMPT,
} from './contracts.js';

export async function requestRecoveryDecision(
  deps: RecoverStageDeps,
  ctx: RunContext,
): Promise<DecodedRecovery | null> {
  const recentResults = (ctx.toolResults ?? []).slice(-3).map((result) => ({
    ok: result.ok,
    error: result.error,
  }));
  const recoveryHistory = ctx.history.slice(-3);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: appendSystemPromptAddons(
        RECOVER_SYSTEM_PROMPT,
        ctx.profilePromptAddon,
        buildUserFacingVoiceAddon(ctx),
      ),
    },
    ...recoveryHistory.map(toChatMessage),
    {
      role: 'user',
      content: [
        `Last error: stage=${ctx.lastError?.stage ?? 'unknown'}, message=${ctx.lastError?.message ?? 'unknown'}`,
        `Recovery attempt: ${ctx.recoveryAttempts}/${ctx.maxRecoveryAttempts}`,
        `Recent tool results: ${JSON.stringify(recentResults)}`,
        `Current plan: ${ctx.plan ? JSON.stringify(ctx.plan.map((step) => step.description)) : '(none)'}`,
        `Inbound: ${textOf(ctx.inbound).slice(0, 500)}`,
      ].join('\n'),
    },
  ];
  const { parsed } = await callLlmForJson<DecodedRecovery>(deps.llm, deps.model, messages, {
    maxAttempts: 2,
    maxTokens: 600,
    maxTokensCeiling: 900,
    signal: ctx.signal,
    onRequest: (request) => prepareModelRequest(
      ctx,
      'recover',
      preferDirectModelOutput(ctx, request, { force: true }),
      buildRunRequestCandidates(ctx, 'recover', request.messages, {
        history: recoveryHistory,
        primaryUserKind: 'workflow_state',
      }),
    ),
    onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
  });
  return parsed;
}

export async function rewriteAbortReason(
  deps: RecoverStageDeps,
  ctx: RunContext,
  lastError: RunContext['lastError'],
  input: ReplyRewriteInput,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: appendSystemPromptAddons(
        RECOVER_SYSTEM_PROMPT,
        buildUserFacingVoiceAddon(ctx),
        'The previous abort reason exactly repeats a previously published LS reply. Return action "abort" again, but rewrite reason with a genuinely different opening and sentence structure. Preserve the same failure facts and do not mention the rewrite.',
      ),
    },
    {
      role: 'user',
      content: [
        `Last error: stage=${lastError?.stage ?? 'unknown'}, message=${lastError?.message ?? 'unknown'}`,
        `Prior API-generated reason: ${input.generatedReply}`,
        `Recent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
      ].join('\n\n'),
    },
  ];
  const { parsed } = await callLlmForJson<DecodedRecovery>(deps.llm, deps.model, messages, {
    maxAttempts: 2,
    maxTokens: 600,
    maxTokensCeiling: 900,
    signal: ctx.signal,
    onRequest: (request) => prepareModelRequest(
      ctx,
      'recover',
      preferDirectModelOutput(ctx, request, { force: true }),
      buildRunRequestCandidates(ctx, 'recover', request.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    ),
    onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
  });
  return parsed?.action === 'abort' ? parsed.reason ?? '' : '';
}
