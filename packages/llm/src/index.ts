// @littlesheep/llm — public API

export type {
  ChatRequest,
  ChatMessage,
  ChatContentPart,
  ChatResponse,
  ChatTransportMetrics,
  ToolSpec,
  ToolCall,
  StreamChunk,
  EmbedRequest,
  EmbedResponse,
  LlmClient,
} from './types.js';
export { LlmError } from './types.js';

export {
  OpenAIClient,
  buildOpenAICompatibleChatCompletionsBody,
  createLlmClient,
  type OpenAIClientOptions,
  type OpenAICompatibleChatBodyOptions,
} from './client.js';
export { retryWithBackoff, isRetryable, DEFAULT_RETRY, type RetryOptions } from './retry.js';
export { zodToJsonSchema, buildToolSpec } from './schema.js';
export {
  containsUnquotedDsmlControlMarkup,
  findUnquotedDsmlControlStart,
  parseDsmlToolCalls,
} from './dsml-tool-calls.js';
export { createIncrementalDsmlControlScanner, type IncrementalDsmlControlScanner } from './dsml-stream-scanner.js';
