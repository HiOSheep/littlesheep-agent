import { createLlmClient, type ChatRequest, type ChatResponse, type EmbedRequest, type EmbedResponse, type LlmClient, type ProviderResponseReceipt, type StreamChunk } from '@littlesheep/llm';
import type { S3bProviderProfile } from '../scripts/lib/s3b-provider-config.mjs';

export interface S3bMeterSnapshot {
  logicalModelRequests: number;
  logicalEmbeddingRequests: number;
  physicalProviderRequests: number;
  blockedPhysicalRequests: number;
  toolCallProposals: number;
  providerResponseReceipts: number;
  responsesWithoutUsage: number;
  usage: {
    status: 'available' | 'partial' | 'unavailable';
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    source: string | null;
    responseCount: number;
  };
  observedParameters: Array<{
    model: string;
    temperature: number | null;
    maxOutputTokens: number;
    requestedMaxOutputTokens: number | null;
    stream: boolean;
  }>;
  physicalResponses: Array<{ attempt: number; status: number | null; endpointOrigin: string | null }>;
  budgetExhausted: boolean;
}

export interface S3bMeasuredProvider {
  client: LlmClient;
  snapshot(): S3bMeterSnapshot;
}

export function createS3bMeasuredProvider(input: {
  profile: S3bProviderProfile;
  fetchImpl?: typeof fetch;
}): S3bMeasuredProvider {
  const { profile } = input;
  const credentials = profile.credentials;
  const provider = profile.provider;
  if (!profile.ready || !credentials || !provider.physicalRequestBudget || !provider.outputTokenLimit || !provider.timeoutSeconds || !provider.maxAttempts) {
    throw new Error('S3B real Provider configuration is incomplete; run the non-network preflight first.');
  }

  let logicalModelRequests = 0;
  let logicalEmbeddingRequests = 0;
  let physicalProviderRequests = 0;
  let blockedPhysicalRequests = 0;
  let toolCallProposals = 0;
  let providerResponseReceipts = 0;
  let responsesWithoutUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let inputReceiptCount = 0;
  let outputReceiptCount = 0;
  let cachedReceiptCount = 0;
  const observedParameters: S3bMeterSnapshot['observedParameters'] = [];
  const physicalResponses: S3bMeterSnapshot['physicalResponses'] = [];
  let budgetExhausted = false;

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const guardedFetch: typeof fetch = async (resource, init) => {
    if (physicalProviderRequests >= provider.physicalRequestBudget!) {
      blockedPhysicalRequests += 1;
      budgetExhausted = true;
      throw new Error('S3B physical Provider request budget exhausted before network dispatch.');
    }
    physicalProviderRequests += 1;
    let endpointOrigin: string | null = null;
    try {
      const rawUrl = resource instanceof Request ? resource.url : String(resource);
      endpointOrigin = new URL(rawUrl).origin;
    } catch { /* Do not retain a malformed or secret-bearing URL. */ }
    let response: Response;
    try {
      response = await fetchImpl(resource, init);
    } catch (error) {
      physicalResponses.push({ attempt: physicalProviderRequests, status: null, endpointOrigin });
      throw error;
    }
    physicalResponses.push({ attempt: physicalProviderRequests, status: response.status, endpointOrigin });
    return response;
  };

  const base = createLlmClient({
    baseURL: credentials.baseURL,
    apiKey: credentials.apiKey,
    api: credentials.protocol,
    timeoutSeconds: provider.timeoutSeconds,
  }, { fetch: guardedFetch, retry: { maxAttempts: provider.maxAttempts } });

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

  const prepareRequest = (request: ChatRequest): ChatRequest => {
    logicalModelRequests += 1;
    const requestedMaxOutputTokens = request.max_tokens ?? null;
    const max_tokens = Math.min(request.max_tokens ?? provider.outputTokenLimit!, provider.outputTokenLimit!);
    observedParameters.push({
      model: request.model,
      temperature: request.temperature ?? null,
      maxOutputTokens: max_tokens,
      requestedMaxOutputTokens,
      stream: request.stream === true,
    });
    return {
      ...request,
      max_tokens,
      onProviderResponse: receipt => recordReceipt(receipt, request.onProviderResponse),
    };
  };

  const client: LlmClient = {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await base.chat(prepareRequest(request));
      toolCallProposals += response.toolCalls.length;
      return response;
    },
    async chatStream(request: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
      const response = await base.chatStream(prepareRequest(request), onDelta);
      toolCallProposals += response.toolCalls.length;
      return response;
    },
    async embed(request: EmbedRequest): Promise<EmbedResponse> {
      logicalEmbeddingRequests += 1;
      const response = await base.embed(request);
      if (typeof response.usage.promptTokens === 'number') {
        inputTokens += response.usage.promptTokens;
        inputReceiptCount += 1;
      }
      return response;
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
        usage: {
          status: usageStatus,
          inputTokens: inputReceiptCount > 0 ? inputTokens : null,
          outputTokens: outputReceiptCount > 0 ? outputTokens : null,
          cachedInputTokens: cachedReceiptCount > 0 ? cachedInputTokens : null,
          source: providerResponseReceipts > 0 ? 'LlmClient onProviderResponse physical Provider receipts' : null,
          responseCount: providerResponseReceipts,
        },
        observedParameters: [...observedParameters],
        physicalResponses: [...physicalResponses],
        budgetExhausted,
      };
    },
  };
}
