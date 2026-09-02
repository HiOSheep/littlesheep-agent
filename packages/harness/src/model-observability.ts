// Model request observation owns request-bound cache evidence and provider usage reconciliation.
import {
  ContextEngine,
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
  type ContextMessageCandidate,
  type ExactContextTokenCounter,
} from '@littlesheep/context';
import type {
  DurableModelRequestStatus,
  LlmCallContract,
  LlmCallPurpose,
  LocalTokenLedger,
  ModelRequestSnapshot,
  RunContext,
  StageName,
} from '@littlesheep/types';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { resolveProviderReasoningRequest } from '@littlesheep/config';
import {
  LlmCallContractViolationError,
  resolveLlmCallContract,
} from './llm-call-contracts/registry.js';
import { injectRuntimeAwareness } from './runtime-awareness.js';
import { injectMemoryKnownState } from './memory-known-state.js';
import { applyMemoryContextWorkingSet } from './memory-context-working-set.js';
import {
  appendModelObservations,
  incrementModelCallCount,
  updateContextSnapshot,
  writeModelObservabilityState,
} from './model-observability-state.js';
import {
  buildCacheObservation,
  classifyProviderCacheUsage,
  orderToolSpecs,
  type CachePromptComponentInput,
} from './cache-observability.js';

export {
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
};

const defaultContextEngine = new ContextEngine();
const contextEngines = new WeakMap<RunContext, ContextEngine>();
const requestContextSnapshotIds = new WeakMap<ChatRequest, string>();
interface ModelRequestLifecycle {
  readonly snapshot: ModelRequestSnapshot;
  readonly started: Promise<void>;
  response?: Promise<void>;
  settled?: Promise<void>;
}
const requestLifecycles = new WeakMap<ChatRequest, ModelRequestLifecycle>();
const contextRequestLifecycles = new WeakMap<RunContext, Set<ChatRequest>>();

/** Await the durable request-start boundary before entering a Provider call. */
export async function ensureModelRequestStarted(_ctx: RunContext, request: ChatRequest): Promise<void> {
  const lifecycle = requestLifecycles.get(request);
  if (!lifecycle) return;
  await lifecycle.started;
}

/**
 * Close every model request prepared by a run before a terminal boundary.
 *
 * A response callback normally creates the response and settled events. If a
 * direct caller forgets that callback, the request is deliberately settled as
 * `missing` so the durable projection exposes the lifecycle gap instead of
 * leaving an apparently successful run with a pending request forever.
 */
export async function flushModelRequestLifecycles(ctx: RunContext): Promise<void> {
  const requests = [...(contextRequestLifecycles.get(ctx) ?? [])];
  for (const request of requests) {
    const lifecycle = requestLifecycles.get(request);
    if (!lifecycle) continue;
    await lifecycle.started;
    if (!lifecycle.settled) {
      await settleModelRequest(ctx, request, 'missing', {
        providerReached: false,
        errorKind: 'missing_response_settlement',
        usageStatus: 'unknown',
      });
    }
    await lifecycle.settled;
  }
}

/** Record a terminal model request outcome, preserving retry/abort evidence. */
export async function settleModelRequest(
  ctx: RunContext,
  request: ChatRequest,
  status: DurableModelRequestStatus,
  details: {
    providerReached?: boolean;
    providerReachStatus?: 'reached' | 'not_reached' | 'unknown';
    retryOf?: string;
    errorKind?: string;
    usageStatus?: 'available' | 'unavailable' | 'unknown';
    transportStatus?: import('@littlesheep/types').DurableModelTransportStatus;
    cacheObservation?: NonNullable<ModelRequestSnapshot['cacheObservation']>;
  } = {},
): Promise<void> {
  const lifecycle = requestLifecycles.get(request);
  if (!lifecycle || lifecycle.settled) {
    if (lifecycle?.settled) await lifecycle.settled;
    return;
  }
  lifecycle.settled = lifecycle.started.then(async () => {
    await ctx.appendDurableEvent?.({
      type: 'model_request_settled',
      source: 'runtime',
      eventId: `${ctx.runId}:model-request:${lifecycle.snapshot.id}:settled`,
      idempotencyKey: `${ctx.runId}:model-request:${lifecycle.snapshot.id}:settled`,
      payload: {
        requestId: lifecycle.snapshot.id,
        requestIndex: lifecycle.snapshot.requestIndex,
        status,
        ...(details.providerReached === undefined ? {} : { providerReached: details.providerReached }),
        ...(details.providerReachStatus ? { providerReachStatus: details.providerReachStatus } : {}),
        ...(details.retryOf ? { retryOf: details.retryOf } : {}),
        ...(details.errorKind ? { errorKind: details.errorKind.slice(0, 128) } : {}),
        ...(details.usageStatus ? { usageStatus: details.usageStatus } : {}),
        ...(details.transportStatus ? { transportStatus: details.transportStatus } : {}),
        ...(details.cacheObservation ? { cacheObservation: details.cacheObservation } : {}),
      },
    });
  });
  await lifecycle.settled;
}

