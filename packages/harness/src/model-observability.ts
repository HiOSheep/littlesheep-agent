import {
  ContextEngine,
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
  type ContextMessageCandidate,
} from '@littlesheep/context';
import type {
  LlmCallContract,
  LlmCallPurpose,
  ModelRequestSnapshot,
  RunContext,
  StageName,
} from '@littlesheep/types';
import type { ChatRequest, ChatResponse } from '@littlesheep/llm';
import { resolveProviderReasoningRequest } from '@littlesheep/config';
import {
  LlmCallContractViolationError,
  resolveLlmCallContract,
} from './llm-call-contracts/registry.js';

export {
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
};

const contextEngine = new ContextEngine();
const requestContextSnapshotIds = new WeakMap<ChatRequest, string>();

/** Prepare and record the actual outbound request through the shared Context Engine. */
export function prepareModelRequest(
  ctx: RunContext,
  purposeOrStage: LlmCallPurpose | StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): ChatRequest {
  return recordPreparedRequest(ctx, purposeOrStage, request, candidates).request;
}

/** Compatibility helper for observers that do not yet consume the prepared request. */
export function recordModelRequest(
  ctx: RunContext,
  purposeOrStage: LlmCallPurpose | StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): ModelRequestSnapshot {
  return recordPreparedRequest(ctx, purposeOrStage, request, candidates).snapshot;
}

/** Attach provider-reported usage to the exact Context snapshot for a prepared request. */
export function recordProviderUsage(
  ctx: RunContext,
  request: ChatRequest,
  usage: ChatResponse['usage'] | undefined,
): void {
  if (!usage) return;
  const snapshotId = requestContextSnapshotIds.get(request);
  if (!snapshotId || !ctx.contextSnapshots) return;
  const index = ctx.contextSnapshots.findIndex((snapshot) => snapshot.id === snapshotId);
  if (index < 0) return;
  const snapshot = ctx.contextSnapshots[index]!;
  ctx.contextSnapshots[index] = Object.freeze({
    ...snapshot,
    providerUsage: Object.freeze({
      version: 1 as const,
      source: 'provider' as const,
      provider: snapshot.provider,
      model: snapshot.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      reasoningTokens: usage.reasoningTokens,
      reportedAt: new Date().toISOString(),
    }),
  });
}

function recordPreparedRequest(
  ctx: RunContext,
  purposeOrStage: LlmCallPurpose | StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): { request: ChatRequest; snapshot: ModelRequestSnapshot } {
  const resolvedRequest = applyResolvedReasoning(ctx, request);
  const requestedToolNames = resolvedRequest.tools?.map((tool) => tool.function.name) ?? [];
  const callContract = resolveLlmCallContract(ctx, purposeOrStage, {
    allowedToolNames: requestedToolNames,
    maxOutputTokens: resolvedRequest.max_tokens,
    temperature: resolvedRequest.temperature,
  });
  validateModelRequest(callContract, resolvedRequest);
  const prepared = contextEngine.prepare({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    stage: callContract.stage,
    requestIndex: (ctx.modelRequests?.at(-1)?.requestIndex ?? 0) + 1,
    provider: ctx.resolvedRunConfig?.provider,
    request: resolvedRequest,
    candidates,
    callContract,
    compressionThresholdRatio: callContract.budget.contextCompressionThresholdRatio,
  });
  ctx.contextSnapshots ??= [];
  ctx.modelRequests ??= [];
  pushBounded(ctx.contextSnapshots, prepared.contextSnapshot, MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
  pushBounded(ctx.modelRequests, prepared.modelRequestSnapshot, MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
  requestContextSnapshotIds.set(prepared.request, prepared.contextSnapshot.id);
  return { request: prepared.request, snapshot: prepared.modelRequestSnapshot };
}

function validateModelRequest(contract: LlmCallContract, request: ChatRequest): void {
  if (contract.modelCall === 'forbidden') {
    throw new LlmCallContractViolationError(
      'forbidden_model_call',
      'this purpose must be completed without another model request.',
      contract.id,
    );
  }
  if (request.max_tokens !== undefined && (
    !Number.isFinite(request.max_tokens)
    || request.max_tokens < 0
    || request.max_tokens > contract.budget.maxOutputTokens
  )) {
    throw new LlmCallContractViolationError(
      'output_budget_exceeded',
      `requested max_tokens ${request.max_tokens} exceeds budget ${contract.budget.maxOutputTokens}.`,
      contract.id,
    );
  }

  const requestedToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
  if (contract.toolPolicy.mode === 'none' && requestedToolNames.length > 0) {
    throw new LlmCallContractViolationError(
      'tool_forbidden',
      `this purpose forbids tools but request included: ${requestedToolNames.join(', ')}.`,
      contract.id,
    );
  }
  const allowedToolNames = new Set(contract.toolPolicy.allowedToolNames);
  const disallowed = requestedToolNames.filter((name) => !allowedToolNames.has(name));
  const namedChoice = typeof request.tool_choice === 'object'
    ? request.tool_choice.function.name
    : undefined;
  if (namedChoice && !allowedToolNames.has(namedChoice)) disallowed.push(namedChoice);
  if (disallowed.length > 0) {
    throw new LlmCallContractViolationError(
      'tool_not_allowed',
      `request referenced tools outside the resolved scope: ${[...new Set(disallowed)].join(', ')}.`,
      contract.id,
    );
  }
}

function applyResolvedReasoning(ctx: RunContext, request: ChatRequest): ChatRequest {
  const resolved = ctx.resolvedRunConfig;
  if (!resolved) return request;
  const options = resolveProviderReasoningRequest(
    resolved.provider,
    resolved.model,
    resolved.reasoning,
  );
  if (!options.reasoningEffort && !options.thinking) return request;

  const stripTemperature = resolved.provider === 'deepseek'
    || (resolved.provider === 'openai' && options.reasoningEffort !== undefined);
  return {
    ...request,
    temperature: stripTemperature ? undefined : request.temperature,
    reasoning_effort: options.reasoningEffort,
    thinking: options.thinking
      ? {
          type: options.thinking.type,
          clear_thinking: options.thinking.clearThinking,
        }
      : undefined,
  };
}

function pushBounded<T>(values: T[], value: T, max: number): void {
  if (values.length >= max) values.splice(0, values.length - max + 1);
  values.push(value);
}
