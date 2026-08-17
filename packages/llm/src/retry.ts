// @littlesheep/llm — retry.ts
// Exponential backoff retry for transient failures.

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  jitter: boolean;
  /** Status codes considered retryable. */
  retryableStatuses: number[];
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  jitter: true,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/** Check if an error is retryable (LlmError with retryable=true, or network error). */
export function isRetryable(err: unknown, _opts: RetryOptions = DEFAULT_RETRY): boolean {
  if (err && typeof err === 'object' && 'retryable' in err) {
    return (err as { retryable: boolean }).retryable;
  }
  // Network errors (TypeError: fetch failed) are retryable
  if (err instanceof TypeError) return true;
  return false;
}

/** Sleep with optional jitter. */
function sleep(ms: number, jitter: boolean): Promise<void> {
  const delay = jitter ? ms + Math.floor(Math.random() * ms * 0.3) : ms;
  return new Promise((r) => setTimeout(r, delay));
}

/**
 * Retry a function with exponential backoff.
 * Throws if all attempts fail (last error rethrown).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
  signal?: AbortSignal,
): Promise<T> {
  const config = { ...DEFAULT_RETRY, ...opts };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= config.maxAttempts || !isRetryable(err, config)) {
        throw err;
      }
      const delay = config.baseDelayMs * Math.pow(config.factor, attempt - 1);
      await sleep(delay, config.jitter);
    }
  }
  throw lastErr;
}
