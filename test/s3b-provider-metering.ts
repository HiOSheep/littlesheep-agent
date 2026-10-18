import { AsyncLocalStorage } from 'node:async_hooks';
import { createLlmClient, type ChatRequest, type ChatResponse, type EmbedRequest, type EmbedResponse, type LlmClient, type ProviderResponseReceipt, type RetryOptions, type StreamChunk } from '@littlesheep/llm';
import {
  RETRYABLE_PROVIDER_STATUSES,
  isNonRetryableProviderStatus,
  resolveProviderWireModel,
  sanitizeS3bText,
  type S3bProviderProfile,
} from '../scripts/lib/s3b-provider-config.mjs';

export interface S3bObservedParameters {
  /** The single wire model id actually sent to the Provider. */
  model: string;
  /** The internal evaluation ref the caller asked for. */
  requestedModelRef: string;
  internalModelRef: string;
  wireModelId: string;
  mappingStatus: 'resolved' | 'rejected';
  mappingReason: string | null;
  temperature: number | null;
  reasoningEffort: string | null;
  thinking: string | null;
  maxOutputTokens: number;
  requestedMaxOutputTokens: number | null;
  stream: boolean;
}

export interface S3bMeterSnapshot {
  logicalModelRequests: number;
  logicalEmbeddingRequests: number;
  physicalProviderRequests: number;
  blockedPhysicalRequests: number;
  toolCallProposals: number;
  providerResponseReceipts: number;
  responsesWithoutUsage: number;
  /** Physical responses whose status is deterministic and must never be replayed. */
  nonRetryableResponses: number;
  /** Replays refused by the per-logical-call poison layer (0 when the pinned retry policy never replays). */
  suppressedNonRetryableReplays: number;
  /** Internal refs rejected before any Provider request because the mapping was ambiguous. */
  modelMappingRejections: Array<{ internalModelRef: string | null; reason: string | null }>;
  /** The statuses this metered transport may replay; pinned unless a test override widened it. */
  retryPolicyStatuses: number[];
  usage: {
    status: 'available' | 'partial' | 'unavailable';
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    source: string | null;
    responseCount: number;
  };
  observedParameters: S3bObservedParameters[];
  responseModelIds: string[];
  physicalResponses: Array<{
    attempt: number;
    status: number | null;
    endpointOrigin: string | null;
    errorCode?: string | null;
    errorType?: string | null;
    errorParam?: string | null;
  }>;
  budgetExhausted: boolean;
}

export interface S3bMeasuredProvider {
  client: LlmClient;
  snapshot(): S3bMeterSnapshot;
}

/** One logical call's identity, propagated across its own retries by AsyncLocalStorage. */
interface S3bLogicalCall {
  id: number;
  /** Set once this logical call has seen a deterministic status; blocks its own later attempts. */
  poisoned: boolean;
}

