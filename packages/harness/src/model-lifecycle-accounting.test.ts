import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import type { DurableHarnessEvent, RunContext } from '@littlesheep/types';
import { reduceDurableRunProjection } from './durable-kernel.js';
import {
  flushModelRequestLifecycles,
  prepareModelRequest,
  recordModelRequestFailure,
  recordProviderUsage,
} from './model-observability.js';
import { makeCtx } from './tests/helpers.js';

function request(stream = true): ChatRequest {
  return {
    model: 'openai/gpt-test',
    messages: [
      {
        role: 'system',
        content: 'Stable policy v1\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun-specific state',
      },
      { role: 'user', content: 'bounded test input' },
    ],
    stream,
    temperature: 0,
    max_tokens: 200,
  };
}

function durableRecorder(ctx: RunContext): DurableHarnessEvent[] {
  const events: DurableHarnessEvent[] = [];
  ctx.appendDurableEvent = async (input) => {
    events.push({
      version: 1,
      eventId: input.eventId ?? `${ctx.runId}:event:${events.length + 1}`,
      idempotencyKey: input.idempotencyKey,
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      cursor: events.length + 1,
      type: input.type,
      source: input.source,
      occurredAt: input.occurredAt
        ?? new Date(Date.parse('2026-09-03T00:00:00.000Z') + events.length * 1_000).toISOString(),
      payload: input.payload,
    });
  };
  return events;
}

describe('model request lifecycle accounting', () => {
  it('persists cache fingerprints, Provider usage and reconciliation on the same request', async () => {
    const ctx = makeCtx();
    ctx.cacheObservationKey = 'model-lifecycle-fixture-key';
    const events = durableRecorder(ctx);
    await ctx.appendDurableEvent?.({
      type: 'run_accepted',
      source: 'runtime',
      eventId: `${ctx.runId}:accepted`,
      idempotencyKey: `${ctx.runId}:accepted`,
      payload: {},
    });

    const prepared = prepareModelRequest(ctx, 'reply', request(true));
    recordProviderUsage(ctx, prepared, {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedPromptTokens: 40,
      reasoningTokens: 3,
    });
    await flushModelRequestLifecycles(ctx);

    const projection = reduceDurableRunProjection(events);
    expect(projection.modelRequests).toHaveLength(1);
    expect(projection.modelRequests[0]).toMatchObject({
      requestId: ctx.modelRequests?.[0]?.id,
      stream: true,
      startedAt: '2026-09-03T00:00:01.000Z',
      respondedAt: '2026-09-03T00:00:02.000Z',
      settledAt: '2026-09-03T00:00:03.000Z',
      providerReachStatus: 'reached',
      transportStatus: 'completed',
      usageStatus: 'available',
      providerUsage: {
        promptTokens: 100,
        completionTokens: 10,
        cachedPromptTokens: 40,
        cacheStatus: 'partial',
        reconciliation: 'unavailable',
      },
    });
    expect(projection.modelRequests[0]?.cacheObservation?.stablePrefix.fingerprint)
      .toBe(ctx.modelRequests?.[0]?.cacheObservation?.stablePrefix.fingerprint);
    expect(projection.modelRequests[0]?.cacheObservation?.dynamicSuffix.fingerprint)
      .toBe(ctx.modelRequests?.[0]?.cacheObservation?.dynamicSuffix.fingerprint);
    expect(projection.pendingModelRequestIds).toEqual([]);

    const responseEvent = events.find((event) => event.type === 'model_response_received');
    expect(responseEvent?.payload).toMatchObject({
      providerReachStatus: 'reached',
      transportStatus: 'completed',
      promptTokens: 100,
      cachedPromptTokens: 40,
      reconciliation: 'unavailable',
    });
  });

  it.each([
    ['abort', new Error('request aborted'), 'aborted', 'not_reached', 'aborted'],
    ['timeout', new Error('provider timeout'), 'timeout', 'unknown', 'timeout'],
    ['rate limit', new Error('HTTP 429 rate limit'), 'rate_limit', 'reached', 'rate_limit'],
    ['connection reset', new Error('connection reset by peer'), 'connection_reset', 'unknown', 'connection_reset'],
    ['server error', new Error('HTTP 503 service unavailable'), 'failed', 'unknown', 'failed'],
  ] as const)('records %s without fabricating Provider usage', async (_label, failure, status, reach, transport) => {
    const ctx = makeCtx();
    ctx.cacheObservationKey = 'model-lifecycle-failure-key';
    const events = durableRecorder(ctx);
    await ctx.appendDurableEvent?.({
      type: 'run_accepted',
      source: 'runtime',
      eventId: `${ctx.runId}:accepted`,
      idempotencyKey: `${ctx.runId}:accepted`,
      payload: {},
    });
    const prepared = prepareModelRequest(ctx, 'reply', request(false));
    await recordModelRequestFailure(ctx, prepared, failure);
    await flushModelRequestLifecycles(ctx);

    const projection = reduceDurableRunProjection(events);
    expect(projection.modelRequests[0]).toMatchObject({
      status,
      providerReachStatus: reach,
      transportStatus: transport,
      usageStatus: 'unavailable',
    });
    expect(projection.modelRequests[0]?.providerUsage).toBeUndefined();
    expect(events.find((event) => event.type === 'model_response_received')).toBeUndefined();
  });

  it('keeps missing Provider usage unavailable instead of using a local estimate', async () => {
    const ctx = makeCtx();
    ctx.cacheObservationKey = 'model-lifecycle-missing-usage-key';
    const events = durableRecorder(ctx);
    await ctx.appendDurableEvent?.({
      type: 'run_accepted',
      source: 'runtime',
      eventId: `${ctx.runId}:accepted`,
      idempotencyKey: `${ctx.runId}:accepted`,
      payload: {},
    });
    const prepared = prepareModelRequest(ctx, 'reply', request(true));
    recordProviderUsage(ctx, prepared, undefined);
    await flushModelRequestLifecycles(ctx);

    const projection = reduceDurableRunProjection(events);
    expect(projection.modelRequests[0]).toMatchObject({
      usageStatus: 'unavailable',
      providerReachStatus: 'reached',
      transportStatus: 'completed',
    });
    expect(projection.modelRequests[0]?.providerUsage).toBeUndefined();
    expect(projection.modelRequests[0]?.cacheObservation?.providerPrompt).toMatchObject({
      status: 'unavailable',
      reason: 'provider_usage_missing',
    });
  });

  it('does not reject a request when cache persistence and its warning logger both fail', async () => {
    const ctx = makeCtx({ toolContext: { log: () => { throw new Error('logger unavailable'); } } });
    ctx.cacheObservationKey = 'model-lifecycle-logger-failure-key';
    ctx.persistCacheObservation = async () => { throw new Error('cache store unavailable'); };
    const events = durableRecorder(ctx);
    await ctx.appendDurableEvent?.({
      type: 'run_accepted',
      source: 'runtime',
      eventId: `${ctx.runId}:accepted`,
      idempotencyKey: `${ctx.runId}:accepted`,
      payload: {},
    });

    const prepared = prepareModelRequest(ctx, 'reply', request(false));
    recordProviderUsage(ctx, prepared, {
      promptTokens: 20,
      completionTokens: 2,
      totalTokens: 22,
      cachedPromptTokens: 10,
    });
    await expect(flushModelRequestLifecycles(ctx)).resolves.toBeUndefined();
    expect(events.some((event) => event.type === 'model_request_settled')).toBe(true);
  });
});