/** Execute a prepared non-streaming Provider request with lifecycle evidence. */
export async function callModelChat(
  ctx: RunContext,
  llm: LlmClient,
  request: ChatRequest,
): Promise<ChatResponse> {
  await ensureModelRequestStarted(ctx, request);
  try {
    const response = await llm.chat(request);
    recordProviderUsage(ctx, request, response.usage);
    return response;
  } catch (error) {
    await recordModelRequestFailure(ctx, request, error, ctx.signal);
    throw error;
  }
}

/** Execute a prepared streaming Provider request with lifecycle evidence. */
export async function callModelChatStream(
  ctx: RunContext,
  llm: LlmClient,
  request: ChatRequest,
  onDelta: (chunk: StreamChunk) => void,
): Promise<ChatResponse> {
  await ensureModelRequestStarted(ctx, request);
  try {
    const response = await llm.chatStream(request, onDelta);
    recordProviderUsage(ctx, request, response.usage);
    return response;
  } catch (error) {
    await recordModelRequestFailure(ctx, request, error, ctx.signal);
    throw error;
  }
}

/** Best-effort error settlement helper for transport and cancellation paths. */
export async function recordModelRequestFailure(
  ctx: RunContext,
  request: ChatRequest,
  error: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status: DurableModelRequestStatus = signal?.aborted || lower.includes('abort')
    ? 'aborted'
    : lower.includes('timeout') || lower.includes('timed out')
      ? 'timeout'
      : lower.includes('rate limit') || lower.includes('429')
        ? 'rate_limit'
        : lower.includes('connection') || lower.includes('reset') || lower.includes('fetch failed')
          ? 'connection_reset'
          : 'failed';
  const lifecycle = requestLifecycles.get(request);
  if (lifecycle) {
    updateModelRequestCacheObservation(ctx, lifecycle.snapshot.stage, lifecycle.snapshot.id, (current) => ({
      ...current,
      providerPrompt: {
        kind: 'provider_prompt',
        status: 'unavailable',
        reason: `provider_request_${status}`,
        requestCount: 1,
      },
    }));
  }
  await settleModelRequest(ctx, request, status, {
    ...(status === 'rate_limit' ? { providerReached: true } : status === 'aborted' ? { providerReached: false } : {}),
    providerReachStatus: status === 'aborted'
      ? 'not_reached'
      : status === 'connection_reset' || status === 'timeout' || status === 'failed'
        ? 'unknown'
        : 'reached',
    errorKind: status,
    usageStatus: 'unavailable',
    transportStatus: status === 'aborted'
      ? 'aborted'
      : status === 'timeout'
        ? 'timeout'
        : status === 'rate_limit'
          ? 'rate_limit'
          : status === 'connection_reset'
            ? 'connection_reset'
            : 'failed',
    ...(lifecycle
      ? { cacheObservation: currentCacheObservation(ctx, lifecycle.snapshot.id) }
      : {}),
  });
}

