// Monotonic timing helpers for one physical Provider transport attempt.
import type { ChatResponse, ChatTransportMetrics } from './types.js';

export interface TransportTiming {
  attempt: number;
  startedAtMs: number;
  firstSignalAtMs?: number;
  firstContentAtMs?: number;
  firstReasoningAtMs?: number;
  firstToolArgumentsAtMs?: number;
}

export function attachTransportUsage(
  response: ChatResponse,
  managed: TransportTiming,
  observedAttemptCount: number,
  logicalStartedAtMs: number,
): ChatResponse {
  const endedAtMs = monotonicNow();
  const sinceDispatch = (value: number) => Math.max(0, value - managed.startedAtMs);
  const transport: ChatTransportMetrics = {
    durationMs: sinceDispatch(endedAtMs),
    requestElapsedMs: Math.max(0, endedAtMs - logicalStartedAtMs),
    transportAttempt: managed.attempt,
    observedAttemptCount,
    ...(managed.firstSignalAtMs === undefined ? {} : { ttftMs: sinceDispatch(managed.firstSignalAtMs) }),
    ...(managed.firstContentAtMs === undefined ? {} : { contentTtftMs: sinceDispatch(managed.firstContentAtMs) }),
    ...(managed.firstReasoningAtMs === undefined ? {} : { reasoningTtftMs: sinceDispatch(managed.firstReasoningAtMs) }),
    ...(managed.firstToolArgumentsAtMs === undefined ? {} : { toolArgumentsTtftMs: sinceDispatch(managed.firstToolArgumentsAtMs) }),
  };
  return {
    ...response,
    transport,
    ...(response.usage ? { usage: {
      ...response.usage,
      ...transport,
    } } : {}),
  };
}

export function recordFirstStreamSignal(
  managed: TransportTiming,
  kind: 'content' | 'reasoning' | 'tool_arguments',
): void {
  const now = monotonicNow();
  managed.firstSignalAtMs ??= now;
  if (kind === 'content') managed.firstContentAtMs ??= now;
  else if (kind === 'reasoning') managed.firstReasoningAtMs ??= now;
  else managed.firstToolArgumentsAtMs ??= now;
}

export function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
