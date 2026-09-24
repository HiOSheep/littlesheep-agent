// @littlesheep/llm — retry policy tests (UX-21).
//
// The product expectation is "the first request, then at most five retries": every test below
// keeps delays at 1-5 ms and jitter off so the policy, not the clock, is what is asserted.
import { describe, expect, it, vi } from 'vitest';
import {
  classifyFailure,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY,
  isRetryable,
  maxRetriesOf,
  retryAfterHintMs,
  retryDelayMs,
  retryWithBackoff,
  type RetryProgress,
} from './retry.js';
import { LlmError } from './types.js';

/** A retryable provider failure. */
const transient = (status = 503) => new LlmError(status, `HTTP ${status}`, true);

function fastRetry(extra: Partial<Parameters<typeof retryWithBackoff>[1]> = {}) {
  return { baseDelayMs: 1, factor: 1, jitter: false, ...extra };
}

describe('retry policy defaults', () => {
  it('allows the first request plus five retries', async () => {
    let calls = 0;
    const progress: RetryProgress[] = [];
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw transient();
        },
        fastRetry({ onRetry: (info) => progress.push(info) }),
      ),
    ).rejects.toThrow('HTTP 503');
    expect(DEFAULT_RETRY.maxAttempts).toBe(DEFAULT_MAX_RETRIES + 1);
    expect(maxRetriesOf()).toBe(5);
    expect(calls).toBe(6);
    expect(progress.map((entry) => entry.retry)).toEqual([1, 2, 3, 4, 5]);
    expect(progress.every((entry) => entry.maxRetries === 5)).toBe(true);
    expect(progress.every((entry) => entry.failureClass === 'transient')).toBe(true);
  });

  it('reports the retry number that is about to happen, not the failed attempt', async () => {
    const progress: RetryProgress[] = [];
    let calls = 0;
    const value = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw transient();
        return 'ok';
      },
      fastRetry({ onRetry: (info) => progress.push(info) }),
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(progress.map((entry) => entry.retry)).toEqual([1, 2]);
  });

  it('accepts maxRetries as the retry count', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls += 1; throw transient(); }, { maxRetries: 2, baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow();
    expect(calls).toBe(3);
    expect(maxRetriesOf({ maxRetries: 2 })).toBe(2);
    expect(maxRetriesOf({ maxAttempts: 1 })).toBe(0);
  });
});

describe('retry classification', () => {
  it('never replays auth, request, cancelled or unknown failures', async () => {
    const cases: Array<[string, unknown]> = [
      ['auth', new LlmError(401, 'unauthorized', false)],
      ['auth', new LlmError(403, 'forbidden', false)],
      ['request', new LlmError(400, 'bad payload', false)],
      ['request', new LlmError(422, 'unprocessable', false)],
      ['cancelled', Object.assign(new Error('aborted'), { name: 'AbortError' })],
      ['unknown', new Error('weird')],
    ];
    for (const [expected, error] of cases) {
      expect(classifyFailure(error)).toBe(expected);
      expect(isRetryable(error)).toBe(false);
      let calls = 0;
      await expect(
        retryWithBackoff(async () => { calls += 1; throw error; }, fastRetry()),
      ).rejects.toBe(error);
      expect(calls, `${expected} must not be retried`).toBe(1);
    }
  });

  it('replays rate limits and transient transport/provider failures', () => {
    expect(classifyFailure(new LlmError(429, 'slow down', true))).toBe('rate_limited');
    expect(classifyFailure(new LlmError(503, 'unavailable', true))).toBe('transient');
    expect(classifyFailure(new LlmError(408, 'timeout', false))).toBe('transient');
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('transient');
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable({ retryable: true })).toBe(true);
    expect(isRetryable({ retryable: false })).toBe(false);
  });
});

describe('retry timing', () => {
  it('uses exponential backoff and caps a single wait', () => {
    const opts = { ...DEFAULT_RETRY, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 };
    expect(retryDelayMs(1, opts)).toBe(100);
    expect(retryDelayMs(2, opts)).toBe(200);
    expect(retryDelayMs(3, opts)).toBe(400);
    expect(retryDelayMs(9, opts)).toBe(1_000);
  });

  it('raises the wait to a provider Retry-After hint but keeps the ceiling', () => {
    const opts = { ...DEFAULT_RETRY, baseDelayMs: 100, factor: 2, maxDelayMs: 5_000 };
    expect(retryDelayMs(1, opts, 900)).toBe(900);
    expect(retryDelayMs(1, opts, 50)).toBe(100);
    expect(retryDelayMs(1, opts, 60_000)).toBe(5_000);
    expect(retryAfterHintMs(new LlmError(429, 'slow down', true, 1_500))).toBe(1_500);
    expect(retryAfterHintMs(new Error('nope'))).toBeUndefined();
  });

  it('publishes the planned wait and honours a hint end to end', async () => {
    const progress: RetryProgress[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls === 1) throw new LlmError(429, 'slow down', true, 40);
        return 'ok';
      },
      fastRetry({ baseDelayMs: 1, onRetry: (info) => progress.push(info) }),
    );
    expect(calls).toBe(2);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ retry: 1, failureClass: 'rate_limited', status: 429, delayMs: 40 });
  });
});

describe('cancellation', () => {
  it('does not start an attempt when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'never');
    await expect(retryWithBackoff(fn, fastRetry(), controller.signal)).rejects.toThrow('Aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops waiting during backoff instead of sleeping out the delay', async () => {
    const controller = new AbortController();
    let calls = 0;
    const startedAt = Date.now();
    const promise = retryWithBackoff(
      async () => {
        calls += 1;
        throw transient();
      },
      { baseDelayMs: 5_000, factor: 1, jitter: false },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow('Aborted');
    expect(calls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
