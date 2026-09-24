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
import { retryWithBackoff, DEFAULT_RETRY, type RetryOptions, type RetryProgress } from './retry.js';
import {
  attachTransportUsage,
  monotonicNow,
  recordFirstStreamSignal,
  type TransportTiming,
} from './transport-timing.js';
import { containsUnquotedDsmlControlMarkup, parseDsmlToolCalls } from './dsml-tool-calls.js';
import { createIncrementalDsmlControlScanner } from './dsml-stream-scanner.js';

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
  prompt_cache_miss_tokens?: number;
  cache_creation_input_tokens?: number;
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

interface ManagedResponse extends TransportTiming {
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

  /** Client retry options plus a request-level progress observer, when the caller passed one. */
  private retryOptionsFor(
    onTransportRetry?: (progress: RetryProgress) => void,
  ): RetryOptions {
    if (!onTransportRetry) return this.retry;
    return {
      ...this.retry,
      onRetry: (progress) => {
        this.retry.onRetry?.(progress);
        onTransportRetry(progress);
      },
    };
  }

  /** Non-streaming chat. */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const logicalStartedAtMs = monotonicNow();
    let transportAttempt = 0;
    const response = await retryWithBackoff(
      async () => {
        const managed = await this.callApi(req, false, { transportAttempt: ++transportAttempt });
        try {
          const json = (await managed.response.json()) as OpenAIResponse;
          const choice = json.choices[0];
          // Transient provider hiccup (empty choices) → retryable so retryWithBackoff
          // gets a chance instead of killing the call immediately.
          if (!choice) throw new LlmError(500, 'No choices in response', true);
          const parsed = this.parseChoice(choice, json, req);
          return attachTransportUsage(parsed, managed, transportAttempt, logicalStartedAtMs);
        } finally {
          managed.cleanup();
        }
      },
      this.retryOptionsFor(req.onTransportRetry),
      req.signal,
    );
    return response;
  }
  /** Streaming chat. Aggregates chunks, calls onDelta for each. */
  async chatStream(req: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const logicalStartedAtMs = monotonicNow();
    let retryRound = 0;
    let transportAttempt = 0;
    const response = await retryWithBackoff(
      async () => {
        retryRound += 1;
        const managed = await this.callStreamApiWithUsageFallback(
          { ...req, stream: true },
          () => ++transportAttempt,
        );
        let sequence = 0;
        const emit = (chunk: StreamChunk) => onDelta({
          ...chunk,
          transportAttempt: managed.attempt,
          sequence: ++sequence,
          operation: streamChunkOperation(chunk),
        });
        if (retryRound > 1) emit({ type: 'reset' });
        try {
          const parsed = await this.parseStream(
            managed.response,
            emit,
            req,
            (kind) => recordFirstStreamSignal(managed, kind),
          );
          return attachTransportUsage(parsed, managed, transportAttempt, logicalStartedAtMs);
        } finally {
          managed.cleanup();
        }
      },
      this.retryOptionsFor(req.onTransportRetry),
      req.signal,
    );
    return response;
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
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeout);
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
              const errBody = (await res.json()) as { error?: { message: string } };
              if (errBody?.error?.message) errMsg = errBody.error.message;
            } catch { /* ignore parse failure */ }
            throw new LlmError(
              res.status,
              errMsg,
              this.retry.retryableStatuses.includes(res.status),
              parseRetryAfterMs(res.headers),
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
        } catch (err) {
          throw this.timeoutAwareError(err, timedOut, req.signal, timeout);
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
        }
      },
      // Embeddings take the client-level retry options: only chat/stream requests carry a
      // per-request progress observer.
      this.retryOptionsFor(),
      req.signal,
    );
  }
  /** Call the chat/completions endpoint. */
  private async callStreamApiWithUsageFallback(
    req: ChatRequest,
    nextAttempt: () => number,
  ): Promise<ManagedResponse> {
    try {
      return await this.callApi(req, true, {
        includeStreamUsage: true,
        transportAttempt: nextAttempt(),
      });
    } catch (err) {
      if (err instanceof LlmError && (err.status === 400 || err.status === 422)) {
        return this.callApi(req, true, {
          includeStreamUsage: false,
          transportAttempt: nextAttempt(),
        });
      }
      throw err;
    }
  }

  private async callApi(
    req: ChatRequest,
    stream: boolean,
    opts: { includeStreamUsage?: boolean; transportAttempt: number },
  ): Promise<ManagedResponse> {
    const body = buildOpenAICompatibleChatCompletionsBody(req, stream, opts);

    const timeout = req.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    /**
     * Our own deadline is not the caller's cancellation.
     *
     * Both interrupt the same fetch with the same `AbortError`, so a Provider that hangs past
     * the timeout used to be classified as `cancelled` and never retried — the opposite of
     * "respect cancellation, retry transport faults". The flag is what keeps them apart: a
     * deadline that fired becomes a retryable 408, a caller abort stays an abort.
     */
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
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

    const startedAtMs = monotonicNow();
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
        throw new LlmError(res.status, errMsg, retryable, parseRetryAfterMs(res.headers));
      }
      return { response: res, cleanup, attempt: opts.transportAttempt, startedAtMs };
    } catch (err) {
      cleanup();
      throw this.timeoutAwareError(err, timedOut, req.signal, timeout);
    }
  }

  /** Translate our own deadline into a retryable timeout, leaving a caller abort alone. */
  private timeoutAwareError(err: unknown, timedOut: boolean, callerSignal: AbortSignal | undefined, timeoutMs: number): unknown {
    if (!timedOut || callerSignal?.aborted) return err;
    return new LlmError(408, `Request timed out after ${timeoutMs}ms`, true);
  }
  /** Parse a non-streaming choice into ChatResponse. */
  private parseChoice(choice: OpenAIChoice, raw: OpenAIResponse, request: ChatRequest): ChatResponse {
    let toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    let content = choice.message.content ?? '';
    if (toolCalls.length > 0 && containsUnquotedDsmlControlMarkup(content)) {
      throw new LlmError(502, 'Provider returned conflicting native and DSML tool calls', false);
    }
    if (toolCalls.length === 0) {
      const recovered = parseDsmlToolCalls(content, requestToolNames(request));
      if (recovered) {
        toolCalls = recovered.toolCalls;
        content = recovered.content;
      } else if (containsUnquotedDsmlControlMarkup(content)) {
        throw new LlmError(502, 'Provider returned invalid or unauthorized DSML tool markup', false);
      }
    }
    return {
      content,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : this.mapFinishReason(choice.finish_reason),
      reasoningContent: choice.message.reasoning_content ?? undefined,
      usage: parseUsage(raw.usage),
      model: raw.model,
    };
  }

  /** Parse an SSE stream, invoking onDelta for each chunk. */
  private async parseStream(
    res: Response,
    onDelta: (chunk: StreamChunk) => void,
    request: ChatRequest,
    onFirstSignal: (kind: 'content' | 'reasoning' | 'tool_arguments') => void,
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
    let dsmlContentMode = false;
    let dsmlToolNamePublished = false;
    /**
     * Whether the Provider itself said the answer was over (`[DONE]` or a `finish_reason`).
     *
     * A transport that drops mid-answer closes the body exactly like a finished stream, so
     * "the reader ended" is not completion. Treating it as completion published a truncated
     * answer as a settled reply — measured in the real window with an injected stream cut.
     * Only a Provider signal counts; a stream that carried content but never signalled
     * completion is a retryable transport failure (see the check after the read loop).
     */
    let sawTerminalSignal = false;
    const dsmlScanner = createIncrementalDsmlControlScanner();

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
        if (data === '[DONE]') {
          sawTerminalSignal = true;
          continue;
        }
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
        if (fr) sawTerminalSignal = true;
        if (delta?.content) {
          onFirstSignal('content');
          content += delta.content;
          const dsmlStart = dsmlContentMode ? -1 : dsmlScanner.append(delta.content);
          if (!dsmlContentMode && dsmlStart >= 0) {
            dsmlContentMode = true;
            onDelta({ type: 'reset' });
            const visiblePrefix = content.slice(0, dsmlStart).trim();
            if (visiblePrefix) onDelta({ type: 'delta', delta: visiblePrefix });
          }
          if (dsmlContentMode) {
            const name = dsmlToolNamePublished ? undefined : dsmlInvokeName(content);
            onDelta({
              type: 'tool_call_delta',
              toolCallIndex: 0,
              ...(!dsmlToolNamePublished && name ? { toolCallName: name } : {}),
              toolCallArgsDelta: delta.content,
            });
            if (name) dsmlToolNamePublished = true;
          } else {
            onDelta({ type: 'delta', delta: delta.content });
          }
        }
        if (delta?.reasoning_content) {
          onFirstSignal('reasoning');
          reasoningContent += delta.reasoning_content;
          onDelta({ type: 'reasoning_delta', delta: delta.reasoning_content });
        }
        if (delta?.tool_calls) {
          onFirstSignal('tool_arguments');
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
    // A stream that carried an answer but never signalled completion was cut in transit.
    // Publishing it would settle a truncated reply as an authoritative one (the real-window
    // fixture injects exactly this); 502 keeps it in the replay-safe transport class, so the
    // bounded retry re-sends the request and the caller clears its streamed preview with the
    // `reset` chunk it already gets for any retry round. An empty stream is left alone: empty
    // output has its own bounded handling upstream.
    if (!sawTerminalSignal && (content.length > 0 || reasoningContent.length > 0 || toolCallMap.size > 0)) {
      throw new LlmError(502, 'Stream ended before the provider signalled completion', true);
    }
    let toolCalls = Array.from(toolCallMap.values()).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));
    if (toolCalls.length > 0 && containsUnquotedDsmlControlMarkup(content)) {
      onDelta({ type: 'reset' });
      throw new LlmError(502, 'Provider returned conflicting native and DSML tool calls', false);
    }
    if (toolCalls.length === 0) {
      const recovered = parseDsmlToolCalls(content, requestToolNames(request));
      if (recovered) {
        toolCalls = recovered.toolCalls;
        content = recovered.content;
        finishReason = 'tool_calls';
        // Retract DSML content already accumulated by transcript consumers.
        if (!dsmlContentMode) {
          onDelta({ type: 'reset' });
          if (content) onDelta({ type: 'delta', delta: content });
        }
      } else if (containsUnquotedDsmlControlMarkup(content)) {
        onDelta({ type: 'reset' });
        throw new LlmError(502, 'Provider returned invalid or unauthorized DSML tool markup', false);
      }
    }
    onDelta({ type: 'done', finishReason });
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
  // DeepSeek's native cache fields are authoritative; the OpenAI-compatible
  // `prompt_tokens_details.cached_tokens` is only a fallback, because a provider
  // that emits an explicit 0 there must not hide a real native hit.
  const cachedPromptTokens = usage.prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens;
  // Keep the provider's own miss count when it reports one, so the three
  // counters stay disjoint (billed input = uncached + cached + cache write).
  const uncachedPromptTokens = usage.prompt_cache_miss_tokens
    ?? (cachedPromptTokens === undefined ? undefined : Math.max(0, promptTokens - cachedPromptTokens));
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const cacheWriteTokens = usage.cache_creation_input_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(uncachedPromptTokens === undefined ? {} : { uncachedPromptTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function requestToolNames(request: ChatRequest): Set<string> {
  return new Set((request.tools ?? []).map((tool) => tool.function.name));
}

function dsmlInvokeName(value: string): string | undefined {
  return /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke\s+name="([^"]+)"/iu.exec(value)?.[1];
}

function streamChunkOperation(chunk: StreamChunk): NonNullable<StreamChunk['operation']> {
  if (chunk.type === 'reset') return 'reset';
  if (chunk.type === 'done') return 'replace';
  return 'append';
}

/**
 * `Retry-After` as milliseconds. Accepts delay-seconds and an HTTP-date, clamps to a sane
 * ceiling, and returns undefined when the header is absent or unusable — a provider hint is
 * a floor for the next wait, never a reason to wait forever.
 */
function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(120_000, Math.floor(seconds * 1000));
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? Math.min(120_000, delta) : undefined;
  }
  return undefined;
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