export function createS3bMeasuredProvider(input: {
  profile: S3bProviderProfile;
  fetchImpl?: typeof fetch;
  /**
   * Test seam only. Simulates a hostile or legacy retry policy (for example a
   * widened `retryableStatuses`, or a zero backoff to make retry timing
   * deterministic). The authoritative non-retryable guarantee does NOT depend on
   * this seam: the pinned `RETRYABLE_PROVIDER_STATUSES` set below is handed to the
   * retry envelope per logical call, so a deterministic 4xx is never replayed even
   * when this override tries to widen the policy. The poison layer then has to
   * stop the replay that a widened policy would otherwise dispatch.
   */
  retryOverrides?: Partial<RetryOptions>;
}): S3bMeasuredProvider {
  const { profile } = input;
  const credentials = profile.credentials;
  const provider = profile.provider;
  if (!profile.ready || !credentials || !provider.physicalRequestBudget || !provider.outputTokenLimit || !provider.timeoutSeconds || !provider.maxAttempts) {
    throw new Error('S3B real Provider configuration is incomplete; run the non-network preflight first.');
  }
  const configuredWireModel = provider.wireModelId ?? credentials.model;
  if (provider.modelMapping?.status !== 'resolved' || !configuredWireModel) {
    throw new Error('S3B real Provider model mapping is not resolved; run the non-network preflight first.');
  }

  let logicalModelRequests = 0;
  let logicalEmbeddingRequests = 0;
  let physicalProviderRequests = 0;
  let blockedPhysicalRequests = 0;
  let toolCallProposals = 0;
  let providerResponseReceipts = 0;
  let responsesWithoutUsage = 0;
  let nonRetryableResponses = 0;
  let suppressedNonRetryableReplays = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let inputReceiptCount = 0;
  let outputReceiptCount = 0;
  let cachedReceiptCount = 0;
  let logicalCallSequence = 0;
  const observedParameters: S3bObservedParameters[] = [];
  const responseModelIds: string[] = [];
  const physicalResponses: S3bMeterSnapshot['physicalResponses'] = [];
  const modelMappingRejections: S3bMeterSnapshot['modelMappingRejections'] = [];
  let budgetExhausted = false;

  // AUTHORITATIVE non-retryable guarantee. `retryableStatuses` is decided by the
  // retry envelope for each logical call (`protocol-transport.ts` derives the
  // error's `retryable` flag from it), so the pinned set cannot be defeated by
  // overlapping logical calls, and no evaluator-side bookkeeping is involved.
  const retryOptions: Partial<RetryOptions> = {
    maxAttempts: provider.maxAttempts,
    retryableStatuses: [...RETRYABLE_PROVIDER_STATUSES],
    ...input.retryOverrides,
  };
  const retryPolicyStatuses = [...(retryOptions.retryableStatuses ?? RETRYABLE_PROVIDER_STATUSES)];

  // Second line of defence for a retry policy that WAS widened. Attribution is
  // per logical call via AsyncLocalStorage, so a call that starts while another
  // call is awaiting its retry cannot clear or steal the other call's poison.
  const callContext = new AsyncLocalStorage<S3bLogicalCall>();

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const guardedFetch: typeof fetch = async (resource, init) => {
    const call = callContext.getStore();
    let endpointOrigin: string;
    try {
      const rawUrl = resource instanceof Request ? resource.url : String(resource);
      endpointOrigin = new URL(rawUrl, credentials.baseURL).origin;
    } catch {
      blockedPhysicalRequests += 1;
      throw new Error('S3B rejected a malformed Provider endpoint before network dispatch.');
    }
    if (call?.poisoned) {
      // Not a physical request: it is refused before the budget is charged.
      suppressedNonRetryableReplays += 1;
      throw new Error('S3B suppressed a Provider request replay after a non-retryable response.');
    }
    if (physicalProviderRequests >= provider.physicalRequestBudget!) {
      blockedPhysicalRequests += 1;
      budgetExhausted = true;
      throw new Error('S3B physical Provider request budget exhausted before network dispatch.');
    }
    // Count every physical attempt before it is sent. A failure, timeout or
    // rejection still consumed a request slot and must be metered as such.
    physicalProviderRequests += 1;
    const attempt = physicalProviderRequests;
    let response: Response;
    try {
      // Redirects can create unmetered requests and move an authenticated request to
      // a different host. Keep the accounting and credential boundary at one origin.
      response = await fetchImpl(resource, { ...init, redirect: 'error' });
    } catch (error) {
      physicalResponses.push({ attempt, status: null, endpointOrigin });
      throw error;
    }
    let providerError: Record<string, unknown> | null = null;
    if (!response.ok) {
      try {
        const body = await response.clone().json() as { error?: unknown };
        if (body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
          providerError = body.error as Record<string, unknown>;
        }
      } catch { /* Status remains the authoritative bounded failure evidence. */ }
    }
    const safeErrorFact = (value: unknown) => {
      if (typeof value !== 'string') return null;
      // A provider can echo a credential in any field; redact before the charset
      // check so a key can never become "bounded structured evidence".
      const sanitized = sanitizeS3bText(value, credentials.apiKey);
      return /^[a-zA-Z0-9_.-]{1,80}$/u.test(sanitized) ? sanitized : null;
    };
    physicalResponses.push({
      attempt,
      status: response.status,
      endpointOrigin,
      ...(providerError ? {
        errorCode: safeErrorFact(providerError.code),
        errorType: safeErrorFact(providerError.type),
        errorParam: safeErrorFact(providerError.param),
      } : {}),
    });
    if (isNonRetryableProviderStatus(response.status)) {
      nonRetryableResponses += 1;
      if (call) call.poisoned = true;
    }
    return response;
  };

  const base = createLlmClient({
    baseURL: credentials.baseURL,
    apiKey: credentials.apiKey,
    api: credentials.protocol,
    timeoutSeconds: provider.timeoutSeconds,
  }, { fetch: guardedFetch, retry: retryOptions });

  const recordReceipt = async (receipt: ProviderResponseReceipt, downstream?: ChatRequest['onProviderResponse']) => {
    providerResponseReceipts += 1;
    const usage = receipt.usage;
    if (!usage || typeof usage.promptTokens !== 'number' || typeof usage.completionTokens !== 'number') {
      responsesWithoutUsage += 1;
    } else {
      inputTokens += usage.promptTokens;
      outputTokens += usage.completionTokens;
      inputReceiptCount += 1;
      outputReceiptCount += 1;
      if (typeof usage.cachedPromptTokens === 'number') {
        cachedInputTokens += usage.cachedPromptTokens;
        cachedReceiptCount += 1;
      }
    }
    await downstream?.(receipt);
  };

  /** Provider-controlled text must never leave this boundary with a credential in it. */
  const sanitizeError = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    const safe = sanitizeS3bText(message, credentials.apiKey);
    if (safe === message) throw error;
    const replacement = new Error(safe);
    if (error instanceof Error) replacement.name = error.name;
    if (error && typeof error === 'object') {
      const source = error as Record<string, unknown>;
      for (const key of ['status', 'retryable', 'retryAfterMs']) {
        if (key in source) (replacement as unknown as Record<string, unknown>)[key] = source[key];
      }
    }
    throw replacement;
  };

  const prepareRequest = (request: ChatRequest): ChatRequest => {
    logicalModelRequests += 1;
    // The same explicit mapping the preflight validated: exactly one wire model
    // id, or a deterministic stop before any Provider request.
    const mapping = resolveProviderWireModel(request.model, credentials.providerId, configuredWireModel);
    if (mapping.status !== 'resolved' || !mapping.wireModelId) {
      modelMappingRejections.push({ internalModelRef: mapping.internalModelRef, reason: mapping.reason });
      throw new Error(`S3B rejected an ambiguous internal model mapping before any Provider request: ${mapping.reason}`);
    }
    const providerModel = mapping.wireModelId;
    const requestedMaxOutputTokens = request.max_tokens ?? null;
    const max_tokens = Math.min(request.max_tokens ?? provider.outputTokenLimit!, provider.outputTokenLimit!);
    observedParameters.push({
      model: providerModel,
      requestedModelRef: request.model,
      internalModelRef: mapping.internalModelRef ?? request.model,
      wireModelId: providerModel,
      mappingStatus: mapping.status,
      mappingReason: mapping.reason,
      temperature: request.temperature ?? null,
      reasoningEffort: request.reasoning_effort ?? null,
      thinking: request.thinking?.type ?? null,
      maxOutputTokens: max_tokens,
      requestedMaxOutputTokens,
      stream: request.stream === true,
    });
    return {
      ...request,
      model: providerModel,
      max_tokens,
      onProviderResponse: receipt => recordReceipt(receipt, request.onProviderResponse),
    };
  };

  const client: LlmClient = {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const call: S3bLogicalCall = { id: ++logicalCallSequence, poisoned: false };
      try {
        const prepared = prepareRequest(request);
        const response = await callContext.run(call, () => base.chat(prepared));
        toolCallProposals += response.toolCalls.length;
        if (response.model) responseModelIds.push(sanitizeS3bText(response.model, credentials.apiKey).slice(0, 160));
        return response;
      } catch (error) {
        return sanitizeError(error);
      }
    },
    async chatStream(request: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
      const call: S3bLogicalCall = { id: ++logicalCallSequence, poisoned: false };
      try {
        const prepared = prepareRequest(request);
        const response = await callContext.run(call, () => base.chatStream(prepared, onDelta));
        toolCallProposals += response.toolCalls.length;
        if (response.model) responseModelIds.push(sanitizeS3bText(response.model, credentials.apiKey).slice(0, 160));
        return response;
      } catch (error) {
        return sanitizeError(error);
      }
    },
    async embed(request: EmbedRequest): Promise<EmbedResponse> {
      logicalEmbeddingRequests += 1;
      const call: S3bLogicalCall = { id: ++logicalCallSequence, poisoned: false };
      try {
        const response = await callContext.run(call, () => base.embed(request));
        if (typeof response.usage.promptTokens === 'number') {
          inputTokens += response.usage.promptTokens;
          inputReceiptCount += 1;
        }
        return response;
      } catch (error) {
        return sanitizeError(error);
      }
    },
  };

  return {
    client,
    snapshot(): S3bMeterSnapshot {
      const usageStatus = inputReceiptCount === 0 && outputReceiptCount === 0
        ? 'unavailable'
        : responsesWithoutUsage > 0 ? 'partial' : 'available';
      return {
        logicalModelRequests,
        logicalEmbeddingRequests,
        physicalProviderRequests,
        blockedPhysicalRequests,
        toolCallProposals,
        providerResponseReceipts,
        responsesWithoutUsage,
        nonRetryableResponses,
        suppressedNonRetryableReplays,
        modelMappingRejections: [...modelMappingRejections],
        retryPolicyStatuses,
        usage: {
          status: usageStatus,
          inputTokens: inputReceiptCount > 0 ? inputTokens : null,
          outputTokens: outputReceiptCount > 0 ? outputTokens : null,
          cachedInputTokens: cachedReceiptCount > 0 ? cachedInputTokens : null,
          source: providerResponseReceipts > 0 ? 'LlmClient onProviderResponse physical Provider receipts' : null,
          responseCount: providerResponseReceipts,
        },
        observedParameters: [...observedParameters],
        responseModelIds: [...responseModelIds],
        physicalResponses: [...physicalResponses],
        budgetExhausted,
      };
    },
  };
}
