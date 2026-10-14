// @littlesheep/llm — anthropic-client.ts
// Anthropic Messages wire-protocol client (`POST {baseURL}/messages`).
//
// `types.ts` is the protocol-neutral contract every client in this package implements, and
// `anthropic-translate.ts` owns the Anthropic SHAPES and the translation to and from them.
// This file owns only the impure half: the HTTP call, the event-stream driving, the retry
// envelope and the provider-usage receipts. The control flow deliberately mirrors
// `client.ts` so a caller cannot tell which protocol answered.

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
import { recordFirstStreamSignal, attachTransportUsage, monotonicNow } from './transport-timing.js';
import {
  callApi,
  parseSseJson,
  readSseFrames,
  reportProviderResponse,
  streamChunkOperation,
  type ManagedResponse,
} from './protocol-transport.js';
import { PROTOCOL_DESCRIPTORS, protocolHeaders, protocolUrl, type ApiProtocol } from './protocols.js';
import {
  asRecord,
  asUsage,
  blockIndexOf,
  buildAnthropicMessagesBody,
  collectToolCalls,
  emptyResponse,
  mapStopReason,
  mergeStreamUsage,
  parseResponse,
  parseUsage,
  type AnthropicResponse,
} from './anthropic-translate.js';

const PROTOCOL: ApiProtocol = 'anthropic-messages';

export interface AnthropicMessagesClientOptions {
  baseURL: string;
  apiKey?: string;
  /** Default timeout in ms (default: 120000). */
  timeoutMs?: number;
  /** Custom fetch (for testing). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Retry options. */
  retry?: Partial<RetryOptions>;
  /** Extra headers (gateway routing, provider overrides). */
  headers?: Record<string, string>;
}

/**
 * Anthropic Messages client (`AnthropicMessagesClient`).
 *
 * Unlike the OpenAI-shaped clients, `embed()` always throws: Anthropic publishes no
 * embeddings endpoint, and inventing one (or silently proxying to another vendor) would put
 * a caller's data somewhere the configuration never named.
 */
