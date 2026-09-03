import type { RunContext, StageResult } from '@littlesheep/types';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
  ensureModelRequestStarted,
  recordModelRequestFailure,
} from '../../model-observability.js';
import { callLlmForJson } from '../_shared.js';
import type { DecideStageDeps, DecodedPlan } from './contracts.js';
import { buildDecideRequestCandidates, type DecideRequest } from './request.js';
import {
  expandCompactExplicitToolDecision,
  type CompactExplicitToolDecision,
} from '../../compact-explicit-tool-decision.js';
import {
  expandCompactAutonomousReadDecision,
  type CompactAutonomousReadDecision,
} from '../../compact-autonomous-read-task.js';
import { recordFailure } from '../../failure-state.js';

export type DecisionModelResult =
  | { ok: true; parsed: DecodedPlan; attempts: number }
  | { ok: false; result: StageResult };

export async function requestDecisionModel(
  deps: DecideStageDeps,
  ctx: RunContext,
  request: DecideRequest,
): Promise<DecisionModelResult> {
  let modelResult: Awaited<ReturnType<typeof callLlmForJson<
    DecodedPlan | CompactExplicitToolDecision | CompactAutonomousReadDecision
  >>>;
  try {
    const compact = Boolean(request.compactExplicitTool || request.compactAutonomousReadTools);
    modelResult = await callLlmForJson<
      DecodedPlan | CompactExplicitToolDecision | CompactAutonomousReadDecision
    >(
      deps.llm,
      deps.model,
      request.messages,
      {
        maxAttempts: 2,
        maxTokens: compact ? 250 : 1_400,
        maxTokensCeiling: compact ? 400 : 2_200,
        signal: ctx.signal,
        onRequest: (chatRequest, retry) => prepareModelRequest(
          ctx,
          request.callPurpose,
          preferDirectModelOutput(ctx, chatRequest, { force: true }),
          buildDecideRequestCandidates(ctx, request, chatRequest.messages),
          { retryOf: retry.previousRequestId },
        ),
        onResponse: (chatRequest, response) => recordProviderUsage(ctx, chatRequest, response.usage),
        beforeRequest: (chatRequest) => ensureModelRequestStarted(ctx, chatRequest),
        onError: (chatRequest, error) => recordModelRequestFailure(ctx, chatRequest, error, ctx.signal),
      },
    );
  } catch (error) {
    return failure(ctx, `transport error: ${(error as Error).message}`);
  }

  const { parsed, attempts } = modelResult;
  if (!parsed) return failure(ctx, `failed to decode decision after ${attempts} attempt(s)`);

  try {
    return {
      ok: true,
      parsed: expandCompactDecision(request, parsed),
      attempts,
    };
  } catch (error) {
    return failure(ctx, `decision contract error: ${(error as Error).message}`);
  }
}

function expandCompactDecision(
  request: DecideRequest,
  parsed: DecodedPlan | CompactExplicitToolDecision | CompactAutonomousReadDecision,
): DecodedPlan {
  if (isDecodedPlan(parsed)) return parsed;
  if (request.compactExplicitTool) {
    return expandCompactExplicitToolDecision(
      parsed as CompactExplicitToolDecision,
      request.compactExplicitTool,
      request.inboundText,
    );
  }
  if (request.compactAutonomousReadTools) {
    return expandCompactAutonomousReadDecision(
      parsed as CompactAutonomousReadDecision,
      request.compactAutonomousReadTools,
      request.inboundText,
    );
  }
  return parsed as DecodedPlan;
}

function isDecodedPlan(
  value: DecodedPlan | CompactExplicitToolDecision | CompactAutonomousReadDecision,
): value is DecodedPlan {
  return Boolean(
    value
    && typeof value === 'object'
    && ('assessment' in value || 'taskBook' in value || 'plan' in value),
  );
}

function failure(ctx: RunContext, message: string): DecisionModelResult {
  recordFailure(ctx, 'decide', 'decide', message);
  return {
    ok: false,
    result: { stage: 'decide', next: 'recover', ok: false, error: message },
  };
}