/** Bind one immutable local counter to a run without adding infrastructure to RunContext. */
export function bindExactContextTokenCounter(
  ctx: RunContext,
  tokenCounter: ExactContextTokenCounter | undefined,
): void {
  if (!tokenCounter) return;
  contextEngines.set(ctx, new ContextEngine({ tokenCounter }));
}

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
  const snapshotId = requestContextSnapshotIds.get(request);
  if (!snapshotId || !ctx.contextSnapshots) return;
  const index = ctx.contextSnapshots.findIndex((snapshot) => snapshot.id === snapshotId);
  if (index < 0) return;
  const snapshot = ctx.contextSnapshots[index]!;
  const requestSnapshot = ctx.modelRequests?.find((request) => request.contextSnapshotId === snapshotId);
  if (!requestSnapshot) return;
  const cacheUsage = classifyProviderCacheUsage(usage);
  updateModelRequestCacheObservation(ctx, requestSnapshot.stage, requestSnapshot.id, (current) => ({
    ...current,
    providerPrompt: cacheUsage.ledger,
  }));
  if (!cacheUsage.validUsage) {
    queueModelResponseReceived(ctx, request, requestSnapshot, {
      usageStatus: 'unavailable',
      cacheStatus: cacheUsage.ledger.status,
      cacheObservation: currentCacheObservation(ctx, requestSnapshot.id),
    });
    return;
  }
  usage = cacheUsage.validUsage;
  const localCalibration = buildLocalCalibration(snapshot.localTokenLedger, usage.promptTokens);
  updateContextSnapshot(ctx, requestSnapshot.stage, snapshotId, (current) => Object.freeze({
    ...current,
    providerUsage: Object.freeze({
      version: 1 as const,
      source: 'provider' as const,
      provider: current.provider,
      model: current.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      reasoningTokens: usage.reasoningTokens,
      localCalibration,
      reportedAt: new Date().toISOString(),
    }),
  }));
  queueModelResponseReceived(ctx, request, requestSnapshot, {
    usageStatus: 'available',
    cacheStatus: cacheUsage.ledger.status,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
    cachedPromptTokens: usage.cachedPromptTokens,
    reasoningTokens: usage.reasoningTokens,
    reconciliation: localCalibration?.status === 'drift'
      ? 'mismatch'
      : localCalibration?.status ?? 'unavailable',
    cacheObservation: currentCacheObservation(ctx, requestSnapshot.id),
  });
}

function queueModelResponseReceived(
  ctx: RunContext,
  request: ChatRequest,
  snapshot: ModelRequestSnapshot,
  payload: Record<string, unknown>,
): void {
  const lifecycle = requestLifecycles.get(request);
  if (!lifecycle || lifecycle.response || lifecycle.settled) return;
  lifecycle.response = lifecycle.started.then(async () => {
    await ctx.appendDurableEvent?.({
      type: 'model_response_received',
      source: 'runtime',
      eventId: `${ctx.runId}:model-request:${snapshot.id}:response`,
      idempotencyKey: `${ctx.runId}:model-request:${snapshot.id}:response`,
      payload: {
        requestId: snapshot.id,
        requestIndex: snapshot.requestIndex,
        stage: snapshot.stage,
        provider: snapshot.provider,
        model: snapshot.model,
        stream: snapshot.stream,
        transportStatus: 'completed',
        providerReachStatus: 'reached',
        ...payload,
      },
    });
  });
  lifecycle.settled = lifecycle.response.then(async () => {
    await ctx.appendDurableEvent?.({
      type: 'model_request_settled',
      source: 'runtime',
      eventId: `${ctx.runId}:model-request:${snapshot.id}:settled`,
      idempotencyKey: `${ctx.runId}:model-request:${snapshot.id}:settled`,
      payload: {
        requestId: snapshot.id,
        requestIndex: snapshot.requestIndex,
        status: 'received',
        providerReached: true,
        providerReachStatus: 'reached',
        transportStatus: 'completed',
        usageStatus: payload.usageStatus === 'available'
          ? 'available'
          : payload.usageStatus === 'unknown' ? 'unknown' : 'unavailable',
      },
    });
  });
  void lifecycle.settled.catch(() => undefined);
}

/** Use provider-native direct output for bounded routing, wording, and retries. */
export function preferDirectModelOutput(
  ctx: RunContext,
  request: ChatRequest,
  options: { force?: boolean } = {},
): ChatRequest {
  const resolved = ctx.resolvedRunConfig;
  if (!resolved || (!options.force && resolved.reasoning === 'auto')) return request;
  if (resolved.provider === 'deepseek' || resolved.provider === 'glm') {
    return {
      ...request,
      temperature: undefined,
      reasoning_effort: undefined,
      thinking: { type: 'disabled' },
    };
  }
  if (resolved.provider === 'openai') {
    return {
      ...request,
      reasoning_effort: 'none',
      thinking: undefined,
    };
  }
  return request;
}