export class AnthropicMessagesClient implements LlmClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryOptions;
  private readonly headers: Record<string, string>;

  constructor(opts: AnthropicMessagesClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.headers = opts.headers ?? {};
  }

  /** `protocolHeaders` owns the auth scheme (`x-api-key`) and `anthropic-version`. */
  private buildHeaders(): Record<string, string> {
    return protocolHeaders(PROTOCOL_DESCRIPTORS[PROTOCOL], this.apiKey, this.headers);
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
    return this.withRetry(req, false, async (managed) => {
      const json = (await managed.response.json()) as AnthropicResponse;
      const usage = parseUsage(json.usage);
      await reportProviderResponse(req, {
        attempt: managed.attempt,
        usage: usage
          ? attachTransportUsage(emptyResponse(req.model, usage), managed, 1, managed.startedAtMs).usage
          : undefined,
        completed: true,
      });
      // A 200 without any content block is a provider hiccup, not an answer: retry rather
      // than settle an empty reply (the empty-choices rule `client.ts` applies).
      if (!Array.isArray(json.content) || json.content.length === 0) {
        throw new LlmError(500, 'No content blocks in response', true);
      }
      return attachTransportUsage(parseResponse(json, req), managed, managed.attempt, logicalStartedAtMs);
    });
  }

  /** Streaming chat. Aggregates chunks, calls `onDelta` for each, mirrors OpenAIClient. */
  async chatStream(req: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const logicalStartedAtMs = monotonicNow();
    let retryRound = 0;
    return this.withRetry({ ...req, stream: true }, true, async (managed) => {
      let sequence = 0;
      const emit = (chunk: StreamChunk) => onDelta({
        ...chunk,
        transportAttempt: managed.attempt,
        sequence: ++sequence,
        operation: streamChunkOperation(chunk),
      });
      // Every attempt after the first may follow text the caller already displayed, so it opens
      // with an explicit retraction (the OpenAI client does the same).
      if (retryRound > 1) emit({ type: 'reset' });
      const parsed = await this.parseStream(
        managed.response,
        emit,
        req,
        (kind) => recordFirstStreamSignal(managed, kind),
        managed,
      );
      return attachTransportUsage(parsed, managed, managed.attempt, logicalStartedAtMs);
    }, () => { retryRound += 1; });
  }

  /** Anthropic has no embeddings endpoint; see the class comment. */
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    // Status 0 keeps this out of every HTTP classification: it is a caller mistake, not a
    // transport failure, so `retryable: false` must be taken from the error, not inferred.
    throw new LlmError(
      0,
      `Provider protocol '${PROTOCOL}' does not support embeddings: the Anthropic Messages API `
      + 'has no /embeddings endpoint. Configure an embedding-capable provider for this model.',
      false,
    );
  }

  /**
   * Run one logical call under the shared retry envelope.
   *
   * The attempt counter, the deadline and `managed.cleanup()` are the parts that are easy to
   * get wrong per call site, so the envelope lives here once and each caller supplies only its
   * own response handling.
   */
  private async withRetry(
    req: ChatRequest,
    stream: boolean,
    handle: (managed: ManagedResponse) => Promise<ChatResponse>,
    onAttempt?: () => void,
  ): Promise<ChatResponse> {
    let transportAttempt = 0;
    return retryWithBackoff(
      async () => {
        onAttempt?.();
        const managed = await this.callApi(req, stream, { transportAttempt: ++transportAttempt });
        try {
          return await handle(managed);
        } finally {
          // Release the deadline timer and the caller's abort listener on every path.
          managed.cleanup();
        }
      },
      this.retryOptionsFor(req.onTransportRetry),
      req.signal,
    );
  }

  /**
   * Anthropic's own reading of a failed response body.
   *
   * The Messages API nests the explanation at `error.message` and adds an `error.type` that
   * says whether the key, the model or the payload was wrong, so both are surfaced.
   */
  private static parseErrorMessage(body: unknown): string | undefined {
    const error = asRecord(asRecord(body)?.error);
    const message = error?.message;
    if (typeof message !== 'string' || message.length === 0) return undefined;
    return typeof error?.type === 'string' ? `${message} (${error.type})` : message;
  }

  /** Send one physical request; the shared `callApi` owns the deadline and the error mapping. */
  private async callApi(
    req: ChatRequest,
    stream: boolean,
    opts: { transportAttempt: number },
  ): Promise<ManagedResponse> {
    const body = buildAnthropicMessagesBody(req, stream);
    return callApi(
      this.fetchFn,
      protocolUrl(this.baseURL, PROTOCOL_DESCRIPTORS[PROTOCOL].path),
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      {
        timeoutMs: req.timeoutMs ?? this.timeoutMs,
        signal: req.signal,
        retry: this.retry,
        transportAttempt: opts.transportAttempt,
        parseErrorMessage: AnthropicMessagesClient.parseErrorMessage,
      },
    );
  }

  /**
   * Parse one Anthropic SSE stream, invoking `onDelta` for each neutral chunk.
   *
   * Anthropic frames every event as `event: <name>` + `data: <json>` and never sends a
   * `[DONE]` sentinel: `message_stop` is the terminal signal. Framing is delegated to
   * `readSseFrames`, which owns the blank-line rules, `\r\n`, multi-line `data:` and the
   * trailing frame that arrives without a terminating blank line.
   */
  private async parseStream(
    res: Response,
    onDelta: (chunk: StreamChunk) => void,
    request: ChatRequest,
    onFirstSignal: (kind: 'content' | 'reasoning' | 'tool_arguments') => void,
    timing: ManagedResponse,
  ): Promise<ChatResponse> {
    const state: StreamState = {
      content: '',
      reasoningContent: '',
      toolCalls: new Map(),
      sawTerminalSignal: false,
    };
    try {
      for await (const frame of readSseFrames(res)) {
        // Anthropic types its stream by event name AND repeats the type in the payload. The
        // event name is authoritative for the terminal signal: a frame whose payload cannot be
        // parsed is dropped, so `message_stop` must be honoured from the name alone.
        if (frame.event === 'message_stop') state.sawTerminalSignal = true;
        const payload = parseSseJson<Record<string, unknown>>(frame.data);
        if (!payload) continue;
        applyStreamEvent(
          typeof payload.type === 'string' ? payload.type : frame.event,
          payload,
          state,
          onDelta,
          onFirstSignal,
        );
      }
    } finally {
      // The receipt is dispatched even when the loop threw: usage already received was already
      // billed, and a transport that dropped must not hide it.
      await reportProviderResponse(request, {
        attempt: timing.attempt,
        usage: state.usage
          ? attachTransportUsage(emptyResponse(request.model, state.usage), timing, 1, timing.startedAtMs).usage
          : undefined,
        completed: state.sawTerminalSignal,
      });
    }
    if (!state.sawTerminalSignal
      && (state.content.length > 0 || state.reasoningContent.length > 0 || state.toolCalls.size > 0)) {
      // 502 lands in the replay-safe transport class, so the bounded retry re-sends it; the
      // caller clears its streamed preview with the `reset` chunk it already receives.
      throw new LlmError(502, 'Stream ended before the provider signalled completion', true);
    }
    const calls = collectToolCalls(state.toolCalls);
    const finishReason: ChatResponse['finishReason'] = calls.length > 0
      ? 'tool_calls'
      : mapStopReason(state.stopReason);
    onDelta({ type: 'done', finishReason });
    return {
      content: state.content,
      toolCalls: calls,
      finishReason,
      ...(state.reasoningContent ? { reasoningContent: state.reasoningContent } : {}),
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    };
  }
}

