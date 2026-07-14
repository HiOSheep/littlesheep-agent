// @littlesheep/llm — client.ts
// OpenAI-compatible LLM client implementation.

import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  LlmClient,
  StreamChunk,
  ToolCall,
} from './types.js';
import { LlmError } from './types.js';
import { retryWithBackoff, DEFAULT_RETRY, type RetryOptions } from './retry.js';

export interface OpenAIClientOptions {
  baseURL: string;
  apiKey?: string;
  /** Default timeout in ms (default: 120000). */
  timeoutMs?: number;
  /** Custom fetch (for testing). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Retry options. */
  retry?: Partial<RetryOptions>;
  /** Extra headers. */
  headers?: Record<string, string>;
}

interface OpenAIChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }[];
  };
  finish_reason: string;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    type?: 'function';
    function: { name?: string; arguments?: string };
  }[];
}

interface OpenAIStreamChunk {
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
  model?: string;
}

interface OpenAIEmbeddingItem {
  index: number;
  embedding: number[];
}

interface OpenAIEmbeddingResponse {
  model: string;
  data: OpenAIEmbeddingItem[];
  usage?: { prompt_tokens: number };
}

interface ManagedResponse {
  response: Response;
  cleanup: () => void;
}

export interface OpenAICompatibleChatBodyOptions {
  includeStreamUsage?: boolean;
}

/** Build the exact JSON body shape used by the OpenAI-compatible chat endpoint. */
export function buildOpenAICompatibleChatCompletionsBody(
  req: ChatRequest,
  stream: boolean,
  opts: OpenAICompatibleChatBodyOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream,
  };
  if (stream && opts.includeStreamUsage) body.stream_options = { include_usage: true };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
  if (req.reasoning_effort !== undefined) body.reasoning_effort = req.reasoning_effort;
  if (req.thinking !== undefined) body.thinking = req.thinking;
  return body;
}

/**
 * OpenAI-compatible chat.completions client.
 * Works with OpenAI, Azure OpenAI, vLLM, Ollama, OpenRouter, etc.
 */
