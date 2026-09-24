// @littlesheep/llm — retry.ts
// Bounded retry for transient Provider failures.
//
// `maxAttempts` counts **total requests**: the first request plus every retry. The default
// is therefore `DEFAULT_MAX_RETRIES + 1`, because the product expectation is "the first
// request, then at most five retries". `maxRetries` is the friendlier spelling and is only
// consulted when the caller did not pass `maxAttempts`.
//
// Only failures that are safe to replay are retried: transient transport/provider errors
// (network failure, 5xx, empty choices) and rate limiting. Authentication, request payload,
// unknown and cancelled failures are never replayed — a retry would either fail the same way
// or repeat something we cannot prove is replay-safe.

/** Why a call failed, from the point of view of "may we send it again?". */
export type RetryFailureClass =
  /** Transport/provider hiccup: replaying is safe. */
  | 'transient'
  /** 429 (or an equivalent hint): replay, but respect the provider's own delay. */
  | 'rate_limited'
  /** 401/403: a configuration/credential problem, never replay. */
  | 'auth'
  /** 4xx payload or routing problem (400/404/422/…), never replay. */
  | 'request'
  /** User or system cancellation, never replay. */
  | 'cancelled'
  /** Nothing is known about this failure; do not replay. */
  | 'unknown';

/** What the caller needs to render "第 n 次重试 / 最多 5 次" and to record the attempt. */
export interface RetryProgress {
  /** 1-based number of the retry that is about to happen (not the failed attempt). */
  retry: number;
  maxRetries: number;
  delayMs: number;
  failureClass: RetryFailureClass;
  status?: number;
  error: unknown;
}

export interface RetryOptions {
  /** TOTAL requests: the first one plus the retries. */
  maxAttempts: number;
  /** Alternative spelling: retries after the first request (ignored when `maxAttempts` is set). */
  maxRetries?: number;
  baseDelayMs: number;
  factor: number;
  jitter: boolean;
  /** Upper bound for a single wait, including a provider hint. */
  maxDelayMs: number;
  /** Status codes considered retryable. */
  retryableStatuses: number[];
  /** Called once before each retry with the attempt number and the planned wait. */
  onRetry?: (progress: RetryProgress) => void;
}

/** The product expectation: the first request plus at most five retries. */
export const DEFAULT_MAX_RETRIES = 5;

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: DEFAULT_MAX_RETRIES + 1,
  baseDelayMs: 500,
  factor: 2,
  jitter: true,
  maxDelayMs: 30_000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('status' in err)) return undefined;
  const value = (err as { status?: unknown }).status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'AbortSignal';
}

/** A provider-supplied delay (Retry-After), if the failure carries one. */
export function retryAfterHintMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('retryAfterMs' in err)) return undefined;
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Classify a failure so callers can decide whether a replay is safe. */
export function classifyFailure(err: unknown, opts: RetryOptions = DEFAULT_RETRY): RetryFailureClass {
  if (isAbortError(err)) return 'cancelled';
  const status = statusOf(err);
  if (status !== undefined) {
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) return 'auth';
    if (opts.retryableStatuses.includes(status) || status === 408) return 'transient';
    if (status >= 400 && status < 500) return 'request';
    return 'unknown';
  }
  // Network errors (fetch failed) are retryable.
  if (err instanceof TypeError) return 'transient';
  if (err && typeof err === 'object' && 'retryable' in err) {
    return (err as { retryable: boolean }).retryable ? 'transient' : 'unknown';
  }
  return 'unknown';
}

/** True when this failure may be replayed. */
export function isRetryable(err: unknown, opts: RetryOptions = DEFAULT_RETRY): boolean {
  const failureClass = classifyFailure(err, opts);
  return failureClass === 'transient' || failureClass === 'rate_limited';
}

/** The number of retries a run of these options allows (total attempts minus the first). */
export function maxRetriesOf(opts: Partial<RetryOptions> = {}): number {
  return Math.max(0, resolveMaxAttempts(opts) - 1);
}

function resolveMaxAttempts(opts: Partial<RetryOptions>): number {
  const explicitRetries = opts.maxAttempts === undefined ? opts.maxRetries : undefined;
  if (explicitRetries !== undefined) return Math.max(1, Math.trunc(explicitRetries) + 1);
  const attempts = opts.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  return Math.max(1, Math.trunc(attempts));
}

/** Exponential backoff for the given failed attempt, raised to a provider hint, and capped. */
export function retryDelayMs(attempt: number, opts: RetryOptions, hintMs?: number): number {
  const backoff = opts.baseDelayMs * Math.pow(opts.factor, Math.max(0, attempt - 1));
  const withHint = hintMs !== undefined && hintMs > backoff ? hintMs : backoff;
  return Math.min(opts.maxDelayMs, Math.max(0, Math.floor(withHint)));
}

function abortedError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** Sleep, but stop waiting the moment the caller cancels. */
function sleep(ms: number, jitter: boolean, signal?: AbortSignal): Promise<void> {
  const delay = jitter && ms > 0 ? ms + Math.floor(Math.random() * ms * 0.3) : ms;
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delay));
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry a function with bounded exponential backoff.
 * Throws the last error if every attempt fails, and does not retry classes that are unsafe
 * to replay (see `classifyFailure`).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
  signal?: AbortSignal,
): Promise<T> {
  const config = { ...DEFAULT_RETRY, ...opts };
  const maxAttempts = resolveMaxAttempts(opts);
  const maxRetries = Math.max(0, maxAttempts - 1);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw abortedError();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const failureClass = classifyFailure(err, config);
      const replayable = failureClass === 'transient' || failureClass === 'rate_limited';
      if (attempt >= maxAttempts || !replayable) throw err;
      const delayMs = retryDelayMs(attempt, config, retryAfterHintMs(err));
      const status = statusOf(err);
      config.onRetry?.({
        retry: attempt,
        maxRetries,
        delayMs,
        failureClass,
        ...(status === undefined ? {} : { status }),
        error: err,
      });
      await sleep(delayMs, config.jitter, signal);
    }
  }
  throw lastErr;
}
