// @littlesheep/llm — types.ts
// LLM client types: chat requests, responses, streaming, tool calling.

/** A function tool spec in OpenAI chat.completions format. */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema object describing parameters. */
    parameters: object;
  };
}

/** A chat message in OpenAI chat.completions format. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  /** Provider-supplied reasoning that must be replayed for interleaved tool calls. */
  reasoning_content?: string;
  /** Assistant messages may carry tool_calls. */
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  /** Tool-role messages reference the call they answer. */
  tool_call_id?: string;
  name?: string;
}

/** Request to chat.completions. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  /** OpenAI-compatible provider reasoning effort. */
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** DeepSeek/GLM thinking-mode control. */
  thinking?: {
    type: 'enabled' | 'disabled';
    clear_thinking?: boolean;
  };
  stream?: boolean;
  signal?: AbortSignal;
  /** Override per-request timeout (ms). */
  timeoutMs?: number;
  /**
   * Transport-retry progress for this request (UX-21): called before each retry with the
   * retry number, the planned wait and the failure class, so the caller can show
   * "第 n 次重试 / 最多 5 次" and record it. Settings come from the client's retry options.
   */
  onTransportRetry?: (progress: import('./retry.js').RetryProgress) => void;
}

/** A tool call returned by the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTransportMetrics {
  durationMs: number;
  requestElapsedMs: number;
  transportAttempt: number;
  observedAttemptCount: number;
  ttftMs?: number;
  contentTtftMs?: number;
  reasoningTtftMs?: number;
  toolArgumentsTtftMs?: number;
}

/** Non-streaming chat response. */
export interface ChatResponse {
  /** Text content (empty when only tool_calls returned). */
  content: string;
  /** Tool calls requested by the model (empty when finish_reason !== 'tool_calls'). */
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  /** Provider reasoning, retained for tool-call continuation but not shown as final reply text. */
  reasoningContent?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens?: number;
    cachedPromptTokens?: number;
    /** Input tokens that missed the provider cache; disjoint from cachedPromptTokens. */
    uncachedPromptTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    /** Successful physical HTTP attempt duration; excludes retry backoff. */
    durationMs?: number;
    /** Whole logical call duration, including retry and backoff. */
    requestElapsedMs?: number;
    /** Physical attempt that supplied this response, starting at 1. */
    transportAttempt?: number;
    /** Physical attempts observed for the logical call. */
    observedAttemptCount?: number;
    /** Dispatch-to-first streamed model signal; unavailable for non-streaming calls. */
    ttftMs?: number;
    /** Dispatch-to-first visible text delta. */
    contentTtftMs?: number;
    /** Dispatch-to-first reasoning delta. */
    reasoningTtftMs?: number;
    /** Dispatch-to-first tool argument/name delta. */
    toolArgumentsTtftMs?: number;
  };
  /** Raw model id echoed back. */
  model?: string;
  /** Transport timing remains available even when the Provider omits token usage. */
  transport?: ChatTransportMetrics;
}

/** A single chunk in a stream. */
export interface StreamChunk {
  type: 'delta' | 'reset' | 'reasoning_delta' | 'tool_call_delta' | 'done';
  /** Text delta (for type: 'delta'). */
  delta?: string;
  /** Tool call index (for type: 'tool_call_delta'). */
  toolCallIndex?: number;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArgsDelta?: string;
  finishReason?: ChatResponse['finishReason'];
  /** Physical transport identity supplied by clients that own the HTTP retry loop. */
  transportAttempt?: number;
  /** Monotonic sequence within one physical attempt. */
  sequence?: number;
  operation?: 'append' | 'replace' | 'reset';
}

/** Request to the embeddings endpoint. */
export interface EmbedRequest {
  model: string;
  /** Single text or batch of texts (max 2048 per OpenAI limits). */
  input: string | string[];
  /** Output dimensions (only supported by some models, e.g. text-embedding-3-*). */
  dimensions?: number;
  /** Override per-request timeout (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Response from the embeddings endpoint. */
export interface EmbedResponse {
  /** One embedding per input, in input order. */
  embeddings: number[][];
  model: string;
  usage: { promptTokens: number };
}

/** LLM client contract. Implementations: OpenAIClient. */
export interface LlmClient {
  /** Non-streaming chat. */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Streaming chat. Aggregates chunks and returns final ChatResponse. */
  chatStream(req: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse>;
  /** Generate text embeddings (vector representations). */
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

/** Error from the LLM API. */
export class LlmError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** Provider-supplied wait (Retry-After), honoured as a floor by the retry loop. */
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.retryAfterMs = Math.floor(retryAfterMs);
    }
  }
}
