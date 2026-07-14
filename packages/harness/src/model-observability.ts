import {
  ContextEngine,
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
  type ContextMessageCandidate,
} from '@littlesheep/context';
import type { ModelRequestSnapshot, RunContext, StageName } from '@littlesheep/types';
import type { ChatRequest, ChatResponse } from '@littlesheep/llm';
import { resolveProviderReasoningRequest } from '@littlesheep/config';

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
  stage: StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): ChatRequest {
  return recordPreparedRequest(ctx, stage, request, candidates).request;
}

/** Compatibility helper for observers that do not yet consume the prepared request. */
export function recordModelRequest(
  ctx: RunContext,
  stage: StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): ModelRequestSnapshot {
  return recordPreparedRequest(ctx, stage, request, candidates).snapshot;
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
  stage: StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): { request: ChatRequest; snapshot: ModelRequestSnapshot } {
  const resolvedRequest = applyResolvedReasoning(ctx, request);
  const prepared = contextEngine.prepare({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    stage,
    requestIndex: (ctx.modelRequests?.at(-1)?.requestIndex ?? 0) + 1,
    provider: ctx.resolvedRunConfig?.provider,
    request: resolvedRequest,
    candidates,
    compressionThresholdRatio: ctx.contextCompressionThresholdRatio,
  });
  ctx.contextSnapshots ??= [];
  ctx.modelRequests ??= [];
  pushBounded(ctx.contextSnapshots, prepared.contextSnapshot, MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
  pushBounded(ctx.modelRequests, prepared.modelRequestSnapshot, MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
  requestContextSnapshotIds.set(prepared.request, prepared.contextSnapshot.id);
  return { request: prepared.request, snapshot: prepared.modelRequestSnapshot };
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
