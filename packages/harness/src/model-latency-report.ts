// Redacted model-request timing and outcome accounting for CACHE-09/10.
// Only durable event-envelope timestamps and terminal statuses enter this
// summary; prompt, tool, provider payload and evidence content never do.

import type { DurableModelRequestProjection } from '@littlesheep/types';

export interface ModelRequestLatencySummary {
  readonly version: 1;
  readonly requestCount: number;
  readonly completedCount: number;
  readonly unavailableCount: number;
  readonly receivedCount: number;
  readonly pendingCount: number;
  readonly abortedCount: number;
  readonly failureCount: number;
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly maxMs?: number;
}

/** Nearest-rank latency summary over one bounded request projection set. */
export function summarizeModelRequestLatency(
  requests: readonly DurableModelRequestProjection[],
): ModelRequestLatencySummary {
  const durations: number[] = [];
  let unavailableCount = 0;
  let receivedCount = 0;
  let pendingCount = 0;
  let abortedCount = 0;
  let failureCount = 0;

  for (const request of requests) {
    if (request.status === 'received') receivedCount += 1;
    else if (request.status === 'started') pendingCount += 1;
    else if (request.status === 'aborted') abortedCount += 1;
    else failureCount += 1;

    const duration = requestDurationMs(request);
    if (duration === undefined) unavailableCount += 1;
    else durations.push(duration);
  }

  durations.sort((left, right) => left - right);
  return Object.freeze({
    version: 1 as const,
    requestCount: requests.length,
    completedCount: durations.length,
    unavailableCount,
    receivedCount,
    pendingCount,
    abortedCount,
    failureCount,
    ...(durations.length === 0
      ? {}
      : {
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
          maxMs: durations.at(-1)!,
        }),
  });
}

function requestDurationMs(request: DurableModelRequestProjection): number | undefined {
  const startedAt = parseTime(request.startedAt);
  const endedAt = parseTime(request.settledAt ?? request.respondedAt);
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return undefined;
  return endedAt - startedAt;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}
