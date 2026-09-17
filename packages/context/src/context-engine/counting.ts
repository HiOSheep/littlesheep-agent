import { Buffer } from 'node:buffer';
import type { ModelTokenizerCapability } from '@littlesheep/config';
import {
  buildOpenAICompatibleChatCompletionsBody,
  type ChatRequest,
} from '@littlesheep/llm';
import type {
  ContextSafetyEstimator,
  ExactContextTokenCounter,
} from './contracts.js';
import type { ContextSafetyEstimate } from '@littlesheep/types';
import {
  DEFAULT_CONTEXT_SAFETY_ESTIMATOR_ID,
  DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE,
  DEFAULT_REQUEST_PROMPT_TOKEN_SAFETY_RESERVE,
} from './contracts.js';

export interface ExactCounterResolution {
  counter?: ExactContextTokenCounter;
  reason: string;
}

/** Conservative-estimate evidence recorded when only the safety estimator ran. */
export function buildSafetyEstimate(input: {
  provider: string;
  model: string;
  estimatorId: string;
  estimatedPromptTokens: number;
  calculatedAt: string;
}): ContextSafetyEstimate {
  return {
    version: 1,
    source: 'local',
    accuracy: 'conservative',
    purpose: 'overflow_protection',
    provider: input.provider,
    model: input.model,
    estimatorId: input.estimatorId,
    estimatedPromptTokens: input.estimatedPromptTokens,
    calculatedAt: input.calculatedAt,
    displayable: false,
  };
}

export const defaultContextSafetyEstimator: ContextSafetyEstimator = Object.freeze({
  id: DEFAULT_CONTEXT_SAFETY_ESTIMATOR_ID,
  estimatePromptTokens(request: ChatRequest): number {
    let imageCount = 0;
    const normalizedRequest: ChatRequest = {
      ...request,
      messages: request.messages.map((message) => {
        if (typeof message.content === 'string') return message;
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === 'text') return part;
            imageCount++;
            return {
              type: 'image_url' as const,
              image_url: {
                url: '[image-content-accounted-by-safety-reserve]',
                detail: part.image_url.detail,
              },
            };
          }),
        };
      }),
    };
    const body = buildOpenAICompatibleChatCompletionsBody(
      normalizedRequest,
      true,
      { includeStreamUsage: true },
    );
    const serialized = JSON.stringify(body);
    if (!serialized) throw new Error('request payload could not be serialized');
    return Buffer.byteLength(serialized, 'utf8')
      + DEFAULT_REQUEST_PROMPT_TOKEN_SAFETY_RESERVE
      + imageCount * DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE;
  },
});

export function validTokenCount(value: number, source: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${source} returned an invalid value`);
  }
  return value;
}

export function resolveExactCounter(
  capability: ModelTokenizerCapability | undefined,
  counter: ExactContextTokenCounter | undefined,
  provider: string,
  model: string,
): ExactCounterResolution {
  const modelRef = `${provider}/${model}`;
  if (!capability) {
    return { reason: `No tokenizer capability classification is registered for ${modelRef}.` };
  }
  if (capability.status === 'unavailable') {
    return { reason: capability.reason };
  }
  if (!counter) {
    return { reason: `Exact token counter ${capability.counterId} is declared for ${modelRef} but is not registered.` };
  }
  if (counter.id !== capability.counterId) {
    return {
      reason: `Exact token counter mismatch for ${modelRef}: expected ${capability.counterId}, received ${counter.id}.`,
    };
  }
  try {
    if (!counter.supports(provider, model)) {
      return { reason: `Exact token counter ${counter.id} does not support ${modelRef}.` };
    }
  } catch (error) {
    return { reason: `Exact token counter ${counter.id} capability check failed: ${(error as Error).message}` };
  }
  return { counter, reason: '' };
}
