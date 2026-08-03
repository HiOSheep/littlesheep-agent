import type { RunContext, StageResult } from '@littlesheep/types';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
} from '../../model-observability.js';
import { callLlmForJson } from '../_shared.js';
import type { DecideStageDeps, DecodedPlan } from './contracts.js';
import { buildDecideRequestCandidates, type DecideRequest } from './request.js';
import {
  expandCompactExplicitToolDecision,
  type CompactExplicitToolDecision,
} from '../../compact-explicit-tool-decision.js';

export type DecisionModelResult =
  | { ok: true; parsed: DecodedPlan; attempts: number }
  | { ok: false; result: StageResult };

export async function requestDecisionModel(
  deps: DecideStageDeps,
  ctx: RunContext,
  request: DecideRequest,
): Promise<DecisionModelResult> {
  try {
    const compact = Boolean(request.compactExplicitTool);
    const { parsed, attempts } = await callLlmForJson<DecodedPlan | CompactExplicitToolDecision>(
      deps.llm,
      deps.model,
      request.messages,
      {
        maxAttempts: 2,
        maxTokens: compact ? 700 : 1_400,
        maxTokensCeiling: compact ? 1_000 : 2_200,
        signal: ctx.signal,
        onRequest: (chatRequest) => prepareModelRequest(
          ctx,
          request.callPurpose,
          preferDirectModelOutput(ctx, chatRequest, { force: true }),
          buildDecideRequestCandidates(ctx, request, chatRequest.messages),
        ),
        onResponse: (chatRequest, response) => recordProviderUsage(ctx, chatRequest, response.usage),
      },
    );
    if (parsed) {
      return {
        ok: true,
        parsed: request.compactExplicitTool && !isDecodedPlan(parsed)
          ? expandCompactExplicitToolDecision(
              parsed as CompactExplicitToolDecision,
              request.compactExplicitTool,
            )
          : parsed as DecodedPlan,
        attempts,
      };
    }
    return failure(ctx, `failed to decode decision after ${attempts} attempt(s)`);
  } catch (error) {
    return failure(ctx, `transport error: ${(error as Error).message}`);
  }
}

function isDecodedPlan(value: DecodedPlan | CompactExplicitToolDecision): value is DecodedPlan {
  return Boolean(
    value
    && typeof value === 'object'
    && ('assessment' in value || 'taskBook' in value || 'plan' in value),
  );
}

function failure(ctx: RunContext, message: string): DecisionModelResult {
  ctx.lastError = { stage: 'decide', message };
  return {
    ok: false,
    result: { stage: 'decide', next: 'recover', ok: false, error: message },
  };
}
