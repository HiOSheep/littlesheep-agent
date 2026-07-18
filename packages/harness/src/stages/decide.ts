// DECIDE orchestration facade: request construction, model call and adoption.
import type { RunContext, StageResult } from '@littlesheep/types';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { callLlmForJson } from './_shared.js';
import { type DecideStageDeps, type DecodedPlan } from './decide/contracts.js';
import { adoptDecodedDecision } from './decide/adoption.js';
import { buildDecideRequest, buildDecideRequestCandidates } from './decide/request.js';
export type { DecideStageDeps } from './decide/contracts.js';

export function createDecideStage(deps: DecideStageDeps) {
  return async function decideStage(ctx: RunContext): Promise<StageResult> {
    const decideRequest = await buildDecideRequest(deps, ctx);
    let parsed: DecodedPlan | null;
    let attempts: number;
    try {
      ({ parsed, attempts } = await callLlmForJson<DecodedPlan>(deps.llm, deps.model, decideRequest.messages, {
        maxAttempts: 3,
        maxTokens: 1800,
        signal: ctx.signal,
        onRequest: (chatRequest) => prepareModelRequest(
          ctx,
          'decide',
          chatRequest,
          buildDecideRequestCandidates(ctx, decideRequest, chatRequest.messages),
        ),
        onResponse: (chatRequest, response) => recordProviderUsage(ctx, chatRequest, response.usage),
      }));
    } catch (error) {
      ctx.lastError = { stage: 'decide', message: `transport error: ${(error as Error).message}` };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }
    if (!parsed) {
      ctx.lastError = { stage: 'decide', message: `failed to decode decision after ${attempts} attempt(s)` };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }
    return adoptDecodedDecision(deps, ctx, decideRequest, parsed, attempts);
  };
}