function recordPreparedRequest(
  ctx: RunContext,
  purposeOrStage: LlmCallPurpose | StageName,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): { request: ChatRequest; snapshot: ModelRequestSnapshot } {
  const modelCallBudgetEnabled = ctx.maxModelCalls !== undefined;
  if (ctx.maxModelCalls !== undefined) {
    const maxModelCalls = Math.max(1, ctx.maxModelCalls);
    if ((ctx.modelCallCount ?? 0) >= maxModelCalls) {
      throw new Error(`model call budget exhausted (${maxModelCalls} calls per run)`);
    }
  }
  // Provider tool arrays are part of the stable prefix. Sort a copy before
  // context assembly so registry discovery/concurrency cannot change bytes.
  const canonicalRequest = { ...request, tools: orderToolSpecs(request.tools) };
  const resolvedRequest = applyResolvedReasoning(ctx, canonicalRequest);
  const workingSetAware = applyMemoryContextWorkingSet(ctx, resolvedRequest, candidates);
  const requestIndex = (ctx.modelRequests?.at(-1)?.requestIndex ?? 0) + 1;
  const requestedToolNames = workingSetAware.request.tools?.map((tool) => tool.function.name) ?? [];
  const callContract = resolveLlmCallContract(ctx, purposeOrStage, {
    allowedToolNames: requestedToolNames,
    maxOutputTokens: resolvedRequest.max_tokens,
    temperature: resolvedRequest.temperature,
  });
  if (modelCallBudgetEnabled) incrementModelCallCount(ctx, callContract.stage);
  const memoryAware = callContract.inputs.allowedContextKinds.includes('memory_fragment')
    ? injectMemoryKnownState(ctx, callContract.stage, workingSetAware.request, workingSetAware.candidates, requestIndex)
    : workingSetAware;
  const runtimeAware = injectRuntimeAwareness(
    ctx,
    memoryAware.request,
    memoryAware.candidates,
    requestIndex,
    callContract.purpose,
  );
  validateModelRequest(callContract, runtimeAware.request);
  const prepared = (contextEngines.get(ctx) ?? defaultContextEngine).prepare({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    stage: callContract.stage,
    requestIndex,
    provider: ctx.resolvedRunConfig?.provider,
    request: runtimeAware.request,
    candidates: runtimeAware.candidates,
    callContract,
    compressionThresholdRatio: callContract.budget.contextCompressionThresholdRatio,
  });
  const cacheObservation = buildCacheObservation({
    request: prepared.request,
    provider: prepared.modelRequestSnapshot.provider,
    model: prepared.modelRequestSnapshot.model,
    requestKind: callContract.purpose,
    requestIndex,
    modelRequestId: prepared.modelRequestSnapshot.id,
    sessionId: ctx.sessionId,
    workspaceScope: ctx.cwd,
    permissionPolicyId: ctx.resolvedRunConfig?.permissionPolicyId,
    previous: ctx.modelRequests?.at(-1)?.cacheObservation,
    promptComponents: buildPromptComponentInput(ctx),
    key: ctx.cacheObservationKey,
  });
  const observedSnapshot = Object.freeze({
    ...prepared.modelRequestSnapshot,
    cacheObservation,
  });
  appendModelObservations(
    ctx,
    callContract.stage,
    observedSnapshot,
    prepared.contextSnapshot,
    MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  );
  requestContextSnapshotIds.set(prepared.request, prepared.contextSnapshot.id);
  const started = Promise.resolve().then(async () => {
    await ctx.appendDurableEvent?.({
      type: 'model_request_started',
      source: 'runtime',
      eventId: `${ctx.runId}:model-request:${prepared.modelRequestSnapshot.id}:started`,
      idempotencyKey: `${ctx.runId}:model-request:${prepared.modelRequestSnapshot.id}:started`,
      payload: {
        requestId: prepared.modelRequestSnapshot.id,
        requestIndex,
        stage: callContract.stage,
        purpose: callContract.purpose,
        provider: prepared.modelRequestSnapshot.provider,
        model: prepared.modelRequestSnapshot.model,
        stream: prepared.modelRequestSnapshot.stream,
        transportStatus: prepared.modelRequestSnapshot.stream ? 'streaming' : 'not_started',
        payloadHash: prepared.modelRequestSnapshot.payloadHash,
        cacheObservation: observedSnapshot.cacheObservation,
      },
    });
  });
  requestLifecycles.set(prepared.request, { snapshot: observedSnapshot, started });
  const runRequests = contextRequestLifecycles.get(ctx) ?? new Set<ChatRequest>();
  runRequests.add(prepared.request);
  contextRequestLifecycles.set(ctx, runRequests);
  return { request: prepared.request, snapshot: observedSnapshot };
}

