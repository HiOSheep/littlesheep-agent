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
  let modelResult: Awaited<ReturnType<typeof callLlmForJson<DecodedPlan>>>;
  try {
    const compact = Boolean(request.compactExplicitTool || request.compactAutonomousReadTools);
    modelResult = await callLlmForJson<DecodedPlan>(
      deps.llm,
      deps.model,
      request.messages,
      {
        maxAttempts: 2,
        maxTokens: compact ? 250 : 1_400,
        maxTokensCeiling: compact ? 400 : 2_200,
        signal: ctx.signal,
        validateParsed: (value) => expandCompactDecision(
          request,
          value as DecodedPlan | CompactExplicitToolDecision | CompactAutonomousReadDecision,
        ),
        onRequest: (chatRequest, retry) => prepareModelRequest(
          ctx,
          request.callPurpose,
          preferDirectModelOutput(ctx, chatRequest, { force: true }),
          buildDecideRequestCandidates(ctx, request, chatRequest.messages),
          {
            retryOf: retry.previousRequestId,
            retryReason: retry.previousFailureReason,
          },
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
  if (!parsed) {
    return failure(
      ctx,
      modelResult.lastFailureReason === 'schema'
        ? `decision contract error: invalid decision schema after ${attempts} attempt(s)`
        : `failed to decode decision after ${attempts} attempt(s) (${modelResult.lastFailureReason ?? 'unknown'})`,
    );
  }

  try {
    return {
      ok: true,
      parsed,
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
  throw new Error('decision JSON has no assessment, taskBook, or compatibility plan');
}

function isDecodedPlan(
  value: DecodedPlan | CompactExplicitToolDecision | CompactAutonomousReadDecision,
): value is DecodedPlan {
  return Boolean(
    value
    && typeof value === 'object'
    && (
      ('assessment' in value && typeof value.assessment === 'object' && value.assessment !== null)
      || ('taskBook' in value && typeof value.taskBook === 'object' && value.taskBook !== null)
      || ('plan' in value && Array.isArray(value.plan))
    ),
  );
}

function failure(ctx: RunContext, message: string): DecisionModelResult {
  recordFailure(ctx, 'decide', 'decide', message);
  return {
    ok: false,
    result: { stage: 'decide', next: 'recover', ok: false, error: message },
  };
}
