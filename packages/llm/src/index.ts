// @littlesheep/llm — public API

export type {
  ChatRequest,
  ChatMessage,
  ChatContentPart,
  ChatResponse,
  ProviderResponseReceipt,
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
  type OpenAIClientOptions,
  type OpenAICompatibleChatBodyOptions,
} from './client.js';
export { createLlmClient, type LlmProviderConfig } from './create-client.js';
export { AnthropicMessagesClient, type AnthropicMessagesClientOptions } from './anthropic-client.js';
export { OpenAIResponsesClient, type OpenAIResponsesClientOptions } from './responses-client.js';
export {
  IMPLEMENTED_API_PROTOCOLS,
  PROTOCOL_DESCRIPTORS,
  isImplementedApiProtocol,
  protocolHeaders,
  protocolUrl,
  type ApiProtocol,
  type ProtocolClientOptions,
  type ProtocolDescriptor,
} from './protocols.js';
export {
  retryWithBackoff,
  isRetryable,
  classifyFailure,
  retryDelayMs,
  retryAfterHintMs,
  maxRetriesOf,
  DEFAULT_RETRY,
  DEFAULT_MAX_RETRIES,
  type RetryOptions,
  type RetryProgress,
  type RetryFailureClass,
} from './retry.js';
export { zodToJsonSchema, buildToolSpec } from './schema.js';
export {
  containsUnquotedDsmlControlMarkup,
  findUnquotedDsmlControlStart,
  parseDsmlToolCalls,
} from './dsml-tool-calls.js';
export { createIncrementalDsmlControlScanner, type IncrementalDsmlControlScanner } from './dsml-stream-scanner.js';
