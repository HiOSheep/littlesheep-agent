// The deadline helper exists because "our timeout fired" and "the caller cancelled" are the
// same `AbortError` at the fetch boundary. These tests pin the three cases that matter: the
// deadline turns into a retryable timeout, a caller abort does not, and a caller abort that
// arrives first wins even if the timer fires later.
import { describe, expect, it } from 'vitest';
import { createRequestDeadline } from './request-deadline.js';
import { LlmError } from './types.js';

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

describe('request deadline', () => {
  it('translates its own fired deadline into a retryable timeout', async () => {
    const deadline = createRequestDeadline(5);
    expect(deadline.timedOut()).toBe(false);

    await new Promise((resolve) => deadline.signal.addEventListener('abort', resolve, { once: true }));

    expect(deadline.timedOut()).toBe(true);
    const translated = deadline.translate(abortError());
    expect(translated).toBeInstanceOf(LlmError);
    expect(translated).toMatchObject({ status: 408, retryable: true });
    expect((translated as LlmError).message).toContain('Request timed out after 5ms');
    deadline.cleanup();
  });

  it('leaves a caller abort as an abort, even when the timer fires afterwards', () => {
    const controller = new AbortController();
    const deadline = createRequestDeadline(60_000, controller.signal);
    controller.abort();

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(false);
    expect(deadline.translate(abortError())).toMatchObject({ name: 'AbortError' });
    deadline.cleanup();
  });

  it('does not claim a timeout when the caller aborted before the deadline', () => {
    const controller = new AbortController();
    const deadline = createRequestDeadline(60_000, controller.signal);
    controller.abort();

    // Even if a later call asked for the translation, a cancelled caller is not a timeout.
    expect(deadline.translate(abortError())).not.toBeInstanceOf(LlmError);
    deadline.cleanup();
  });

  it('cleans up once and stops the timer from firing', async () => {
    const controller = new AbortController();
    const deadline = createRequestDeadline(5, controller.signal);
    deadline.cleanup();
    deadline.cleanup();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deadline.timedOut()).toBe(false);
    expect(deadline.signal.aborted).toBe(false);
    // A detached caller listener must not keep aborting the (already cleaned) request.
    controller.abort();
    expect(deadline.timedOut()).toBe(false);
  });
});