/** Everything one Anthropic stream accumulates, plus the signal that it actually finished. */
interface StreamState {
  content: string;
  reasoningContent: string;
  /** Tool blocks are addressed by content-block index, so index is the key. */
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  stopReason?: string;
  model?: string;
  usage?: ChatResponse['usage'];
  sawTerminalSignal: boolean;
}

/**
 * Apply one parsed stream event.
 *
 * Anthropic's event set is small and closed; anything else (`ping`, `content_block_stop`, a
 * future event type) carries nothing this client needs, so it is ignored rather than guessed at.
 */
function applyStreamEvent(
  type: string,
  payload: Record<string, unknown>,
  state: StreamState,
  onDelta: (chunk: StreamChunk) => void,
  onFirstSignal: (kind: 'content' | 'reasoning' | 'tool_arguments') => void,
): void {
  if (type === 'message_start') {
    const message = asRecord(payload.message);
    if (!state.model && typeof message?.model === 'string') state.model = message.model;
    state.usage = mergeStreamUsage(state.usage, asUsage(message?.usage));
    return;
  }
  if (type === 'message_stop') {
    state.sawTerminalSignal = true;
    return;
  }
  if (type === 'error') {
    const error = asRecord(payload.error);
    // A provider error mid-stream is replay-safe (the run never received an answer), so it
    // enters the retryable transport class rather than ending the run.
    throw new LlmError(502, typeof error?.message === 'string' ? error.message : 'Provider stream error', true);
  }
  if (type === 'message_delta') {
    // The terminal stop reason arrives here, as does the AUTHORITATIVE output usage:
    // `message_start` opens with a placeholder output count (`output_tokens: 1`) before any
    // token is generated, so this frame's value has to replace it.
    if (typeof payload.stop_reason === 'string') {
      state.stopReason = payload.stop_reason;
      state.sawTerminalSignal = true;
    }
    state.usage = mergeStreamUsage(state.usage, asUsage(payload.usage));
    return;
  }
  if (type === 'content_block_start') {
    const block = asRecord(payload.content_block);
    if (!block) return;
    const index = blockIndexOf(payload);
    if (block.type === 'tool_use') {
      onFirstSignal('tool_arguments');
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      state.toolCalls.set(index, { id, name, args: '' });
      // A tool block is identified only by this start event, so the id and name are published
      // here; the caller has nothing else to learn them from.
      onDelta({ type: 'tool_call_delta', toolCallIndex: index, toolCallId: id, toolCallName: name });
      return;
    }
    // Some gateways repeat the opening text/thinking inside `content_block_start`; dropping it
    // would silently lose the first characters of the answer.
    const opening = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined;
    if (typeof opening === 'string' && opening) emitFragment(block.type, opening, state, onDelta, onFirstSignal);
    return;
  }
  if (type === 'content_block_delta') {
    const delta = asRecord(payload.delta);
    if (!delta) return;
    if (delta.type === 'input_json_delta') {
      // Tool arguments arrive as JSON fragments and are only valid once joined.
      const index = blockIndexOf(payload);
      const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
      const existing = state.toolCalls.get(index) ?? { id: '', name: '', args: '' };
      existing.args += partial;
      state.toolCalls.set(index, existing);
      onFirstSignal('tool_arguments');
      onDelta({ type: 'tool_call_delta', toolCallIndex: index, toolCallArgsDelta: partial });
      return;
    }
    const text = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : undefined;
    if (typeof text === 'string' && text) emitFragment(delta.type, text, state, onDelta, onFirstSignal);
  }
}

/** Accumulate and publish one text or thinking fragment, whether it opened a block or continued one. */
function emitFragment(
  kind: unknown,
  text: string,
  state: StreamState,
  onDelta: (chunk: StreamChunk) => void,
  onFirstSignal: (kind: 'content' | 'reasoning' | 'tool_arguments') => void,
): void {
  if (kind === 'thinking' || kind === 'thinking_delta') {
    onFirstSignal('reasoning');
    state.reasoningContent += text;
    onDelta({ type: 'reasoning_delta', delta: text });
    return;
  }
  onFirstSignal('content');
  state.content += text;
  onDelta({ type: 'delta', delta: text });
}
