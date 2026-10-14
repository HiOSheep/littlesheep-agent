// @littlesheep/llm — responses-client.ts
// OpenAI **Responses API** (`POST /responses`) client.
//
// Responses is a different wire protocol from chat.completions even though one host serves both.
// It renames the request field (`input`), the token budget (`max_output_tokens`), and the entire
// stream format (typed SSE events instead of `chat.completion.chunk` deltas). A client that
// "reuses" the chat-completions body gets a 400 for every call.
//
// The split between this file and its neighbours is deliberate:
//  - `protocol-transport.ts` owns what no protocol owns: deadlines, retries, receipts, SSE framing;
//  - `responses-translate.ts` owns the pure neutral <-> Responses shapes;
//  - this file owns the class, its HTTP calls, and the STATEFUL stream interpreter, which carries
//    the live tool-call map across events and therefore cannot be pure.
//
// The request/response lifecycle — retry envelope, transport receipts, timing, the neutral
// `StreamChunk` shape — is deliberately identical to `OpenAIClient`, because the harness switches
// protocol without changing how it consumes a model call.

import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  LlmClient,
  StreamChunk,
} from './types.js';
import { LlmError } from './types.js';
import { retryWithBackoff, DEFAULT_RETRY, type RetryOptions, type RetryProgress } from './retry.js';
import {
  attachTransportUsage,
  monotonicNow,
  recordFirstStreamSignal,
  type TransportTiming,
} from './transport-timing.js';
import {
  callApi as callProtocolApi,
  isSseDoneSentinel,
  parseSseJson,
  readSseFrames,
  reportProviderResponse,
  streamChunkOperation,
  type ManagedResponse,
} from './protocol-transport.js';
import {
  finishReasonOf,
  isRetryableStreamStatus,
  parseResponsesOutput,
  parseResponsesUsage,
  receiptUsage,
  responsesErrorMessage,
  serializeToolCalls,
  statusField,
  stringField,
  type ParsedEvent,
  type PendingToolCall,
  type ResponsesEmbeddingResponse,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  type StreamResult,
} from './responses-translate.js';
import { buildResponsesRequestBody } from './responses-translate.js';
import { PROTOCOL_DESCRIPTORS, protocolHeaders, protocolUrl } from './protocols.js';
import { createProviderSessionId, providerRequestHeaders } from './provider-headers.js';

/** The wire facts for this protocol, taken from the registry rather than written out here. */
const DESCRIPTOR = PROTOCOL_DESCRIPTORS['openai-responses'];

/**
 * Embeddings are not part of the Responses protocol. The Responses service is generation-only;
 * every OpenAI-compatible gateway still exposes the classic `POST /embeddings` (same JSON as
 * chat.completions), so a Responses-configured provider must reach that sibling path.
 */
const EMBEDDINGS_PATH = '/embeddings';

export interface OpenAIResponsesClientOptions {
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

/**
 * OpenAI Responses API client.
 *
 * Speaks the same neutral `LlmClient` contract as `OpenAIClient`, including the retry envelope,
 * per-attempt transport receipts and `StreamChunk` sequencing, so the harness can switch protocol
 * per provider without changing anything above this package.
 */
export class OpenAIResponsesClient implements LlmClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryOptions;
  private readonly headers: Record<string, string>;
  private readonly fallbackSessionId = createProviderSessionId();

  constructor(opts: OpenAIResponsesClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.headers = opts.headers ?? {};
  }

  /** Build request headers, including the gateway session id when this endpoint wants one. */
  private buildHeaders(req?: ChatRequest): Record<string, string> {
    const { baseURL, apiKey, headers, fallbackSessionId } = this;
    // `providerRequestHeaders` owns provider-level concerns (configured headers, client user
    // agent, per-endpoint gateway session header); `protocolHeaders` owns the protocol's auth
    // scheme. The protocol layer runs first so an explicit provider header of the same name wins.
    const protocol = protocolHeaders(DESCRIPTOR, apiKey);
    return providerRequestHeaders(
      { baseURL, apiKey, configured: { ...protocol, ...headers }, fallbackSessionId },
      req?.conversationId,
    );
  }

  /** Client retry options plus a request-level progress observer, when the caller passed one. */
  private retryOptionsFor(onTransportRetry?: (progress: RetryProgress) => void): RetryOptions {
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
    return retryWithBackoff(
      async () => {
        const managed = await this.callApi(req, false, ++transportAttempt);
        try {
          const json = (await managed.response.json()) as ResponsesResponse;
          const usage = parseResponsesUsage(json.usage);
          await reportProviderResponse(req, {
            attempt: managed.attempt,
            usage: usage ? receiptUsage(req, usage, managed) : undefined,
            completed: true,
          });
          // A payload with no `output` array is a provider hiccup, not an empty answer: 500 +
          // retryable so the bounded retry gets its chance, exactly as the chat-completions
          // client does for a missing `choices`.
          if (!Array.isArray(json.output)) throw new LlmError(500, 'No output items in response', true);
          return attachTransportUsage(
            parseResponsesOutput(json),
            managed,
            transportAttempt,
            logicalStartedAtMs,
          );
        } finally {
          managed.cleanup();
        }
      },
      this.retryOptionsFor(req.onTransportRetry),
      req.signal,
    );
  }