/** Collect only prompt-source revisions; cache-observability hashes values before persistence. */
function buildPromptComponentInput(
  ctx: RunContext,
): CachePromptComponentInput {
  const resolved = ctx.resolvedRunConfig;
  return {
    promptVersion: 'prompt-assembly-v3',
    systemPolicy: JSON.stringify({
      workflowStrategyId: resolved?.workflowStrategyId,
      contextStrategyId: resolved?.contextStrategyId,
      memoryStrategyId: resolved?.memoryStrategyId,
      outputContractId: resolved?.outputContractId,
      behaviorModeId: resolved?.behaviorModeId,
      profilePromptAddon: ctx.profilePromptAddon,
      reasoningPromptAddon: ctx.reasoningPromptAddon,
    }),
    soul: ctx.bootstrap?.['SOUL.md'],
    userProfile: ctx.bootstrap?.['USER.md'],
    memoryRevision: JSON.stringify({
      rootIndex: ctx.memoryRootIndex,
      knownStateRevision: ctx.memoryKnownState?.revision,
      workingSet: ctx.memoryContextWorkingSet?.revision,
    }),
    summary: ctx.sessionSummary
      ? `${ctx.sessionSummary.id}:${ctx.sessionSummary.compactedAt}:${ctx.sessionSummary.sourceEndMessageId}`
      : undefined,
    locale: JSON.stringify({ timeZone: ctx.timeZone, timeFormat: ctx.timeFormat }),
  };
}

function updateModelRequestCacheObservation(
  ctx: RunContext,
  stage: StageName,
  requestId: string,
  update: (observation: NonNullable<ModelRequestSnapshot['cacheObservation']>) => NonNullable<ModelRequestSnapshot['cacheObservation']>,
): void {
  const requests = ctx.modelRequests ?? [];
  const index = requests.findIndex((request) => request.id === requestId);
  if (index < 0 || !requests[index]?.cacheObservation) return;
  const next = [...requests];
  next[index] = Object.freeze({
    ...requests[index]!,
    cacheObservation: Object.freeze(update(requests[index]!.cacheObservation!)),
  });
  writeModelObservabilityState(ctx, stage, { modelRequests: next });
}

function currentCacheObservation(
  ctx: RunContext,
  requestId: string,
): NonNullable<ModelRequestSnapshot['cacheObservation']> | undefined {
  return ctx.modelRequests?.find((request) => request.id === requestId)?.cacheObservation;
}

function buildLocalCalibration(
  ledger: LocalTokenLedger | undefined,
  providerPromptTokens: number,
) {
  if (!ledger || ledger.accuracy !== 'exact') return undefined;
  const differenceTokens = providerPromptTokens - ledger.promptTokens;
  const relativeDifference = providerPromptTokens === 0
    ? (differenceTokens === 0 ? 0 : 1)
    : Math.abs(differenceTokens) / providerPromptTokens;
  return Object.freeze({
    version: 1 as const,
    tokenizerId: ledger.tokenizerId,
    localPromptTokens: ledger.promptTokens,
    differenceTokens,
    relativeDifference,
    status: differenceTokens === 0
      ? 'exact_match' as const
      : relativeDifference <= 0.005
        ? 'within_tolerance' as const
        : 'drift' as const,
  });
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
  // Explicit per-request controls are used only by bounded recovery paths and
  // must not be overwritten by the run-wide reasoning preference.
  if (request.reasoning_effort !== undefined || request.thinking !== undefined) return request;
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
