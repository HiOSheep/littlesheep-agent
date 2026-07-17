import type { ModelContextWindowCapability } from '@littlesheep/config';
import type { PrepareContextRequestInput } from './contracts.js';
import {
  DEFAULT_COMPRESSION_THRESHOLD_RATIO,
  DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
} from './contracts.js';

export interface ResolvedContextBudget {
  provider: string;
  model: string;
  capability?: ModelContextWindowCapability;
  reservedOutputTokens: number;
  availablePromptTokens?: number;
  targetPromptTokens?: number;
  compressionThresholdRatio: number;
}

export function resolveContextBudget(
  input: PrepareContextRequestInput,
  resolveContextWindow: (provider: string, model: string) => ModelContextWindowCapability | undefined,
): ResolvedContextBudget {
  const provider = input.provider ?? providerFromModelRef(input.request.model);
  const model = modelFromRef(input.request.model);
  const capability = resolveContextWindow(provider, model);
  const reservedOutputTokens = input.request.max_tokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  const modelAvailablePromptTokens = capability
    ? Math.max(0, capability.maxContextTokens - reservedOutputTokens)
    : undefined;
  const contractBasePromptLimit = input.callContract?.budget.maxPromptTokens;
  const contractPromptLimit = contractBasePromptLimit === undefined
    ? undefined
    : contractBasePromptLimit + (requestHasImage(input.request) ? DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE : 0);
  return {
    provider,
    model,
    capability,
    reservedOutputTokens,
    availablePromptTokens: modelAvailablePromptTokens,
    targetPromptTokens: modelAvailablePromptTokens === undefined
      ? contractPromptLimit
      : contractPromptLimit === undefined
        ? modelAvailablePromptTokens
        : Math.min(modelAvailablePromptTokens, contractPromptLimit),
    compressionThresholdRatio: clampCompressionRatio(
      input.compressionThresholdRatio ?? DEFAULT_COMPRESSION_THRESHOLD_RATIO,
    ),
  };
}

function requestHasImage(request: PrepareContextRequestInput['request']): boolean {
  return request.messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part.type === 'image_url'));
}

export function shouldRecommendCompression(
  measurement: number | undefined,
  availablePromptTokens: number | undefined,
  thresholdRatio: number,
): boolean {
  return measurement !== undefined
    && availablePromptTokens !== undefined
    && availablePromptTokens > 0
    && measurement / availablePromptTokens >= thresholdRatio;
}

function providerFromModelRef(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : 'unknown';
}

function modelFromRef(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

function clampCompressionRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPRESSION_THRESHOLD_RATIO;
  return Math.min(0.95, Math.max(0.5, value));
}
