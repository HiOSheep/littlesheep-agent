import type { ChatMessage } from '@littlesheep/llm';
import type { RunContext } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
  ensureModelRequestStarted,
  recordModelRequestFailure,
} from '../../model-observability.js';
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from '../../profile-prompt.js';
import { callLlmForJson, conversationHistoryForModel, textOf, toChatMessage } from '../_shared.js';
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
  // Recovery is a main-conversation call: it must project the same history
  // bytes as reply/execute, otherwise the Provider prefix diverges at the
  // second message and the run's cached prefix is forfeited on failure paths.
  const recoveryHistory = conversationHistoryForModel(ctx);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: appendSystemPromptAddons(
        RECOVER_SYSTEM_PROMPT,
        { id: 'profile', text: ctx.profilePromptAddon, placement: 'stable' },
        { id: 'user-facing-voice', text: buildUserFacingVoiceAddon(ctx) },
      ),
    },
    ...recoveryHistory.map(toChatMessage),
    {
      role: 'user',
      content: [
        `Last error: stage=${ctx.lastError?.stage ?? 'unknown'}, message=${ctx.lastError?.message ?? 'unknown'}`,
        `Recovery attempt: ${ctx.recoveryAttempts}/${ctx.maxRecoveryAttempts}`,
        `Recent tool results: ${JSON.stringify(recentResults)}`,
        `Available run tools: ${ctx.tools.length > 0 ? ctx.tools.map((tool) => tool.name).join(', ') : '(none)'}`,
        `Current plan: ${ctx.plan ? JSON.stringify(ctx.plan.map((step) => ({ description: step.description, tools: step.tools }))) : '(none)'}`,
        `Inbound: ${textOf(ctx.inbound).slice(0, 500)}`,
      ].join('\n'),
    },
  ];
  const { parsed } = await callLlmForJson<DecodedRecovery>(deps.llm, deps.model, messages, {
    maxAttempts: 2,
    maxTokens: 600,
    maxTokensCeiling: 900,
    signal: ctx.signal,
    onRequest: (request, retry) => prepareModelRequest(
      ctx,
      'recover',
      preferDirectModelOutput(ctx, request, { force: true }),
      buildRunRequestCandidates(ctx, 'recover', request.messages, {
        history: recoveryHistory,
        primaryUserKind: 'workflow_state',
      }),
      { retryOf: retry.previousRequestId, retryReason: retry.previousFailureReason },
    ),
    onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
    beforeRequest: (request) => ensureModelRequestStarted(ctx, request),
    onError: (request, error) => recordModelRequestFailure(ctx, request, error, ctx.signal),
  });
  return parsed;
}