export class OpenAIClient implements LlmClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryOptions;
  private readonly headers: Record<string, string>;

  constructor(opts: OpenAIClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.headers = opts.headers ?? {};
  }

  /** Build request headers. */
  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** Non-streaming chat. */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    return retryWithBackoff(
      async () => {
        const managed = await this.callApi(req, false);
        try {
          const json = (await managed.response.json()) as OpenAIResponse;
          const choice = json.choices[0];
          // Transient provider hiccup (empty choices) → retryable so retryWithBackoff
          // gets a chance instead of killing the call immediately.
          if (!choice) throw new LlmError(500, 'No choices in response', true);
          return this.parseChoice(choice, json);
        } finally {
          managed.cleanup();
        }
      },
      this.retry,
      req.signal,
    );
  }

  /** Streaming chat. Aggregates chunks, calls onDelta for each. */
  async chatStream(req: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    return retryWithBackoff(
      async () => {
        const managed = await this.callStreamApiWithUsageFallback({ ...req, stream: true });
        try {
          const { content, toolCalls, finishReason, model, usage, reasoningContent } = await this.parseStream(managed.response, onDelta);
          return { content, toolCalls, finishReason, model, usage, reasoningContent };
        } finally {
          managed.cleanup();
        }
      },
      this.retry,
      req.signal,
    );
  }

  /** Generate text embeddings via the /embeddings endpoint. */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return retryWithBackoff(
      async () => {
        const body: Record<string, unknown> = {
          model: req.model,
          input: req.input,
        };
        if (req.dimensions !== undefined) body.dimensions = req.dimensions;

        const timeout = req.timeoutMs ?? this.timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const onAbort = () => controller.abort();
        if (req.signal) {
          if (req.signal.aborted) controller.abort();
          else req.signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          const res = await this.fetchFn(`${this.baseURL}/embeddings`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!res.ok) {
            let errMsg = `HTTP ${res.status}`;
            try {
              const errBody = (await res.json()) as { error?: { message?: string } };
              if (errBody?.error?.message) errMsg = errBody.error.message;
            } catch { /* ignore parse failure */ }
            throw new LlmError(
              res.status,
              errMsg,
              this.retry.retryableStatuses.includes(res.status),
            );
          }
          const json = (await res.json()) as OpenAIEmbeddingResponse;
          // Sort by index to guarantee input order (OpenAI returns in order, but be defensive).
          const sorted = [...json.data].sort((a, b) => a.index - b.index);
          return {
            embeddings: sorted.map((d) => d.embedding),
            model: json.model,
            usage: { promptTokens: json.usage?.prompt_tokens ?? 0 },
          };
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
        }
      },
      this.retry,
      req.signal,
    );
  }

  /** Call the chat/completions endpoint. */
  private async callStreamApiWithUsageFallback(req: ChatRequest): Promise<ManagedResponse> {
    try {
      return await this.callApi(req, true, { includeStreamUsage: true });
    } catch (err) {
      if (err instanceof LlmError && (err.status === 400 || err.status === 422)) {
        return this.callApi(req, true, { includeStreamUsage: false });
      }
      throw err;
    }
  }

  private async callApi(
    req: ChatRequest,
    stream: boolean,
    opts: { includeStreamUsage?: boolean } = {},
  ): Promise<ManagedResponse> {
    const body = buildOpenAICompatibleChatCompletionsBody(req, stream, opts);

    const timeout = req.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let cleaned = false;
    const onAbort = () => controller.abort();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    };
    // Chain with caller's signal
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        let retryable = false;
        try {
          const errBody = (await res.json()) as { error?: { message?: string } };
          if (errBody?.error?.message) errMsg = errBody.error.message;
        } catch { /* ignore parse failure */ }
        if (this.retry.retryableStatuses.includes(res.status)) retryable = true;
        throw new LlmError(res.status, errMsg, retryable);
      }
      return { response: res, cleanup };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  /** Parse a non-streaming choice into ChatResponse. */
  private parseChoice(choice: OpenAIChoice, raw: OpenAIResponse): ChatResponse {
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason),
      reasoningContent: choice.message.reasoning_content ?? undefined,
      usage: parseUsage(raw.usage),
      model: raw.model,
    };
  }

  /** Parse an SSE stream, invoking onDelta for each chunk. */
  private async parseStream(
    res: Response,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<{
    content: string;
    toolCalls: ToolCall[];
    finishReason: ChatResponse['finishReason'];
    model?: string;
    usage?: ChatResponse['usage'];
    reasoningContent?: string;
  }> {
    if (!res.body) throw new LlmError(500, 'No response body for stream', false);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: ChatResponse['finishReason'] = 'stop';
    let model: string | undefined;
    let usage: ChatResponse['usage'];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        if (!model && (chunk as { model?: string }).model) {
          model = (chunk as { model?: string }).model;
        }
        const parsedUsage = parseUsage(chunk.usage ?? undefined);
        if (parsedUsage) usage = parsedUsage;
        const delta = chunk.choices[0]?.delta;
        const fr = chunk.choices[0]?.finish_reason;
        if (delta?.content) {
          content += delta.content;
          onDelta({ type: 'delta', delta: delta.content });
        }
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          onDelta({ type: 'reasoning_delta', delta: delta.reasoning_content });
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallMap.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
            toolCallMap.set(tc.index, existing);
            onDelta({
              type: 'tool_call_delta',
              toolCallIndex: tc.index,
              toolCallId: tc.id,
              toolCallName: tc.function?.name,
              toolCallArgsDelta: tc.function?.arguments,
            });
          }
        }
        if (fr) finishReason = this.mapFinishReason(fr);
      }
    }
    onDelta({ type: 'done', finishReason });
    const toolCalls = Array.from(toolCallMap.values()).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));
    return {
      content,
      toolCalls,
      finishReason,
      model,
      usage,
      reasoningContent: reasoningContent || undefined,
    };
  }

  private mapFinishReason(fr: string | null | undefined): ChatResponse['finishReason'] {
    switch (fr) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      // Unknown / provider-specific finish reasons must NOT default to 'stop' —
      // 'stop' makes EXECUTE treat the run as complete (→ EVOLVE) even when the
      // model may have intended a tool call. 'length' routes to RECOVER instead,
      // which is the safe choice for an unexpected termination signal.
      default: return 'length';
    }
  }
}

function parseUsage(usage: OpenAIUsage | null | undefined): ChatResponse['usage'] | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/** Build an LlmClient from a ModelProvider config. */
export function createLlmClient(provider: {
  baseURL: string;
  apiKey?: string;
  timeoutSeconds?: number;
}, opts?: { fetch?: typeof fetch; retry?: Partial<RetryOptions> }): LlmClient {
  return new OpenAIClient({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    timeoutMs: provider.timeoutSeconds ? provider.timeoutSeconds * 1000 : undefined,
    fetch: opts?.fetch,
    retry: opts?.retry,
  });
}
