// @littlesheep/llm — request-deadline.ts
//
// Our own deadline is not the caller's cancellation.
//
// Both interrupt the same fetch with the same `AbortError`. Treating them alike meant a
// Provider that hung past `timeoutMs` was classified as `cancelled` and never retried — the
// opposite of "retry transport faults, honour cancellation" (measured in the real window with
// an injected hang). This module is the single place that keeps the two apart: it owns the
// timer, the chained caller signal, the cleanup, and the translation of a fired deadline into
// a retryable timeout.

import { LlmError } from './types.js';

export interface RequestDeadline {
  /** Signal to hand to `fetch`: fires on our deadline or on the caller's abort. */
  readonly signal: AbortSignal;
  /** Whether *our* deadline fired (the caller may have aborted first). */
  timedOut(): boolean;
  /** Clear the timer and detach the caller listener. Safe to call more than once. */
  cleanup(): void;
  /**
   * Translate a caught error: a deadline that fired becomes a retryable `408`, while a caller
   * abort is returned untouched so it stays `cancelled` and is never replayed.
   */
  translate(error: unknown): unknown;
}

export function createRequestDeadline(timeoutMs: number, callerSignal?: AbortSignal): RequestDeadline {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  let cleaned = false;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => fired,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
    translate: (error: unknown) => {
      if (!fired || callerSignal?.aborted) return error;
      return new LlmError(408, `Request timed out after ${timeoutMs}ms`, true);
    },
  };
}
