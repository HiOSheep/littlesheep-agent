// DECIDE orchestration facade: request construction, model call and adoption.
import type { RunContext, StageResult } from '@littlesheep/types';
import { type DecideStageDeps } from './decide/contracts.js';
import { adoptDecodedDecision } from './decide/adoption.js';
import { requestDecisionModel } from './decide/model-call.js';
import { buildDecideRequest } from './decide/request.js';
export type { DecideStageDeps } from './decide/contracts.js';

export function createDecideStage(deps: DecideStageDeps) {
  return async function decideStage(ctx: RunContext): Promise<StageResult> {
    const decideRequest = await buildDecideRequest(deps, ctx);
    const decision = await requestDecisionModel(deps, ctx, decideRequest);
    if (!decision.ok) return decision.result;
    return adoptDecodedDecision(deps, ctx, decideRequest, decision.parsed, decision.attempts);
  };
}
