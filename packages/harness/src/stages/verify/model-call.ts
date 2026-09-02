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
import { callLlmForJson } from '../_shared.js';
import {
  type DecodedVerdict,
  type VerifyStageDeps,
  VERIFY_SYSTEM_PROMPT,
} from './contracts.js';
import { buildVerifyUserMessage } from './evidence.js';

export async function requestVerificationVerdict(
  deps: VerifyStageDeps,
  ctx: RunContext,
  replanAttempts: number,
  maxReplan: number,
): Promise<DecodedVerdict | null> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: appendSystemPromptAddons(
        VERIFY_SYSTEM_PROMPT,
        ctx.profilePromptAddon,
        buildUserFacingVoiceAddon(ctx),
      ),
    },
    { role: 'user', content: buildVerifyUserMessage(ctx, replanAttempts, maxReplan) },
  ];
  const { parsed } = await callLlmForJson<DecodedVerdict>(deps.llm, deps.model, messages, {
    maxAttempts: 2,
    maxTokens: 500,
    maxTokensCeiling: 900,
    signal: ctx.signal,
    onRequest: (request) => prepareModelRequest(
      ctx,
      'verify',
      preferDirectModelOutput(ctx, request, { force: true }),
      buildRunRequestCandidates(ctx, 'verify', request.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    ),
    onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
    beforeRequest: (request) => ensureModelRequestStarted(ctx, request),
    onError: (request, error) => recordModelRequestFailure(ctx, request, error, ctx.signal),
  });
  return parsed;
}