  /** Streaming chat. Aggregates chunks, calls onDelta for each. */
  async chatStream(req: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const logicalStartedAtMs = monotonicNow();
    let retryRound = 0;
    let transportAttempt = 0;
    return retryWithBackoff(
      async () => {
        retryRound += 1;
        const managed = await this.callApi(req, true, ++transportAttempt);
        let sequence = 0;
        const emit = (chunk: StreamChunk) => onDelta({
          ...chunk,
          transportAttempt: managed.attempt,
          sequence: ++sequence,
          operation: streamChunkOperation(chunk),
        });
        // A retry re-sends the same request, so the consumer must clear whatever the failed
        // attempt already painted before the new attempt's chunks arrive.
        if (retryRound > 1) emit({ type: 'reset' });
        try {
          const parsed = await this.parseStream(
            managed.response,
            emit,
            req,
            (kind) => recordFirstStreamSignal(managed, kind),
            managed,
          );
          return attachTransportUsage(parsed, managed, transportAttempt, logicalStartedAtMs);
        } finally {
          managed.cleanup();
        }
      },
      this.retryOptionsFor(req.onTransportRetry),
      req.signal,
    );
  }

  /**
   * Generate text embeddings.
   *
   * Responses is generation-only, so this goes to the classic `POST /embeddings` sibling with the
   * chat-completions body (`{model, input, dimensions?}`) and the classic
   * `{data:[{index, embedding}], model, usage:{prompt_tokens}}` parse.
   */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return retryWithBackoff(
      async () => {
        const body: Record<string, unknown> = { model: req.model, input: req.input };
        if (req.dimensions !== undefined) body.dimensions = req.dimensions;

        const managed = await this.callApiAt(EMBEDDINGS_PATH, body, req.timeoutMs, req.signal);
        try {
          const json = (await managed.response.json()) as ResponsesEmbeddingResponse;
          // Sort by index to guarantee input order (OpenAI returns in order, but be defensive).
          const sorted = [...json.data].sort((a, b) => a.index - b.index);
          return {
            embeddings: sorted.map((d) => d.embedding),
            model: json.model,
            usage: { promptTokens: json.usage?.prompt_tokens ?? 0 },
          };
        } finally {
          managed.cleanup();
        }
      },
      // Embeddings take the client-level retry options: only chat/stream requests carry a
      // per-request progress observer.
      this.retryOptionsFor(),
      req.signal,
    );
  }

  /** POST one physical request to `/responses`. Only the URL, headers and body are ours. */
  private async callApi(req: ChatRequest, stream: boolean, transportAttempt: number): Promise<ManagedResponse> {
    return this.callApiAt(
      DESCRIPTOR.path,
      buildResponsesRequestBody(req, stream),
      req.timeoutMs ?? this.timeoutMs,
      req.signal,
      transportAttempt,
    );
  }

  /** One deadline-guarded fetch against a path of this protocol's host. */
  private async callApiAt(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    transportAttempt = 0,
  ): Promise<ManagedResponse> {
    return callProtocolApi(
      this.fetchFn,
      protocolUrl(this.baseURL, path),
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      {
        timeoutMs: timeoutMs ?? this.timeoutMs,
        signal,
        retry: this.retry,
        transportAttempt,
        parseErrorMessage: responsesErrorMessage,
      },
    );
  }

  /** Parse the typed Responses SSE stream, invoking onDelta for each neutral chunk. */
  private async parseStream(
    res: Response,
    onDelta: (chunk: StreamChunk) => void,
    request: ChatRequest,
    onFirstSignal: (kind: 'content' | 'reasoning' | 'tool_arguments') => void,
    timing: TransportTiming,
  ): Promise<StreamResult> {
    let content = '';
    let reasoningContent = '';
    let model: string | undefined;
    let usage: ChatResponse['usage'];
    let incomplete = false;
    /**
     * The provider's own completion signal. A dropped transport closes the body exactly like a
     * finished stream, so "the reader ended" is not completion; only `response.completed` /
     * `response.incomplete` counts (see the check after the loop).
     */
    let sawTerminalSignal = false;
    /**
     * Tool calls keyed by `output_index`, the only stable key while arguments stream: Responses
     * never puts `call_id`/`name` on the argument deltas, so identity arrives later and could not
     * key the accumulation. The index is also the `toolCallIndex` the consumer expects.
     */
    const toolCalls = new Map<number, PendingToolCall>();

    try {
      for await (const frame of readSseFrames(res)) {
        // Responses has no `[DONE]` sentinel, but a gateway in front of one sometimes adds it;
        // treating it as terminal keeps such a stream from looking cut in transit.
        if (isSseDoneSentinel(frame.data)) {
          sawTerminalSignal = true;
          continue;
        }
        const event = parseSseJson<ResponsesStreamEvent>(frame.data);
        if (!event) continue;
        const parsed = parseStreamEvent(event, toolCalls);
        if (!parsed) continue;
        if (parsed.completed) sawTerminalSignal = true;
        if (parsed.error) {
          // A failed response can still carry billable usage; the receipt in `finally` reports
          // it before this error unwinds.
          onDelta({ type: 'reset' });
          throw parsed.error;
        }
        if (parsed.usage) usage = parsed.usage;
        if (parsed.model) model = parsed.model;
        if (parsed.finishReason === 'length') incomplete = true;
        if (parsed.reasoning) {
          onFirstSignal('reasoning');
          reasoningContent += parsed.reasoning;
          onDelta({ type: 'reasoning_delta', delta: parsed.reasoning });
        }
        if (parsed.delta) {
          onFirstSignal('content');
          content += parsed.delta;
          onDelta({ type: 'delta', delta: parsed.delta });
        }
        if (parsed.argsDelta || parsed.toolCallName) {
          // A name delta is already the first identity signal for the consumer, so it counts as
          // the tool-arguments TTFT just like chat-completions' `tool_calls` delta does.
          onFirstSignal('tool_arguments');
          onDelta({
            type: 'tool_call_delta',
            toolCallIndex: parsed.toolCallIndex,
            ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
            ...(parsed.toolCallName ? { toolCallName: parsed.toolCallName } : {}),
            ...(parsed.argsDelta ? { toolCallArgsDelta: parsed.argsDelta } : {}),
          });
        }
      }
    } finally {
      // Dispatched on every exit path, including a mid-stream provider error: the response has
      // already been billed and the caller must be able to record it.
      await reportProviderResponse(request, {
        attempt: timing.attempt,
        usage: usage ? receiptUsage(request, usage, timing) : undefined,
        completed: sawTerminalSignal,
      });
    }
    // A stream that carried an answer but never signalled completion was cut in transit.
    // Publishing it would settle a truncated reply as authoritative, so it stays in the
    // replay-safe transport class (502) for the bounded retry to re-send.
    if (!sawTerminalSignal && (content.length > 0 || reasoningContent.length > 0 || toolCalls.size > 0)) {
      throw new LlmError(502, 'Stream ended before the provider signalled completion', true);
    }
    const finishReason = finishReasonOf(incomplete, toolCalls.size > 0);
    onDelta({ type: 'done', finishReason });
    return {
      content,
      toolCalls: serializeToolCalls(toolCalls),
      finishReason,
      model,
      usage,
      reasoningContent: reasoningContent || undefined,
    };
  }
}

