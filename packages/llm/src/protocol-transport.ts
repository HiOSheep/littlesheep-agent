// @littlesheep/llm — protocol-transport.ts
// The protocol-neutral half of any wire client: transport, retries, receipts and
// SSE framing.
//
// Three clients now speak three different vendor formats, but the parts that are
// NOT about a vendor were identical in every one of them: the deadline around a
// fetch, `Retry-After` parsing, the retryable-status decision, the provider-usage
// receipt, and reading an SSE byte stream into frames. Copying that per client
// meant three places to fix one transport bug, and the copies drift silently
// because each client's own tests only exercise its own copy.
//
// Everything here is vendor-agnostic by construction. If a helper would have to
// know that Anthropic uses `tool_use` or that Responses uses
// `response.output_item.added`, it belongs in that client's file instead — a
// "shared" module that knows vendor shapes is worse than the duplication it
// replaced.

import type { ChatRequest, StreamChunk } from './types.js';
import { LlmError } from './types.js';
import { createRequestDeadline } from './request-deadline.js';
import { monotonicNow, type TransportTiming } from './transport-timing.js';
import type { RetryOptions } from './retry.js';

/** A provider response plus the cleanup and timing identity that must travel with it. */
export interface ManagedResponse extends TransportTiming {
  response: Response;
  cleanup: () => void;
  attempt: number;
  startedAtMs: number;
}

/**
 * `Retry-After` as milliseconds. Accepts delay-seconds and an HTTP-date, clamps to a
 * sane ceiling, and returns undefined when the header is absent or unusable — a
 * provider hint is a floor for the next wait, never a reason to wait forever.
 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
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

/**
 * Turn a non-ok response into the error the retry loop understands.
 *
 * `parseMessage` is supplied by the caller because error bodies are genuinely
 * vendor-shaped (Anthropic nests `{error:{message}}`, Responses adds `type`/`code`).
 * Forcing one parser on both would mean losing the provider's own explanation, which
 * is the only thing that makes a 400 actionable for a user.
 */
export async function httpError(
  response: Response,
  retry: RetryOptions,
  parseMessage?: (body: unknown) => string | undefined,
): Promise<LlmError> {
  let message = `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    const parsed = parseMessage?.(body)
      ?? (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof parsed === 'string' && parsed) message = parsed;
  } catch { /* a non-JSON error body is not itself an error worth reporting */ }
  const retryable = retry.retryableStatuses.includes(response.status);
  return new LlmError(response.status, message, retryable, parseRetryAfterMs(response.headers));
}

/** True when this status is one the client is configured to retry. */
export function isRetryableStatus(status: number, retry: RetryOptions): boolean {
  return retry.retryableStatuses.includes(status);
}

/**
 * Dispatch one provider-usage receipt.
 *
 * A receipt that cannot be durably recorded must NOT be swallowed: the caller has
 * already been billed for this response, and silently continuing would let the run
 * replay a paid call. Failing closed here is the whole point.
 */
export async function reportProviderResponse(
  request: ChatRequest,
  receipt: Parameters<NonNullable<ChatRequest['onProviderResponse']>>[0],
): Promise<void> {
  try {
    await request.onProviderResponse?.(receipt);
  } catch {
    throw new LlmError(0, 'Provider usage receipt could not be durably recorded', false);
  }
}

/** How a streamed chunk mutates the consumer's accumulated text. */
export function streamChunkOperation(chunk: StreamChunk): NonNullable<StreamChunk['operation']> {
  if (chunk.type === 'reset') return 'reset';
  if (chunk.type === 'done') return 'replace';
  return 'append';
}

/**
 * Run one physical request under a deadline.
 *
 * The vendor-specific parts stay with the caller: it builds the URL, headers and
 * body and passes a ready `RequestInit`. What is shared is the part that is easy to
 * get subtly wrong per client — arming the deadline, releasing it on every path, and
 * translating an abort into this package's error type.
 */
export async function callApi(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    retry: RetryOptions;
    transportAttempt: number;
    parseErrorMessage?: (body: unknown) => string | undefined;
  },
): Promise<ManagedResponse> {
  const deadline = createRequestDeadline(options.timeoutMs, options.signal);
  const startedAtMs = monotonicNow();
  try {
    const response = await fetchFn(url, { ...init, signal: deadline.signal });
    if (!response.ok) throw await httpError(response, options.retry, options.parseErrorMessage);
    return {
      response,
      cleanup: () => deadline.cleanup(),
      attempt: options.transportAttempt,
      startedAtMs,
    };
  } catch (error) {
    deadline.cleanup();
    throw deadline.translate(error);
  }
}

/**
 * Decode an SSE body into `{ event, data }` frames.
 *
 * The framing rules that matter and are easy to get wrong: a frame is terminated by a
 * blank line, `data:` may repeat within one frame, and a frame split across two
 * network chunks must not be parsed until it is complete. `event:` is optional and
 * defaults to `message` — Responses ignores it, but Anthropic's whole stream is typed
 * by it, so the shared reader has to surface it.
 */
export async function* readSseFrames(response: Response): AsyncGenerator<{ event: string; data: string }> {
  const body = response.body;
  if (!body) throw new LlmError(response.status, 'Provider returned a stream with no body', true);
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = (): { event: string; data: string } | null => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return null;
    }
    const frame = { event: eventName, data: dataLines.join('\n') };
    eventName = 'message';
    dataLines = [];
    return frame;
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    // The last element is an incomplete line unless the chunk ended on a newline.
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        const frame = flush();
        if (frame) yield frame;
        continue;
      }
      // A comment/heartbeat line (`:` prefix) keeps the connection alive; it carries no data.
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /u, ''));
      }
    }
  }
  // A final frame that was not followed by a blank line still counts.
  buffer += decoder.decode();
  if (buffer.trim()) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /u, ''));
  }
  const trailing = flush();
  if (trailing) yield trailing;
}

/** Parse one frame's `data:` payload, treating an unparsable frame as absent. */
export function parseSseJson<T = unknown>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    // A truncated or corrupt frame is dropped, exactly like the OpenAI stream parser
    // has always done. Throwing here would kill the whole run stream on one bad
    // frame, losing every later event — including the one carrying the result.
    return undefined;
  }
}

/** The `[DONE]` sentinel OpenAI-shaped streams use to end the exchange. */
export function isSseDoneSentinel(data: string): boolean {
  return data.trim() === '[DONE]';
}
