// @littlesheep/llm — public API

export type {
  ChatRequest,
  ChatMessage,
  ChatContentPart,
  ChatResponse,
  ToolSpec,
  ToolCall,
  StreamChunk,
  EmbedRequest,
  EmbedResponse,
  LlmClient,
} from './types.js';
export { LlmError } from './types.js';

export { OpenAIClient, createLlmClient, type OpenAIClientOptions } from './client.js';
export { retryWithBackoff, isRetryable, DEFAULT_RETRY, type RetryOptions } from './retry.js';
export { zodToJsonSchema, buildToolSpec } from './schema.js';