/**
 * Interpret one typed SSE event against the live tool-call map.
 *
 * This stays stateful on purpose: it mutates the accumulated calls for the stream. Returns
 * undefined for events that carry nothing to translate. Note what is intentionally ignored —
 * events that only *restate* something already streamed (`response.output_text.done`,
 * `response.reasoning_summary_text.done`, `response.function_call_arguments.done`) would
 * duplicate content the consumer already applied.
 */
function parseStreamEvent(
  event: ResponsesStreamEvent,
  toolCalls: Map<number, PendingToolCall>,
): ParsedEvent | undefined {
  const index = typeof event.output_index === 'number' ? event.output_index : undefined;
  switch (event.type) {
    // Lifecycle frames with no payload: they exist so a client can tell "accepted" from
    // "generating". Nothing to emit, but not errors either.
    case 'response.created':
    case 'response.in_progress':
      return undefined;

    case 'response.output_item.added':
      return itemAdded(event, toolCalls);

    case 'response.output_text.delta':
    case 'response.refusal.delta': {
      // A refusal is text the user must see; the neutral contract has no separate stream for it.
      return typeof event.delta === 'string' && event.delta.length > 0
        ? { delta: event.delta }
        : undefined;
    }

    // The complete text of one part. The consumer already has it from the deltas, so emitting it
    // again would double the reply.
    case 'response.output_text.done':
    case 'response.reasoning_summary_text.done':
    case 'response.function_call_arguments.done':
      return undefined;

    case 'response.reasoning_summary_text.delta':
      return typeof event.delta === 'string' && event.delta.length > 0
        ? { reasoning: event.delta }
        : undefined;

    case 'response.function_call_arguments.delta': {
      if (typeof event.delta !== 'string' || event.delta.length === 0 || index === undefined) return undefined;
      const call = pendingCall(toolCalls, index);
      call.args += event.delta;
      // Re-state the identity alongside the arguments: this delta is usually the first chunk a
      // consumer sees for the index, and it must be able to bind the arguments to a call.
      return { ...(identityEvent(call, index) ?? {}), toolCallIndex: index, argsDelta: event.delta };
    }

    // A completed item is where a function call's `call_id` and `name` are known. Emit them as
    // one `tool_call_delta` so the consumer can bind arguments it already received to a real call.
    case 'response.output_item.done':
      return itemDone(event, toolCalls);

    case 'response.completed':
    case 'response.incomplete': {
      const response = event.response;
      return {
        completed: true,
        usage: parseResponsesUsage(response?.usage),
        model: response?.model,
        // `max_output_tokens` is a length stop; any other incomplete reason is not something the
        // neutral contract can express, so it maps to `stop` and lets the caller read the answer.
        finishReason: event.type === 'response.incomplete'
          ? (response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop')
          : undefined,
      };
    }

    case 'response.failed':
      return { completed: true, error: responseFailure(event) };

    case 'error':
      return { error: eventError(event) };

    default:
      // Unknown event types are forward-compatible noise (a provider may add frames at any time);
      // failing on one would break every call the day a new event appears.
      return undefined;
  }
}

/** Register a function call the moment the provider announces it. */
function itemAdded(event: ResponsesStreamEvent, toolCalls: Map<number, PendingToolCall>): ParsedEvent | undefined {
  const item = event.item;
  if (!item || item.type !== 'function_call') return undefined;
  const index = typeof event.output_index === 'number' ? event.output_index : 0;
  const call = pendingCall(toolCalls, index);
  const callId = stringField(item, 'call_id');
  const name = stringField(item, 'name');
  if (callId) call.id = callId;
  if (name) call.name = name;
  // Publish the identity as soon as it is known; a stream that ends without an `output_item.done`
  // still leaves the consumer holding a usable call.
  return identityEvent(call, index);
}

/** Publish a completed function call's identity, plus any arguments the final item carries. */
function itemDone(event: ResponsesStreamEvent, toolCalls: Map<number, PendingToolCall>): ParsedEvent | undefined {
  const item = event.item;
  if (!item || item.type !== 'function_call') return undefined;
  const index = typeof event.output_index === 'number' ? event.output_index : 0;
  const call = pendingCall(toolCalls, index);
  const callId = stringField(item, 'call_id');
  const name = stringField(item, 'name');
  const args = stringField(item, 'arguments');
  if (callId) call.id = callId;
  if (name) call.name = name;
  // A provider that streams no argument deltas puts the whole string on the final item; take it
  // only when nothing was accumulated, so a re-stated value cannot double the arguments.
  const argsDelta = args && call.args === '' ? args : undefined;
  if (argsDelta) call.args = args;
  const identity = identityEvent(call, index);
  if (!identity && argsDelta === undefined) return undefined;
  return { toolCallIndex: index, ...(identity ?? {}), ...(argsDelta ? { argsDelta } : {}) };
}

/**
 * The identity fields for one tool-call chunk, or undefined when nothing is known yet.
 *
 * Identity is republished on **every** chunk of a call, not just the first. The argument deltas
 * are separate chunks, and a consumer that starts an accumulator when it first sees an index
 * needs `call_id`/`name` on that same chunk — otherwise it holds arguments it cannot bind to a
 * call. Republishing is cheap and idempotent: these are not incremental values.
 */
function identityEvent(call: PendingToolCall, index: number): ParsedEvent | undefined {
  if (!call.id && !call.name) return undefined;
  call.emittedIdentity = true;
  return {
    toolCallIndex: index,
    ...(call.id ? { toolCallId: call.id } : {}),
    ...(call.name ? { toolCallName: call.name } : {}),
  };
}

function pendingCall(toolCalls: Map<number, PendingToolCall>, index: number): PendingToolCall {
  const existing = toolCalls.get(index);
  if (existing) return existing;
  const created: PendingToolCall = { id: '', name: '', args: '', emittedIdentity: false };
  toolCalls.set(index, created);
  return created;
}

/** `response.failed`: an established stream died. Transport-shaped, so replay-safe. */
function responseFailure(event: ResponsesStreamEvent): LlmError {
  return new LlmError(
    // Not an HTTP status, but 502 keeps it inside the retryable class.
    502,
    event.response?.error?.message || 'Responses stream failed',
    true,
  );
}

/** An `error` frame, classified by the status it carries the way an HTTP status would be. */
function eventError(event: ResponsesStreamEvent): LlmError {
  const error = event.error;
  const message = typeof error === 'string' ? error : error?.message || 'Responses stream error';
  const status = statusField(error, 'status') ?? statusField(error, 'code') ?? 502;
  return new LlmError(status, message, isRetryableStreamStatus(status));
}
