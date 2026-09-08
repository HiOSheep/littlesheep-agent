import { describe, expect, it } from 'vitest';
import type { DurableModelRequestProjection } from '@littlesheep/types';
import { summarizeModelRequestLatency } from './model-latency-report.js';

function request(
  requestId: string,
  startedAt: string | undefined,
  endedAt: string | undefined,
  status: DurableModelRequestProjection['status'] = 'received',
): DurableModelRequestProjection {
  return {
    requestId,
    status,
    startedEventId: `${requestId}:started`,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { respondedAt: endedAt, settledAt: endedAt } : {}),
  };
}

describe('model request latency summary', () => {
  it('computes nearest-rank p50/p95/max from durable event times', () => {
    expect(summarizeModelRequestLatency([
      request('r1', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.100Z'),
      request('r2', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.200Z'),
      request('r3', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.300Z'),
      request('r4', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.400Z'),
      request('r5', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:01.000Z'),
    ])).toEqual({
      version: 1,
      requestCount: 5,
      completedCount: 5,
      unavailableCount: 0,
      receivedCount: 5,
      pendingCount: 0,
      abortedCount: 0,
      failureCount: 0,
      p50Ms: 300,
      p95Ms: 1_000,
      maxMs: 1_000,
    });
  });

  it('uses respondedAt when settlement is not yet durable', () => {
    expect(summarizeModelRequestLatency([{
      requestId: 'pending-response',
      status: 'received',
      startedEventId: 'started',
      startedAt: '2026-09-09T00:00:00.000Z',
      respondedAt: '2026-09-09T00:00:00.250Z',
    }])).toMatchObject({
      completedCount: 1,
      unavailableCount: 0,
      p50Ms: 250,
      p95Ms: 250,
      maxMs: 250,
    });
  });

  it('counts missing, invalid and negative durations as unavailable', () => {
    expect(summarizeModelRequestLatency([
      { requestId: 'no-times', status: 'started', startedEventId: 'started' },
      request('invalid-start', 'not-a-time', '2026-09-09T00:00:01.000Z'),
      request('negative', '2026-09-09T00:00:01.000Z', '2026-09-09T00:00:00.000Z'),
      request('valid', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.100Z'),
    ])).toEqual({
      version: 1,
      requestCount: 4,
      completedCount: 1,
      unavailableCount: 3,
      receivedCount: 3,
      pendingCount: 1,
      abortedCount: 0,
      failureCount: 0,
      p50Ms: 100,
      p95Ms: 100,
      maxMs: 100,
    });
  });

  it('reports abort and failure counts without inventing percentiles', () => {
    expect(summarizeModelRequestLatency([
      request('aborted', undefined, undefined, 'aborted'),
      request('timeout', undefined, undefined, 'timeout'),
      request('rate-limit', undefined, undefined, 'rate_limit'),
      request('missing', undefined, undefined, 'missing'),
      request('failed', undefined, undefined, 'failed'),
      request('connection', undefined, undefined, 'connection_reset'),
    ])).toEqual({
      version: 1,
      requestCount: 6,
      completedCount: 0,
      unavailableCount: 6,
      receivedCount: 0,
      pendingCount: 0,
      abortedCount: 1,
      failureCount: 5,
    });
  });

  it('returns a zeroed summary for an empty set', () => {
    expect(summarizeModelRequestLatency([])).toEqual({
      version: 1,
      requestCount: 0,
      completedCount: 0,
      unavailableCount: 0,
      receivedCount: 0,
      pendingCount: 0,
      abortedCount: 0,
      failureCount: 0,
    });
  });
});
