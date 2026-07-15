import type { ModelContextWindowCapability } from '@littlesheep/config';
import type { PrepareContextRequestInput } from './contracts.js';
import {
  DEFAULT_COMPRESSION_THRESHOLD_RATIO,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
} from './contracts.js';

export interface ResolvedContextBudget {
  provider: string;
  model: string;
  capability?: ModelContextWindowCapability;
  reservedOutputTokens: number;
  availablePromptTokens?: number;
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
  return {
    provider,
    model,
    capability,
    reservedOutputTokens,
    availablePromptTokens: capability
      ? Math.max(0, capability.maxContextTokens - reservedOutputTokens)
      : undefined,
    compressionThresholdRatio: clampCompressionRatio(
      input.compressionThresholdRatio ?? DEFAULT_COMPRESSION_THRESHOLD_RATIO,
    ),
  };
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
