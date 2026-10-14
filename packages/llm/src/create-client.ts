// @littlesheep/llm — create-client.ts
// Protocol dispatch: the one place that decides which wire client a provider gets.
//
// Kept out of `client.ts` deliberately. `client.ts` owns the OpenAI
// chat-completions wire format; the factory owns the *selection* between three
// sibling protocols. Folding the selection into the chat-completions file meant
// that file imported both other clients, which is how a protocol-neutral concern
// ends up buried in a vendor module.

import type { LlmClient } from './types.js';
import { OpenAIClient } from './client.js';
import { AnthropicMessagesClient } from './anthropic-client.js';
import { OpenAIResponsesClient } from './responses-client.js';
import type { RetryOptions } from './retry.js';

/** The provider fields the factory reads. Mirrors `ModelProvider` without importing config. */
export interface LlmProviderConfig {
  baseURL: string;
  apiKey?: string;
  timeoutSeconds?: number;
  headers?: Record<string, string>;
  /** Wire protocol; absent means the OpenAI-compatible default. */
  api?: string;
}

/**
 * Build an LlmClient from a ModelProvider config.
 *
 * `api` decides WHICH client is built. It used to be ignored, so a provider
 * configured to speak Anthropic Messages was silently driven with
 * chat-completions bodies and failed as an opaque 4xx inside a run. An unknown
 * protocol is a programming error by this point — the config schema rejects it at
 * load (`PROVIDER_API_PROTOCOLS`) — so this throws rather than falling back to a
 * protocol the endpoint may not implement.
 */
export function createLlmClient(
  provider: LlmProviderConfig,
  opts?: { fetch?: typeof fetch; retry?: Partial<RetryOptions> },
): LlmClient {
  const options = {
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    timeoutMs: provider.timeoutSeconds ? provider.timeoutSeconds * 1000 : undefined,
    headers: provider.headers,
    fetch: opts?.fetch,
    retry: opts?.retry,
  };
  const protocol = provider.api ?? 'openai-chat-completions';
  if (protocol === 'openai-chat-completions') return new OpenAIClient(options);
  if (protocol === 'anthropic-messages') return new AnthropicMessagesClient(options);
  if (protocol === 'openai-responses') return new OpenAIResponsesClient(options);
  throw new Error(`llm: unsupported provider api "${protocol}"`);
}
